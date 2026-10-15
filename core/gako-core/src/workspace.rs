// Gako: a workspace app for reviewing and supervising coding agents across many repositories.
// Copyright (C) 2026 João Sena Ribeiro
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU Affero General Public License as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.

//! A workspace: a base folder, the repos found in it, and their live status.
//!
//! Each repo is refreshed when its files change: at most one `git status` per repo at a time, and
//! a change during a refresh queues exactly one more. Status changes are pushed to the frontend as
//! `{"t":"repoStatus"}` events; a refresh that found the same status (files may still have changed)
//! as `{"t":"repoTouched"}`; the repo list as `{"t":"repos"}`; the end of the first full scan as
//! `{"t":"scanDone"}`; folders whose contents changed as `{"t":"filesChanged"}`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::git::{self, Git, Repo, RepoKind, watch};
use crate::pty::Event;
use crate::settings::Settings;

/// The least time between the start of a status scan and the start of the next one for the same
/// repo, when files changed in between.
const MIN_RESCAN_GAP: Duration = Duration::from_millis(500);
/// The most one status scan may take, waiting for a slot included. `git` has its own, shorter
/// timeout; this one makes sure that nothing else in a scan can leave it hanging for good.
const SCAN_LIMIT: Duration = Duration::from_secs(5 * 60);
/// A scan loop that hasn't started an iteration for this long is taken for lost: the next refresh
/// replaces it (the old one stops if it ever wakes up), so a repo can't be stuck "scanning" with
/// its last error on show.
const STALE_SCAN: Duration = Duration::from_secs(10 * 60);

/// Numbers the scan loops. It is shared by all repos and never reused, so a repo that drops out and
/// comes back (with a fresh `RepoState`) can't match the number of a loop from before.
static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// How long to wait before scanning a repo again after its `failures`-th failure in a row:
/// 10, 20, 40, 80 and then 160 seconds.
fn retry_wait(failures: u32) -> Duration {
    Duration::from_secs(5 << failures.clamp(1, 5))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// The repo's id in every message: its root path.
    pub root: String,
    /// The root relative to the base folder ("" for the base repo itself).
    pub rel: String,
    pub kind: RepoKind,
}

#[derive(Default)]
struct RepoState {
    /// When the scan loop last started an iteration; `None` when none is running.
    running_since: Option<Instant>,
    /// Which scan loop owns the repo (see `NEXT_GENERATION`): a loop that finds it changed has been
    /// replaced and stops.
    generation: u64,
    dirty: bool,
    last: Option<Value>,
}

struct Inner {
    /// The current search, so a new one (or a cancel) can stop it.
    search: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Every file in the workspace, for go-to-file; rebuilt after files change.
    files: Option<Arc<Vec<PathBuf>>>,
    /// The symbol index, once built.
    symbols: Option<Arc<std::sync::RwLock<crate::symbols::Index>>>,
    repos: Vec<Repo>,
    states: Vec<RepoState>,
    watcher: Option<watch::Watcher>,
}

pub struct Workspace {
    pub base: PathBuf,
    pub settings: Settings,
    pub git: Git,
    tx: UnboundedSender<Event>,
    inner: Mutex<Inner>,
    /// Held while repos are discovered again, so two rediscoveries never overwrite each other.
    rediscovering: Mutex<()>,
    /// Held while the symbol index is brought up to date, so the update never waits for another.
    indexing: Mutex<()>,
}

impl Workspace {
    pub fn open(
        base: PathBuf,
        settings: Settings,
        tx: UnboundedSender<Event>,
    ) -> Result<Arc<Workspace>> {
        if !base.is_dir() {
            bail!("{} is not a folder", base.display());
        }
        let base = crate::files::canonical(&base)?;
        let git = Git::new(
            settings.max_git_processes,
            Duration::from_secs(settings.git_timeout_secs),
        );
        let ws = Arc::new(Workspace {
            base,
            settings,
            git,
            tx,
            inner: Mutex::new(Inner {
                search: None,
                files: None,
                symbols: None,
                repos: Vec::new(),
                states: Vec::new(),
                watcher: None,
            }),
            rediscovering: Mutex::new(()),
            indexing: Mutex::new(()),
        });
        ws.rediscover(true)?;
        ws.clone().build_index();
        Ok(ws)
    }

    /// The base folder and any extra folders: everything the workspace may read.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.base.clone()];
        for extra in &self.settings.extra_folders {
            let p = if extra.is_absolute() {
                extra.clone()
            } else {
                self.base.join(extra)
            };
            if let Ok(p) = crate::files::canonical(&p)
                && !roots.iter().any(|r| p.starts_with(r))
            {
                roots.push(p);
            }
        }
        roots
    }

    pub fn repos(&self) -> Vec<RepoInfo> {
        self.inner
            .lock()
            .unwrap()
            .repos
            .iter()
            .map(|r| self.info(r))
            .collect()
    }

    fn info(&self, r: &Repo) -> RepoInfo {
        let rel = r
            .root
            .strip_prefix(&self.base)
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        RepoInfo {
            root: r.root.to_string_lossy().into_owned(),
            rel: rel.unwrap_or_else(|_| r.root.to_string_lossy().into_owned()),
            kind: r.kind,
        }
    }

    /// The repo with this root, if it's part of the workspace. Every git request goes through this,
    /// so the core never runs git anywhere else.
    pub fn repo(&self, root: &str) -> Result<Repo> {
        let inner = self.inner.lock().unwrap();
        match inner.repos.iter().find(|r| r.root.as_os_str() == root) {
            Some(r) => Ok(r.clone()),
            None => bail!("not a repo in this workspace: {root}"),
        }
    }

    /// Finds repos again, restarts the watcher, and refreshes repos that are new.
    fn rediscover(self: &Arc<Self>, first: bool) -> Result<()> {
        let _only_one = self.rediscovering.lock().unwrap();
        let roots = self.roots();
        let repos =
            git::discover::discover(&roots, self.settings.scan_depth, &self.settings.scan_ignore);
        let mut watched = roots.clone();
        for r in &repos {
            if !roots.iter().any(|root| r.git_dir.starts_with(root)) {
                watched.push(r.git_dir.clone());
            }
        }
        let (tx, mut rx) = unbounded_channel::<Vec<PathBuf>>();
        let watcher = watch::watch(
            &watched,
            Duration::from_millis(self.settings.debounce_ms),
            tx,
        )?;
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(paths) = rx.recv().await {
                let Some(ws) = weak.upgrade() else { break };
                ws.changed(&paths);
            }
        });

        let new: Vec<Repo> = {
            let mut inner = self.inner.lock().unwrap();
            let inner = &mut *inner;
            let mut old: Vec<(Repo, RepoState)> =
                inner.repos.drain(..).zip(inner.states.drain(..)).collect();
            let mut new = Vec::new();
            for r in repos {
                match old.iter().position(|(o, _)| o.root == r.root) {
                    Some(i) => {
                        let (_, st) = old.swap_remove(i);
                        inner.repos.push(r);
                        inner.states.push(st);
                    }
                    None => {
                        new.push(r.clone());
                        inner.repos.push(r);
                        inner.states.push(RepoState::default());
                    }
                }
            }
            inner.watcher = Some(watcher); // dropping the old one stops it
            new
        };
        if !first {
            self.send(json!({"t": "repos", "repos": self.repos()}));
        }
        let started = Instant::now();
        let count = new.len();
        let remaining = Arc::new(std::sync::atomic::AtomicUsize::new(count));
        if new.is_empty() && first {
            self.send(json!({"t": "scanDone", "ms": 0, "repos": 0}));
        }
        for r in new {
            let ws = self.clone();
            let remaining = remaining.clone();
            tokio::spawn(async move {
                ws.refresh(&r.root).await;
                if remaining.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 && first {
                    let ms = started.elapsed().as_secs_f64() * 1000.0;
                    ws.send(json!({"t": "scanDone", "ms": ms, "repos": count}));
                }
            });
        }
        Ok(())
    }

    /// Whether a path lies in a folder the scan ignores (`node_modules` by default). Builds and
    /// installs write thousands of files there, none of which is a change to look at.
    /// `roots` is `self.roots()`, taken once by the caller: it canonicalizes the extra folders.
    fn in_ignored_folder(&self, roots: &[PathBuf], path: &Path) -> bool {
        // Relative to the root it lies in (the base or an extra folder), as discovery does.
        let Some(rel) = roots
            .iter()
            .find_map(|r| path.strip_prefix(r).ok().map(Path::to_path_buf))
        else {
            return false;
        };
        rel.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            self.settings.scan_ignore.iter().any(|s| *s == name)
        })
    }

    fn changed(self: &Arc<Self>, all_paths: &[PathBuf]) {
        // The explorer still hears about every folder (one may be open); the rest of the work,
        // which costs a status scan and an index update, skips the ignored ones.
        let listed: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            let mut v: Vec<String> = Vec::new();
            let inner = self.inner.lock().unwrap();
            for p in all_paths {
                if inner.repos.iter().any(|r| p.starts_with(&r.git_dir)) {
                    continue;
                }
                if let Some(parent) = p.parent() {
                    let d = parent.to_string_lossy().into_owned();
                    if seen.insert(d.clone()) {
                        v.push(d);
                    }
                }
            }
            v
        };
        let roots = self.roots();
        let paths: Vec<PathBuf> = all_paths
            .iter()
            .filter(|p| !self.in_ignored_folder(&roots, p))
            .cloned()
            .collect();
        let paths = &paths[..];
        // Folders whose listing may have changed, for the file explorer (git dirs aside), minus
        // the ignored ones: those are `listed` folders that also hold a path that is kept.
        let dirs: Vec<String> = {
            let kept: std::collections::HashSet<String> = paths
                .iter()
                .filter_map(|p| p.parent())
                .map(|d| d.to_string_lossy().into_owned())
                .collect();
            listed
                .iter()
                .filter(|d| kept.contains(*d))
                .cloned()
                .collect()
        };
        if !listed.is_empty() {
            // Cheap, so it covers every folder: the list is rebuilt when next asked for.
            self.inner.lock().unwrap().files = None;
            self.send(json!({"t": "filesChanged", "dirs": listed}));
        }
        if !dirs.is_empty() {
            self.update_index(dirs.iter().map(PathBuf::from).collect());
        }
        let (changes, roots) = {
            let inner = self.inner.lock().unwrap();
            let c = watch::classify(&inner.repos, paths);
            let roots: Vec<PathBuf> = c
                .repos
                .iter()
                .map(|&i| inner.repos[i].root.clone())
                .collect();
            (c, roots)
        };
        if std::env::var_os("GAKO_DEBUG_WATCH").is_some() {
            eprintln!(
                "watch: {} paths -> {} repos {:?}, rediscover {}",
                paths.len(),
                roots.len(),
                roots.iter().map(|r| r.file_name()).collect::<Vec<_>>(),
                changes.rediscover
            );
        }
        if changes.rediscover {
            // Walking the folders and starting a new watcher take a while on a big workspace:
            // not on an async worker. New repos are refreshed by the rediscovery itself.
            let ws = self.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = ws.rediscover(false) {
                    eprintln!("gako-core: rediscovering repos: {e:#}");
                }
            });
        }
        for root in roots {
            let ws = self.clone();
            tokio::spawn(async move { ws.refresh(&root).await });
        }
    }

    /// Refreshes one repo's status; pushes it if it changed. If a refresh is already running, it
    /// runs once more when that one ends.
    pub async fn refresh(self: &Arc<Self>, root: &Path) {
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            let Some(i) = inner.repos.iter().position(|r| r.root == root) else {
                return;
            };
            match inner.states[i].running_since {
                Some(since) if since.elapsed() < STALE_SCAN => {
                    inner.states[i].dirty = true;
                    if std::env::var_os("GAKO_DEBUG_WATCH").is_some() {
                        eprintln!("refresh: {} already running, queued", root.display());
                    }
                    return;
                }
                Some(since) => eprintln!(
                    "gako-core: the status scan of {} made no progress for {:?}; starting another",
                    root.display(),
                    since.elapsed()
                ),
                None => {}
            }
            inner.states[i].running_since = Some(Instant::now());
            let generation = NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            inner.states[i].generation = generation;
            generation
        };
        let mut failures = 0u32;
        loop {
            let (repo, nested) = {
                let inner = self.inner.lock().unwrap();
                let Some(repo) = inner.repos.iter().find(|r| r.root == root).cloned() else {
                    return;
                };
                let nested: Vec<PathBuf> = inner
                    .repos
                    .iter()
                    .filter(|r| r.root != root && r.root.starts_with(root))
                    .map(|r| r.root.clone())
                    .collect();
                (repo, nested)
            };
            let started = Instant::now();
            {
                let mut inner = self.inner.lock().unwrap();
                match inner.repos.iter().position(|r| r.root == root) {
                    Some(i) if inner.states[i].generation == generation => {
                        inner.states[i].running_since = Some(started);
                    }
                    _ => return,
                }
            }
            let (result, ran) = match tokio::time::timeout(
                SCAN_LIMIT,
                git::status(&self.git, &repo, &nested, self.settings.untracked_limit),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => (
                    Err(git::TimedOut::new(&["status"], SCAN_LIMIT).into()),
                    None,
                ),
            };
            // The backoff follows git's own time, not the wait for a permit: when many repos
            // change at once, queueing says nothing about how costly this one is.
            let took = ran.unwrap_or_else(|| started.elapsed());
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let value = match result {
                Ok(st) => json!({"status": st}),
                Err(e) => {
                    eprintln!("gako-core: status of {}: {e:#}", root.display());
                    let mut message = git::friendly(&e);
                    if e.is::<git::TimedOut>() {
                        message.push_str(" Gako will try again shortly.");
                    }
                    json!({"error": message})
                }
            };
            let failed = value.get("error").is_some();
            let changed = {
                let mut inner = self.inner.lock().unwrap();
                let Some(i) = inner.repos.iter().position(|r| r.root == root) else {
                    return;
                };
                if inner.states[i].generation != generation {
                    return;
                }
                let changed = inner.states[i].last.as_ref() != Some(&value);
                inner.states[i].last = Some(value.clone());
                changed
            };
            let repo_id = root.to_string_lossy().into_owned();
            if changed {
                let mut msg = value;
                msg["t"] = "repoStatus".into();
                msg["repo"] = repo_id.into();
                msg["ms"] = ms.into();
                self.send(msg);
            } else {
                // Same status, but files may still have changed (a modified file edited again):
                // an open diff in this repo has to re-read its file.
                self.send(json!({"t": "repoTouched", "repo": repo_id}));
            }
            failures = if failed {
                failures.saturating_add(1)
            } else {
                0
            };
            {
                let mut inner = self.inner.lock().unwrap();
                let Some(i) = inner.repos.iter().position(|r| r.root == root) else {
                    return;
                };
                if inner.states[i].generation != generation {
                    return;
                }
                if failed {
                    // Nothing may change in the repo to trigger another scan, and the error
                    // would stay up for good: try again, further apart each time.
                    inner.states[i].dirty = true;
                } else if !inner.states[i].dirty {
                    inner.states[i].running_since = None;
                    return;
                }
            }
            if failed {
                tokio::time::sleep(retry_wait(failures)).await;
                continue;
            }
            // Files kept changing during the scan (a build, an install, an agent writing). The
            // next scan waits so that scans take up a third of the time at most: the status is a
            // moment late while it churns, and a slow repo doesn't keep git busy. Changes during
            // the wait are covered by that scan.
            tokio::time::sleep((took * 2).max(MIN_RESCAN_GAP.saturating_sub(took))).await;
            let mut inner = self.inner.lock().unwrap();
            let Some(i) = inner.repos.iter().position(|r| r.root == root) else {
                return;
            };
            if inner.states[i].generation != generation {
                return;
            }
            inner.states[i].dirty = false;
        }
    }

    /// A search scope: every repo and folder (`all`), or chosen repos (`repos`).
    /// Repos inside a searched folder are skipped there: they're searched as themselves, or not at all.
    pub fn scope(&self, kind: &str, chosen: &[String]) -> crate::search::Scope {
        let repos: Vec<PathBuf> = self
            .inner
            .lock()
            .unwrap()
            .repos
            .iter()
            .map(|r| r.root.clone())
            .collect();
        let roots: Vec<PathBuf> = match kind {
            "repos" => repos
                .iter()
                .filter(|r| chosen.iter().any(|c| r.as_os_str() == c.as_str()))
                .cloned()
                .collect(),
            _ => {
                let mut v = self.roots();
                let more: Vec<PathBuf> = repos.iter().filter(|r| !v.contains(r)).cloned().collect();
                v.extend(more);
                v
            }
        };
        let skip = repos.into_iter().filter(|r| !roots.contains(r)).collect();
        crate::search::Scope { roots, skip }
    }

    /// Starts tracking a new search, stopping the previous one.
    pub fn begin_search(&self) -> Arc<std::sync::atomic::AtomicBool> {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Some(old) = self.inner.lock().unwrap().search.replace(flag.clone()) {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        flag
    }

    pub fn cancel_search(&self) {
        if let Some(f) = self.inner.lock().unwrap().search.take() {
            f.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Every file in the workspace (cached until files change).
    pub async fn files(&self) -> Arc<Vec<PathBuf>> {
        if let Some(f) = self.inner.lock().unwrap().files.clone() {
            return f;
        }
        let scope = self.scope("all", &[]);
        let files = Arc::new(
            tokio::task::spawn_blocking(move || crate::search::list_files(&scope))
                .await
                .unwrap_or_default(),
        );
        self.inner.lock().unwrap().files = Some(files.clone());
        files
    }

    /// Builds the symbol index in the background and announces it with `{"t":"indexReady"}`.
    fn build_index(self: Arc<Self>) {
        tokio::spawn(async move {
            let started = Instant::now();
            let files = self.files().await;
            let Ok(index) =
                tokio::task::spawn_blocking(move || crate::symbols::Index::build(&files)).await
            else {
                return;
            };
            let (files, symbols) = index.counts();
            self.inner.lock().unwrap().symbols = Some(Arc::new(std::sync::RwLock::new(index)));
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            self.send(json!({"t": "indexReady", "files": files, "symbols": symbols, "ms": ms}));
        });
    }

    /// Re-parses changed files in `dirs` (only those the ignore rules keep).
    fn update_index(self: &Arc<Self>, dirs: Vec<PathBuf>) {
        let Some(index) = self.inner.lock().unwrap().symbols.clone() else {
            return;
        };
        let ws = self.clone();
        tokio::task::spawn_blocking(move || {
            let _only_one = ws.indexing.lock().unwrap();
            let mut keep = std::collections::HashSet::new();
            for d in &dirs {
                if let Ok(listing) = crate::files::list(d) {
                    keep.extend(
                        listing
                            .entries
                            .into_iter()
                            .filter(|e| !e.ignored)
                            .map(|e| e.path),
                    );
                }
            }
            // Reading and parsing happen under the read lock, which searches don't wait for; the
            // write lock is held only to swap the results in.
            let update = index.read().unwrap().prepare(&dirs, &|p| keep.contains(p));
            index.write().unwrap().apply(update);
        });
    }

    /// The symbol index, if it's been built.
    pub fn symbols(&self) -> Option<Arc<std::sync::RwLock<crate::symbols::Index>>> {
        self.inner.lock().unwrap().symbols.clone()
    }

    /// The repo a path belongs to (the innermost one).
    pub fn repo_of(&self, path: &Path) -> Option<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner
            .repos
            .iter()
            .filter(|r| path.starts_with(&r.root))
            .max_by_key(|r| r.root.components().count())
            .map(|r| r.root.clone())
    }

    pub fn emit(&self, msg: Value) {
        self.send(msg);
    }

    /// Every repo's last known status, for a frontend that connects (or reloads) after the scan.
    pub fn statuses(&self) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        inner
            .repos
            .iter()
            .zip(&inner.states)
            .filter_map(|(r, s)| {
                let mut v = s.last.clone()?;
                v["repo"] = r.root.to_string_lossy().into_owned().into();
                Some(v)
            })
            .collect()
    }

    fn send(&self, msg: Value) {
        let _ = self.tx.send(Event::Text(msg.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_back_off_up_to_160_seconds() {
        let secs: Vec<u64> = [1, 2, 3, 4, 5, 6, 1000, u32::MAX]
            .map(|n| retry_wait(n).as_secs())
            .into();
        assert_eq!(secs, [10, 20, 40, 80, 160, 160, 160, 160]);
    }

    /// Folders in `scanIgnore` are skipped under the base and under an extra folder alike.
    #[tokio::test(flavor = "multi_thread")]
    async fn ignored_folders_under_every_root() {
        let base = tempfile::tempdir().unwrap();
        let extra = tempfile::tempdir().unwrap();
        let settings = Settings {
            extra_folders: vec![extra.path().to_path_buf()],
            ..Settings::default()
        };
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let ws = Workspace::open(base.path().to_path_buf(), settings, tx).unwrap();
        let base = ws.base.clone();
        let extra = crate::files::canonical(extra.path()).unwrap();
        let roots = ws.roots();

        assert!(ws.in_ignored_folder(&roots, &base.join("app/node_modules/x/index.js")));
        assert!(ws.in_ignored_folder(&roots, &extra.join("lib/node_modules/y.js")));
        assert!(!ws.in_ignored_folder(&roots, &base.join("app/src/index.js")));
        assert!(!ws.in_ignored_folder(&roots, &extra.join("lib/src/y.js")));
        // Outside every root: not this workspace's business.
        assert!(!ws.in_ignored_folder(&roots, Path::new("/elsewhere/node_modules/z.js")));
    }
}
