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
    running: bool,
    dirty: bool,
    last: Option<Value>,
}

struct Inner {
    /// The current search, so a new one (or a cancel) can stop it.
    search: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Every file in the workspace, for go-to-file; rebuilt after files change.
    files: Option<Arc<Vec<PathBuf>>>,
    /// The symbol index, once built (phase 5).
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
}

impl Workspace {
    pub fn open(base: PathBuf, settings: Settings, tx: UnboundedSender<Event>) -> Result<Arc<Workspace>> {
        if !base.is_dir() {
            bail!("{} is not a folder", base.display());
        }
        let base = crate::files::canonical(&base)?;
        let git = Git::new(settings.max_git_processes, Duration::from_secs(settings.git_timeout_secs));
        let ws = Arc::new(Workspace {
            base,
            settings,
            git,
            tx,
            inner: Mutex::new(Inner { search: None, files: None, symbols: None, repos: Vec::new(), states: Vec::new(), watcher: None }),
        });
        ws.rediscover(true)?;
        ws.clone().build_index();
        Ok(ws)
    }

    /// The base folder and any extra folders: everything the workspace may read.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.base.clone()];
        for extra in &self.settings.extra_folders {
            let p = if extra.is_absolute() { extra.clone() } else { self.base.join(extra) };
            if let Ok(p) = crate::files::canonical(&p)
                && !roots.iter().any(|r| p.starts_with(r))
            {
                roots.push(p);
            }
        }
        roots
    }

    pub fn repos(&self) -> Vec<RepoInfo> {
        self.inner.lock().unwrap().repos.iter().map(|r| self.info(r)).collect()
    }

    fn info(&self, r: &Repo) -> RepoInfo {
        let rel = r.root.strip_prefix(&self.base).map(|p| p.to_string_lossy().replace('\\', "/"));
        RepoInfo { root: r.root.to_string_lossy().into_owned(), rel: rel.unwrap_or_else(|_| r.root.to_string_lossy().into_owned()), kind: r.kind }
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
        let roots = self.roots();
        let repos = git::discover::discover(&roots, self.settings.scan_depth, &self.settings.scan_ignore);
        let mut watched = roots.clone();
        for r in &repos {
            if !roots.iter().any(|root| r.git_dir.starts_with(root)) {
                watched.push(r.git_dir.clone());
            }
        }
        let (tx, mut rx) = unbounded_channel::<Vec<PathBuf>>();
        let watcher = watch::watch(&watched, Duration::from_millis(self.settings.debounce_ms), tx)?;
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
            let mut old: Vec<(Repo, RepoState)> = inner.repos.drain(..).zip(inner.states.drain(..)).collect();
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

    fn changed(self: &Arc<Self>, paths: &[PathBuf]) {
        // Folders whose listing may have changed, for the file explorer (git dirs aside).
        let mut dirs: Vec<String> = Vec::new();
        {
            let inner = self.inner.lock().unwrap();
            for p in paths {
                if inner.repos.iter().any(|r| p.starts_with(&r.git_dir)) {
                    continue;
                }
                if let Some(parent) = p.parent() {
                    let d = parent.to_string_lossy().into_owned();
                    if !dirs.contains(&d) {
                        dirs.push(d);
                    }
                }
            }
        }
        if !dirs.is_empty() {
            self.inner.lock().unwrap().files = None;
            self.send(json!({"t": "filesChanged", "dirs": dirs}));
            self.update_index(dirs.iter().map(PathBuf::from).collect());
        }
        let (changes, roots) = {
            let inner = self.inner.lock().unwrap();
            let c = watch::classify(&inner.repos, paths);
            let roots: Vec<PathBuf> = c.repos.iter().map(|&i| inner.repos[i].root.clone()).collect();
            (c, roots)
        };
        if std::env::var_os("GAKO_DEBUG_WATCH").is_some() {
            eprintln!("watch: {} paths -> {} repos {:?}, rediscover {}", paths.len(), roots.len(), roots.iter().map(|r| r.file_name()).collect::<Vec<_>>(), changes.rediscover);
        }
        if changes.rediscover
            && let Err(e) = self.rediscover(false)
        {
            eprintln!("gako-core: rediscovering repos: {e:#}");
        }
        for root in roots {
            let ws = self.clone();
            tokio::spawn(async move { ws.refresh(&root).await });
        }
    }

    /// Refreshes one repo's status; pushes it if it changed. If a refresh is already running, it
    /// runs once more when that one ends.
    pub async fn refresh(self: &Arc<Self>, root: &Path) {
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(i) = inner.repos.iter().position(|r| r.root == root) else { return };
            if inner.states[i].running {
                inner.states[i].dirty = true;
                if std::env::var_os("GAKO_DEBUG_WATCH").is_some() {
                    eprintln!("refresh: {} already running, queued", root.display());
                }
                return;
            }
            inner.states[i].running = true;
        }
        loop {
            let (repo, nested) = {
                let inner = self.inner.lock().unwrap();
                let Some(repo) = inner.repos.iter().find(|r| r.root == root).cloned() else { return };
                let nested: Vec<PathBuf> =
                    inner.repos.iter().filter(|r| r.root != root && r.root.starts_with(root)).map(|r| r.root.clone()).collect();
                (repo, nested)
            };
            let started = Instant::now();
            let result = git::status(&self.git, &repo, &nested, self.settings.untracked_limit).await;
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let value = match result {
                Ok(st) => json!({"status": st}),
                Err(e) => json!({"error": format!("{e:#}")}),
            };
            let changed = {
                let mut inner = self.inner.lock().unwrap();
                let Some(i) = inner.repos.iter().position(|r| r.root == root) else { return };
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
            let mut inner = self.inner.lock().unwrap();
            let Some(i) = inner.repos.iter().position(|r| r.root == root) else { return };
            if inner.states[i].dirty {
                inner.states[i].dirty = false;
            } else {
                inner.states[i].running = false;
                return;
            }
        }
    }

    /// A search scope: every repo and folder (`all`), the base folder only (`base`), or chosen repos.
    /// Repos inside a searched folder are skipped there: they're searched as themselves, or not at all.
    pub fn scope(&self, kind: &str, chosen: &[String]) -> crate::search::Scope {
        let repos: Vec<PathBuf> = self.inner.lock().unwrap().repos.iter().map(|r| r.root.clone()).collect();
        let roots: Vec<PathBuf> = match kind {
            "base" => vec![self.base.clone()],
            "repos" => repos.iter().filter(|r| chosen.iter().any(|c| r.as_os_str() == c.as_str())).cloned().collect(),
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
        let files = Arc::new(tokio::task::spawn_blocking(move || crate::search::list_files(&scope)).await.unwrap_or_default());
        self.inner.lock().unwrap().files = Some(files.clone());
        files
    }

    /// Builds the symbol index in the background and announces it with `{"t":"indexReady"}`.
    fn build_index(self: Arc<Self>) {
        tokio::spawn(async move {
            let started = Instant::now();
            let files = self.files().await;
            let Ok(index) = tokio::task::spawn_blocking(move || crate::symbols::Index::build(&files)).await else { return };
            let (files, symbols) = index.counts();
            self.inner.lock().unwrap().symbols = Some(Arc::new(std::sync::RwLock::new(index)));
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            self.send(json!({"t": "indexReady", "files": files, "symbols": symbols, "ms": ms}));
        });
    }

    /// Re-parses changed files in `dirs` (only those the ignore rules keep).
    fn update_index(self: &Arc<Self>, dirs: Vec<PathBuf>) {
        let Some(index) = self.inner.lock().unwrap().symbols.clone() else { return };
        tokio::task::spawn_blocking(move || {
            let mut keep = std::collections::HashSet::new();
            for d in &dirs {
                if let Ok(listing) = crate::files::list(d) {
                    keep.extend(listing.entries.into_iter().filter(|e| !e.ignored).map(|e| e.path));
                }
            }
            index.write().unwrap().update(&dirs, &|p| keep.contains(p));
        });
    }

    /// The symbol index, if it's been built.
    pub fn symbols(&self) -> Option<Arc<std::sync::RwLock<crate::symbols::Index>>> {
        self.inner.lock().unwrap().symbols.clone()
    }

    /// The repo a path belongs to (the innermost one).
    pub fn repo_of(&self, path: &Path) -> Option<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner.repos.iter().filter(|r| path.starts_with(&r.root)).max_by_key(|r| r.root.components().count()).map(|r| r.root.clone())
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
