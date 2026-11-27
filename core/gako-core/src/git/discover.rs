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

//! Finding repos under a base folder.
//!
//! A folder is a repo when it holds `.git`, either a folder or, in worktrees and submodules, a file
//! (`gitdir: <path>`). The walk doesn't apply `.gitignore`: nested repos are usually ignored by the
//! base repo, and finding them is the point. It goes `depth` levels below each root and skips the
//! configured folder names.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
    Normal,
    Worktree,
    Submodule,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub root: PathBuf,
    /// Where the repo's own files live: `.git`, or what a `.git` file points to.
    pub git_dir: PathBuf,
    pub kind: RepoKind,
    /// A worktree's main repo (the root of the repo whose Git folder it shares), once `link` has
    /// found it among the repos.
    pub main: Option<PathBuf>,
}

/// The repo rooted at `dir`, if `dir` has a `.git` folder or file.
pub fn repo_at(dir: &Path) -> Option<Repo> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(Repo {
            root: dir.to_path_buf(),
            git_dir: dot_git,
            kind: RepoKind::Normal,
            main: None,
        });
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let git_dir = dir.join(target);
    let git_dir = crate::files::canonical(&git_dir).unwrap_or(git_dir);
    let parts: Vec<_> = git_dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let kind = if parts
        .windows(2)
        .any(|w| w[0] == ".git" && w[1] == "worktrees")
    {
        RepoKind::Worktree
    } else {
        RepoKind::Submodule
    };
    Some(Repo {
        root: dir.to_path_buf(),
        git_dir,
        kind,
        main: None,
    })
}

/// The worktrees a repo's Git folder knows of, wherever they are, most recently used first. Each
/// is read from `worktrees/<name>/gitdir`, which names the worktree's `.git` file (relative to that
/// folder when `worktree.useRelativePaths` is set). Ones whose folder is gone, which
/// `git worktree prune` would remove, are left out.
pub fn linked_worktrees(git_dir: &Path) -> Vec<Repo> {
    let Ok(entries) = std::fs::read_dir(git_dir.join("worktrees")) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, Repo)> = Vec::new();
    for entry in entries.flatten() {
        let admin = entry.path();
        let Ok(text) = std::fs::read_to_string(admin.join("gitdir")) else {
            continue;
        };
        let dot_git = admin.join(text.trim());
        let Some(root) = dot_git.parent() else {
            continue;
        };
        let root = crate::files::canonical(root).unwrap_or_else(|_| root.to_path_buf());
        let Some(repo) = repo_at(&root) else { continue };
        let admin = crate::files::canonical(&admin).unwrap_or(admin);
        if repo.kind != RepoKind::Worktree || repo.git_dir != admin {
            continue; // the folder now holds something else
        }
        // HEAD changes on a commit or a checkout, the index on most other work.
        let used = ["HEAD", "index"]
            .iter()
            .filter_map(|f| {
                std::fs::metadata(admin.join(f))
                    .and_then(|m| m.modified())
                    .ok()
            })
            .max()
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push((used, repo));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.root.cmp(&b.1.root)));
    found.into_iter().map(|(_, r)| r).collect()
}

/// The Git folder a worktree shares with its main repo, from its `commondir` file.
fn common_dir(git_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(git_dir.join("commondir")).ok()?;
    let dir = git_dir.join(text.trim());
    Some(crate::files::canonical(&dir).unwrap_or(dir))
}

/// Adds the worktrees of `repos` that lie outside `roots` (up to `limit` per repo, most recently
/// used first), and sets each worktree's `main` to its main repo when that is in the list. Sorted
/// by path.
pub fn with_worktrees(mut repos: Vec<Repo>, roots: &[PathBuf], limit: Option<usize>) -> Vec<Repo> {
    if let Some(limit) = limit {
        let mut more = Vec::new();
        for r in repos.iter().filter(|r| r.kind == RepoKind::Normal) {
            more.extend(outside_worktrees(r, roots, limit));
        }
        for w in more {
            if !repos.iter().any(|r| r.root == w.root) {
                repos.push(w);
            }
        }
        repos.sort_by(|a, b| a.root.cmp(&b.root));
    }
    let mains: Vec<(PathBuf, PathBuf)> = repos
        .iter()
        .filter(|r| r.kind == RepoKind::Normal)
        .map(|r| {
            let dir = crate::files::canonical(&r.git_dir).unwrap_or_else(|_| r.git_dir.clone());
            (dir, r.root.clone())
        })
        .collect();
    for r in repos.iter_mut().filter(|r| r.kind == RepoKind::Worktree) {
        r.main = common_dir(&r.git_dir).and_then(|c| {
            mains
                .iter()
                .find(|(d, _)| *d == c)
                .map(|(_, root)| root.clone())
        });
    }
    repos
}

/// A repo's worktrees outside `roots`, the `limit` most recently used.
pub fn outside_worktrees(main: &Repo, roots: &[PathBuf], limit: usize) -> Vec<Repo> {
    linked_worktrees(&main.git_dir)
        .into_iter()
        .filter(|w| !roots.iter().any(|root| w.root.starts_with(root)))
        .take(limit)
        .collect()
}

/// Repos in `roots` and up to `depth` levels below them, sorted by path.
pub fn discover(roots: &[PathBuf], depth: usize, skip: &[String]) -> Vec<Repo> {
    let mut found = BTreeSet::new();
    for root in roots {
        let skip = skip.to_vec();
        let walker = ignore::WalkBuilder::new(root)
            .standard_filters(false)
            .hidden(false)
            .max_depth(Some(depth))
            .filter_entry(move |e| {
                let name = e.file_name().to_string_lossy();
                name != ".git" && !skip.iter().any(|s| *s == name)
            })
            .build();
        for entry in walker.flatten() {
            if entry.file_type().is_some_and(|t| t.is_dir()) {
                found.insert(entry.into_path());
            }
        }
    }
    found.iter().filter_map(|d| repo_at(d)).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

/// The operation in progress, read from the git dir as VS Code's Git extension does.
pub fn operation(git_dir: &Path) -> Option<Operation> {
    let has = |name: &str| git_dir.join(name).exists();
    if has("rebase-merge") || has("rebase-apply") {
        Some(Operation::Rebase)
    } else if has("MERGE_HEAD") {
        Some(Operation::Merge)
    } else if has("CHERRY_PICK_HEAD") {
        Some(Operation::CherryPick)
    } else if has("REVERT_HEAD") {
        Some(Operation::Revert)
    } else if has("BISECT_LOG") {
        Some(Operation::Bisect)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args([
                "-c",
                "init.defaultBranch=main",
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        std::fs::write(dir.join("f.txt"), "x").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn nested_worktree_submodule_and_depth() {
        let t = tempfile::tempdir().unwrap();
        let base = crate::files::canonical(&t.path()).unwrap();
        init(&base);
        init(&base.join("services/auth"));
        init(&base.join("services/deep/er/too-deep"));
        init(&base.join("node_modules/pkg"));
        git(
            &base.join("services/auth"),
            &[
                "worktree",
                "add",
                "-q",
                &base.join("wt").to_string_lossy(),
                "-b",
                "feature",
            ],
        );
        git(
            &base,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &base.join("services/auth").to_string_lossy(),
                "vendor/auth",
            ],
        );

        let repos = discover(&[base.clone()], 2, &["node_modules".into()]);
        let rel: Vec<_> = repos
            .iter()
            .map(|r| {
                (
                    r.root
                        .strip_prefix(&base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    r.kind,
                )
            })
            .collect();
        assert_eq!(
            rel,
            vec![
                (String::new(), RepoKind::Normal),
                ("services/auth".into(), RepoKind::Normal),
                ("vendor/auth".into(), RepoKind::Submodule),
                ("wt".into(), RepoKind::Worktree),
            ]
        );
        assert!(
            repos[3]
                .git_dir
                .ends_with("services/auth/.git/worktrees/wt")
        );
        let repos = with_worktrees(repos, std::slice::from_ref(&base), Some(10));
        assert_eq!(repos.len(), 4, "the worktree inside isn't added twice");
        assert_eq!(repos[3].main.as_deref(), Some(&*base.join("services/auth")));
        assert_eq!(repos[0].main, None);
    }

    #[test]
    fn worktrees_outside_the_roots() {
        let t = tempfile::tempdir().unwrap();
        let tmp = crate::files::canonical(&t.path()).unwrap();
        let base = tmp.join("base");
        let away = tmp.join("away");
        init(&base.join("app"));
        std::fs::create_dir_all(&away).unwrap();
        let app = base.join("app");
        for name in ["one", "two", "three"] {
            let path = away.join(name).to_string_lossy().into_owned();
            git(&app, &["worktree", "add", "-q", &path, "-b", name]);
        }
        // One whose folder is gone, as an agent tool might leave it.
        std::fs::remove_dir_all(away.join("three")).unwrap();
        let roots = [base.clone()];
        let found = discover(&roots, 2, &[]);
        assert_eq!(found.len(), 1);

        let repos = with_worktrees(found.clone(), &roots, Some(10));
        let roots_found: Vec<_> = repos.iter().map(|r| r.root.clone()).collect();
        assert_eq!(
            roots_found,
            vec![away.join("one"), away.join("two"), app.clone()]
        );
        assert!(repos[..2].iter().all(|r| r.kind == RepoKind::Worktree));
        assert!(repos[..2].iter().all(|r| r.main.as_deref() == Some(&*app)));

        // The limit keeps the most recently used.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(away.join("one/f.txt"), "y").unwrap();
        git(&away.join("one"), &["add", "."]);
        let limited = with_worktrees(found.clone(), &roots, Some(1));
        let roots_found: Vec<_> = limited.iter().map(|r| r.root.clone()).collect();
        assert_eq!(roots_found, vec![away.join("one"), app]);

        // Off: nothing is added, but worktrees inside still find their main repo.
        assert_eq!(with_worktrees(found, &roots, None).len(), 1);
    }

    #[test]
    fn operations() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(operation(t.path()), None);
        std::fs::write(t.path().join("MERGE_HEAD"), "x").unwrap();
        assert_eq!(operation(t.path()), Some(Operation::Merge));
        std::fs::create_dir(t.path().join("rebase-merge")).unwrap();
        assert_eq!(operation(t.path()), Some(Operation::Rebase));
    }
}
