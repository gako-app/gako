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
}

/// The repo rooted at `dir`, if `dir` has a `.git` folder or file.
pub fn repo_at(dir: &Path) -> Option<Repo> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(Repo { root: dir.to_path_buf(), git_dir: dot_git, kind: RepoKind::Normal });
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let git_dir = dir.join(target);
    let git_dir = crate::files::canonical(&git_dir).unwrap_or(git_dir);
    let parts: Vec<_> = git_dir.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let kind = if parts.windows(2).any(|w| w[0] == ".git" && w[1] == "worktrees") {
        RepoKind::Worktree
    } else {
        RepoKind::Submodule
    };
    Some(Repo { root: dir.to_path_buf(), git_dir, kind })
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
            .args(["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
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
        let base = t.path().canonicalize().unwrap();
        init(&base);
        init(&base.join("services/auth"));
        init(&base.join("services/deep/er/too-deep"));
        init(&base.join("node_modules/pkg"));
        git(&base.join("services/auth"), &["worktree", "add", "-q", &base.join("wt").to_string_lossy(), "-b", "feature"]);
        git(&base, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &base.join("services/auth").to_string_lossy(), "vendor/auth"]);

        let repos = discover(&[base.clone()], 2, &["node_modules".into()]);
        let rel: Vec<_> = repos
            .iter()
            .map(|r| (r.root.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/"), r.kind))
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
        assert!(repos[3].git_dir.ends_with("services/auth/.git/worktrees/wt"));
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
