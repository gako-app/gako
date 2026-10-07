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

//! File watching for the workspace.
//!
//! One recursive watch per root, debounced. On macOS the events only say which folder changed, so
//! nothing here relies on per-file detail: a batch of events is reduced to the set of repos it
//! touches, and each of those repos gets a full status refresh. Git dirs outside the roots (a
//! worktree's, which lives in its main repo) are watched too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use tokio::sync::mpsc::UnboundedSender;

use super::Repo;

pub struct Watcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

/// What a batch of file events means for the workspace.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// Indexes into the repo list.
    pub repos: Vec<usize>,
    /// A `.git` appeared or disappeared: repos may have been added or removed.
    pub rediscover: bool,
}

pub fn watch(paths: &[PathBuf], debounce: Duration, tx: UnboundedSender<Vec<PathBuf>>) -> Result<Watcher> {
    let mut debouncer = new_debouncer(debounce, None, move |result: DebounceEventResult| {
        if let Ok(events) = result {
            if std::env::var_os("GAKO_DEBUG_WATCH").is_some()
                && let Some(first) = events.first()
            {
                eprintln!("watch: batch of {} events, first arrived {} ms ago", events.len(), first.time.elapsed().as_millis());
            }
            let paths: Vec<PathBuf> = events.into_iter().flat_map(|e| e.event.paths).collect();
            if !paths.is_empty() {
                let _ = tx.send(paths);
            }
        }
    })?;
    for p in paths {
        debouncer.watch(p, RecursiveMode::Recursive)?;
    }
    Ok(Watcher { _debouncer: debouncer })
}

/// Paths inside a git dir that never change a repo's status: object storage, reflogs, and lock
/// files (the rename that releases a lock shows up as a change to the real file).
fn irrelevant_in_git_dir(rel: &Path) -> bool {
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
    matches!(first.as_deref(), Some("objects" | "logs" | "hooks" | "info" | "lfs"))
        || rel.extension().is_some_and(|e| e == "lock")
}

/// Maps changed paths to the repos they belong to: the innermost repo whose working tree or git
/// dir contains the path.
pub fn classify(repos: &[Repo], paths: &[PathBuf]) -> Changes {
    let mut changes = Changes::default();
    for path in paths {
        if path.file_name().is_some_and(|n| n == ".git") {
            changes.rediscover = true;
        }
        let in_git_dir = repos
            .iter()
            .enumerate()
            .filter(|(_, r)| path.starts_with(&r.git_dir))
            .max_by_key(|(_, r)| r.git_dir.components().count());
        let hit = match in_git_dir {
            Some((i, r)) => (!irrelevant_in_git_dir(path.strip_prefix(&r.git_dir).unwrap_or(path))).then_some(i),
            None => repos
                .iter()
                .enumerate()
                .filter(|(_, r)| path.starts_with(&r.root))
                .max_by_key(|(_, r)| r.root.components().count())
                .map(|(i, _)| i),
        };
        if let Some(i) = hit
            && !changes.repos.contains(&i)
        {
            changes.repos.push(i);
        }
    }
    changes.repos.sort_unstable();
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::RepoKind;

    fn repo(root: &str, git_dir: &str) -> Repo {
        Repo { root: root.into(), git_dir: git_dir.into(), kind: RepoKind::Normal }
    }

    #[test]
    fn innermost_repo_and_git_dir_noise() {
        let repos = vec![
            repo("/w", "/w/.git"),
            repo("/w/services/auth", "/w/services/auth/.git"),
            repo("/elsewhere/wt", "/w/services/auth/.git/worktrees/wt"),
        ];
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(classify(&repos, &[p("/w/README.md")]).repos, vec![0]);
        assert_eq!(classify(&repos, &[p("/w/services/auth/src/a.ts")]).repos, vec![1]);
        assert_eq!(classify(&repos, &[p("/w/services/auth/.git/index")]).repos, vec![1]);
        assert_eq!(classify(&repos, &[p("/w/services/auth/.git/objects/ab/cdef")]).repos, Vec::<usize>::new());
        assert_eq!(classify(&repos, &[p("/w/services/auth/.git/index.lock")]).repos, Vec::<usize>::new());
        assert_eq!(classify(&repos, &[p("/w/services/auth/.git/worktrees/wt/HEAD")]).repos, vec![2]);
        let c = classify(&repos, &[p("/w/new/.git"), p("/w/a"), p("/w/b")]);
        assert!(c.rediscover);
        assert_eq!(c.repos, vec![0]);
    }
}
