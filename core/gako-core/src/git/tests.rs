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

//! Runs the real `git` against throwaway repos.

use std::path::Path;
use std::time::Duration;

use super::status::{Change, Conflict};
use super::*;

fn sh_git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
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
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn repo(dir: &Path) -> Repo {
    discover::repo_at(dir).expect("a repo")
}

fn git() -> Git {
    Git::new(4, Duration::from_secs(30))
}

/// The tests commit through `Git`, which uses the user's config; give it an identity.
fn configure(dir: &Path) {
    sh_git(dir, &["config", "user.name", "t"]);
    sh_git(dir, &["config", "user.email", "t@t"]);
    sh_git(dir, &["config", "commit.gpgsign", "false"]);
    sh_git(
        dir,
        &[
            "config",
            "core.hooksPath",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ],
    );
}

fn init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    sh_git(dir, &["init", "-q"]);
    configure(dir);
}

#[tokio::test]
async fn nested_repos_are_not_untracked_folders() {
    let t = tempfile::tempdir().unwrap();
    let base = crate::files::canonical(&t.path()).unwrap();
    init(&base);
    std::fs::write(base.join("README.md"), "base").unwrap();
    init(&base.join("services/auth"));
    std::fs::write(base.join("notes.txt"), "untracked").unwrap();
    let nested = vec![base.join("services/auth")];
    let st = status(&git(), &repo(&base), &nested, 100).await.unwrap();
    let paths: Vec<_> = st.status.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["README.md", "notes.txt"]);
    assert_eq!(st.status.oid, None, "unborn");
    assert_eq!(st.status.branch.as_deref(), Some("main"));
}

#[tokio::test]
async fn contents_log_and_commit_details() {
    let t = tempfile::tempdir().unwrap();
    let dir = crate::files::canonical(&t.path()).unwrap();
    init(&dir);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let g = git();

    sh_git(&dir, &["add", "a.txt"]);
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!(st.entries[0].index, Some(Change::Added));
    sh_git(&dir, &["commit", "-q", "-m", "First\n\nWith a body."]);
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    sh_git(&dir, &["add", "a.txt"]);
    std::fs::write(dir.join("a.txt"), "three\n").unwrap();

    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!(
        (st.entries[0].index, st.entries[0].worktree),
        (Some(Change::Modified), Some(Change::Modified))
    );
    let text = |c: Option<FileContent>| c.unwrap().text;
    assert_eq!(
        text(
            file(&g, &dir, Rev::Commit("HEAD"), "a.txt", 1 << 20)
                .await
                .unwrap()
        ),
        "one\n"
    );
    assert_eq!(
        text(file(&g, &dir, Rev::Index, "a.txt", 1 << 20).await.unwrap()),
        "two\n"
    );
    assert_eq!(
        text(
            file(&g, &dir, Rev::WorkTree, "a.txt", 1 << 20)
                .await
                .unwrap()
        ),
        "three\n"
    );
    assert!(
        file(&g, &dir, Rev::Commit("HEAD"), "missing.txt", 1 << 20)
            .await
            .unwrap()
            .is_none()
    );

    let commits = log(&g, &dir, 0, 10).await.unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "First");
    let head = String::from_utf8(g.run(&dir, &["rev-parse", "HEAD"]).await.unwrap()).unwrap();
    let details = show_commit(&g, &dir, head.trim()).await.unwrap();
    assert_eq!(details.message, "First\n\nWith a body.");
    assert_eq!(details.files.len(), 1);
    assert_eq!(
        (details.files[0].status, details.files[0].path.as_str()),
        ('A', "a.txt")
    );
}

#[tokio::test]
async fn merge_conflict_and_rename() {
    let t = tempfile::tempdir().unwrap();
    let dir = crate::files::canonical(&t.path()).unwrap();
    init(&dir);
    std::fs::write(dir.join("f.txt"), "base\n").unwrap();
    std::fs::write(dir.join("old name.txt"), "a\nb\nc\nd\ne\n").unwrap();
    sh_git(&dir, &["add", "."]);
    sh_git(&dir, &["commit", "-q", "-m", "base"]);
    sh_git(&dir, &["checkout", "-q", "-b", "other"]);
    std::fs::write(dir.join("f.txt"), "other\n").unwrap();
    sh_git(&dir, &["commit", "-q", "-am", "other"]);
    sh_git(&dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("f.txt"), "main\n").unwrap();
    sh_git(&dir, &["commit", "-q", "-am", "main"]);
    let _ = std::process::Command::new("git")
        .args(["merge", "other"])
        .current_dir(&dir)
        .output();
    sh_git(&dir, &["mv", "old name.txt", "new name.txt"]);

    let st = status(&git(), &repo(&dir), &[], 100).await.unwrap();
    assert_eq!(st.operation, Some(Operation::Merge));
    let f = st
        .status
        .entries
        .iter()
        .find(|e| e.path == "f.txt")
        .unwrap();
    assert_eq!(f.conflict, Some(Conflict::BothModified));
    let r = st
        .status
        .entries
        .iter()
        .find(|e| e.path == "new name.txt")
        .unwrap();
    assert_eq!(
        (r.index, r.orig_path.as_deref()),
        (Some(Change::Renamed), Some("old name.txt"))
    );
}

#[tokio::test]
async fn detached_head_and_ahead_behind() {
    let t = tempfile::tempdir().unwrap();
    let upstream = t.path().join("up");
    init(&upstream);
    std::fs::write(upstream.join("f"), "1").unwrap();
    sh_git(&upstream, &["add", "."]);
    sh_git(&upstream, &["commit", "-q", "-m", "1"]);
    sh_git(t.path(), &["clone", "-q", "up", "down"]);
    let down = crate::files::canonical(&t.path().join("down")).unwrap();
    configure(&down);
    std::fs::write(down.join("g"), "2").unwrap();
    sh_git(&down, &["add", "."]);
    sh_git(&down, &["commit", "-q", "-m", "2"]);
    std::fs::write(upstream.join("h"), "3").unwrap();
    sh_git(&upstream, &["add", "."]);
    sh_git(&upstream, &["commit", "-q", "-m", "3"]);
    sh_git(&down, &["fetch", "-q"]);

    let st = status(&git(), &repo(&down), &[], 100).await.unwrap().status;
    assert_eq!((st.ahead, st.behind), (1, 1));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));

    sh_git(&down, &["checkout", "-q", "--detach", "HEAD~1"]);
    let st = status(&git(), &repo(&down), &[], 100).await.unwrap().status;
    assert_eq!(st.branch, None);
    assert!(st.oid.is_some());
}

#[tokio::test]
async fn fetch_pull_and_push_against_a_remote() {
    let t = tempfile::tempdir().unwrap();
    let origin = t.path().join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    sh_git(&origin, &["init", "-q", "--bare"]);
    let a = t.path().join("a");
    let b = t.path().join("b");
    for (dir, name) in [(&a, "a"), (&b, "b")] {
        sh_git(t.path(), &["clone", "-q", origin.to_str().unwrap(), name]);
        configure(dir);
    }
    // a pushes a commit; b sees it as behind after a fetch and fast-forwards to it.
    std::fs::write(a.join("f"), "1").unwrap();
    sh_git(&a, &["add", "f"]);
    sh_git(&a, &["commit", "-q", "-m", "one"]);
    sh_git(&a, &["push", "-q", "-u", "origin", "HEAD"]);
    std::fs::write(a.join("f"), "2").unwrap();
    sh_git(&a, &["commit", "-q", "-am", "two"]);
    let s = status(&git(), &repo(&a), &[], 100).await.unwrap();
    assert_eq!(s.status.ahead, 1);
    remote(&a, "push").await.unwrap();
    let s = status(&git(), &repo(&a), &[], 100).await.unwrap();
    assert_eq!(s.status.ahead, 0);

    sh_git(&b, &["fetch", "-q"]);
    sh_git(
        &b,
        &["checkout", "-q", "-b", "main", "--track", "origin/main"],
    );
    sh_git(&b, &["reset", "-q", "--hard", "HEAD~1"]);
    remote(&b, "fetch").await.unwrap();
    let s = status(&git(), &repo(&b), &[], 100).await.unwrap();
    assert_eq!(s.status.behind, 1);
    remote(&b, "pull").await.unwrap();
    assert_eq!(std::fs::read_to_string(b.join("f")).unwrap(), "2");

    // A pull that would need a merge is refused rather than merging.
    std::fs::write(b.join("g"), "b").unwrap();
    sh_git(&b, &["add", "g"]);
    sh_git(&b, &["commit", "-q", "-m", "b's"]);
    std::fs::write(a.join("h"), "a").unwrap();
    sh_git(&a, &["add", "h"]);
    sh_git(&a, &["commit", "-q", "-m", "a's"]);
    remote(&a, "push").await.unwrap();
    assert!(remote(&b, "pull").await.is_err());
    assert!(remote(&b, "merge").await.is_err());
}

#[tokio::test]
async fn revert_each_kind_of_change() {
    let t = tempfile::tempdir().unwrap();
    let dir = crate::files::canonical(&t.path()).unwrap();
    init(&dir);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    std::fs::write(dir.join("old.txt"), "old\n").unwrap();
    sh_git(&dir, &["add", "."]);
    sh_git(&dir, &["commit", "-q", "-m", "base"]);
    let g = git();
    let read = |p: &str| std::fs::read_to_string(dir.join(p)).ok();

    // Changes not staged go back to what's staged.
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    sh_git(&dir, &["add", "a.txt"]);
    std::fs::write(dir.join("a.txt"), "three\n").unwrap();
    revert(&g, &dir, Revert::Changes, "a.txt", None)
        .await
        .unwrap();
    assert_eq!(read("a.txt").as_deref(), Some("two\n"));
    // Staged changes go back to HEAD, in the index too.
    revert(&g, &dir, Revert::Staged, "a.txt", None)
        .await
        .unwrap();
    assert_eq!(read("a.txt").as_deref(), Some("one\n"));

    // A staged new file is unstaged and deleted; a rename puts the old name back.
    std::fs::write(dir.join("new.txt"), "new\n").unwrap();
    sh_git(&dir, &["add", "new.txt"]);
    revert(&g, &dir, Revert::Staged, "new.txt", None)
        .await
        .unwrap();
    assert_eq!(read("new.txt"), None);
    sh_git(&dir, &["mv", "old.txt", "moved.txt"]);
    revert(&g, &dir, Revert::Staged, "moved.txt", Some("old.txt"))
        .await
        .unwrap();
    assert_eq!(
        (read("moved.txt"), read("old.txt").as_deref()),
        (None, Some("old\n"))
    );

    // An untracked file is deleted; a tracked one never is, nor anything outside the repo.
    std::fs::write(dir.join("scratch.txt"), "x").unwrap();
    revert(&g, &dir, Revert::Untracked, "scratch.txt", None)
        .await
        .unwrap();
    assert_eq!(read("scratch.txt"), None);
    assert!(
        revert(&g, &dir, Revert::Untracked, "a.txt", None)
            .await
            .is_err()
    );
    assert!(
        revert(&g, &dir, Revert::Untracked, "../outside", None)
            .await
            .is_err()
    );
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert!(st.entries.is_empty(), "{:?}", st.entries);
}

#[tokio::test]
async fn list_and_switch_branches() {
    let t = tempfile::tempdir().unwrap();
    let origin = t.path().join("origin");
    init(&origin);
    std::fs::write(origin.join("f"), "1").unwrap();
    sh_git(&origin, &["add", "."]);
    sh_git(&origin, &["commit", "-q", "-m", "1"]);
    sh_git(&origin, &["branch", "feature"]);
    sh_git(&origin, &["branch", "shared"]);
    sh_git(t.path(), &["clone", "-q", "origin", "clone"]);
    let dir = crate::files::canonical(&t.path().join("clone")).unwrap();
    configure(&dir);
    sh_git(&dir, &["branch", "shared", "origin/shared"]);
    sh_git(&dir, &["branch", "local-only"]);
    let g = git();

    let mut b = branches(&g, &dir).await.unwrap();
    b.local.sort();
    assert_eq!(b.local, vec!["local-only", "main", "shared"]);
    assert_eq!(
        b.remote,
        vec!["origin/feature"],
        "remote branches with a local one are left out"
    );

    switch(&g, &dir, "local-only", false).await.unwrap();
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!(st.branch.as_deref(), Some("local-only"));
    switch(&g, &dir, "origin/feature", true).await.unwrap();
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!(
        (st.branch.as_deref(), st.upstream.as_deref()),
        (Some("feature"), Some("origin/feature"))
    );
    assert!(switch(&g, &dir, "nope", false).await.is_err());
    assert!(switch(&g, &dir, "--detach", false).await.is_err());
}
