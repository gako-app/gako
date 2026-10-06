//! Runs the real `git` against throwaway repos.

use std::path::Path;
use std::time::Duration;

use super::status::{Change, Conflict};
use super::*;

fn sh_git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
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
    sh_git(dir, &["config", "core.hooksPath", if cfg!(windows) { "NUL" } else { "/dev/null" }]);
}

fn init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    sh_git(dir, &["init", "-q"]);
    configure(dir);
}

#[tokio::test]
async fn nested_repos_are_not_untracked_folders() {
    let t = tempfile::tempdir().unwrap();
    let base = t.path().canonicalize().unwrap();
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
async fn stage_unstage_commit_and_contents() {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().canonicalize().unwrap();
    init(&dir);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let g = git();

    stage(&g, &dir, &["a.txt".into()]).await.unwrap();
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!(st.entries[0].index, Some(Change::Added));
    unstage(&g, &dir, &["a.txt".into()], true).await.unwrap();
    assert!(status(&g, &repo(&dir), &[], 100).await.unwrap().status.entries[0].untracked);

    stage(&g, &dir, &["a.txt".into()]).await.unwrap();
    let first = commit(&g, &dir, "First\n\nWith a body.", false).await.unwrap();
    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    stage(&g, &dir, &["a.txt".into()]).await.unwrap();
    std::fs::write(dir.join("a.txt"), "three\n").unwrap();

    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!((st.entries[0].index, st.entries[0].worktree), (Some(Change::Modified), Some(Change::Modified)));
    let text = |c: Option<FileContent>| c.unwrap().text;
    assert_eq!(text(file(&g, &dir, Rev::Commit("HEAD"), "a.txt", 1 << 20).await.unwrap()), "one\n");
    assert_eq!(text(file(&g, &dir, Rev::Index, "a.txt", 1 << 20).await.unwrap()), "two\n");
    assert_eq!(text(file(&g, &dir, Rev::WorkTree, "a.txt", 1 << 20).await.unwrap()), "three\n");
    assert!(file(&g, &dir, Rev::Commit("HEAD"), "missing.txt", 1 << 20).await.unwrap().is_none());

    unstage(&g, &dir, &["a.txt".into()], false).await.unwrap();
    let st = status(&g, &repo(&dir), &[], 100).await.unwrap().status;
    assert_eq!((st.entries[0].index, st.entries[0].worktree), (None, Some(Change::Modified)));

    stage(&g, &dir, &["a.txt".into()]).await.unwrap();
    let amended = commit(&g, &dir, "First, amended", true).await.unwrap();
    assert_ne!(first, amended);
    let commits = log(&g, &dir, 0, 10).await.unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "First, amended");

    let details = show_commit(&g, &dir, &amended).await.unwrap();
    assert_eq!(details.message, "First, amended");
    assert_eq!(details.files.len(), 1);
    assert_eq!((details.files[0].status, details.files[0].path.as_str()), ('A', "a.txt"));
}

#[tokio::test]
async fn merge_conflict_and_rename() {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().canonicalize().unwrap();
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
    let _ = std::process::Command::new("git").args(["merge", "other"]).current_dir(&dir).output();
    sh_git(&dir, &["mv", "old name.txt", "new name.txt"]);

    let st = status(&git(), &repo(&dir), &[], 100).await.unwrap();
    assert_eq!(st.operation, Some(Operation::Merge));
    let f = st.status.entries.iter().find(|e| e.path == "f.txt").unwrap();
    assert_eq!(f.conflict, Some(Conflict::BothModified));
    let r = st.status.entries.iter().find(|e| e.path == "new name.txt").unwrap();
    assert_eq!((r.index, r.orig_path.as_deref()), (Some(Change::Renamed), Some("old name.txt")));
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
    let down = t.path().join("down").canonicalize().unwrap();
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
