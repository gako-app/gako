//! Git, through the `git` CLI.

pub mod discover;
pub mod status;
pub mod watch;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Semaphore;

pub use discover::{Operation, Repo, RepoKind};
pub use status::Status;

/// Runs `git` with a limit on how many run at once and a timeout.
#[derive(Clone)]
pub struct Git {
    permits: Arc<Semaphore>,
    timeout: Duration,
}

impl Git {
    pub fn new(max_processes: usize, timeout: Duration) -> Git {
        Git { permits: Arc::new(Semaphore::new(max_processes.max(1))), timeout }
    }

    /// `git <args>` in `dir`, returning stdout. Fails on a non-zero exit, with git's stderr.
    pub async fn run(&self, dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
        let _permit = self.permits.acquire().await?;
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(dir)
            // Never prompt, and never take optional locks (status would otherwise refresh the
            // index and trigger our own file watcher).
            // The login shell's PATH, so hooks find the tools they call.
            .envs(crate::shellenv::get().get("PATH").map(|p| ("PATH", p.as_str())))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let child = cmd.spawn().context("starting git")?;
        let out = tokio::time::timeout(self.timeout, child.wait_with_output())
            .await
            .with_context(|| format!("git {} timed out", args.join(" ")))??;
        if !out.status.success() {
            bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(out.stdout)
    }
}

/// A repo's status, plus the operation in progress. Untracked entries for nested repos (which git
/// shows as untracked folders) are dropped: they're repos of their own.
pub async fn status(git: &Git, repo: &Repo, nested: &[PathBuf], untracked_limit: usize) -> Result<RepoStatus> {
    let out = git.run(&repo.root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?;
    let mut st = status::parse(&out, untracked_limit);
    let nested_rel: Vec<String> = nested
        .iter()
        .filter_map(|n| n.strip_prefix(&repo.root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    st.entries.retain(|e| {
        !(e.untracked && nested_rel.iter().any(|n| e.path.trim_end_matches('/') == n || e.path.starts_with(&format!("{n}/"))))
    });
    Ok(RepoStatus { status: st, operation: discover::operation(&repo.git_dir) })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    #[serde(flatten)]
    pub status: Status,
    pub operation: Option<Operation>,
}

/// Where a file's content comes from.
pub enum Rev<'a> {
    WorkTree,
    Index,
    Commit(&'a str),
}

/// A file's content at a revision; `None` when it doesn't exist there. Content is capped at
/// `limit` bytes; binary content is reported, not returned.
pub async fn file(git: &Git, repo: &Path, rev: Rev<'_>, path: &str, limit: usize) -> Result<Option<FileContent>> {
    let bytes = match rev {
        Rev::WorkTree => match tokio::fs::read(repo.join(path)).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        },
        Rev::Index | Rev::Commit(_) => {
            let spec = match rev {
                Rev::Commit(c) => format!("{c}:{path}"),
                _ => format!(":{path}"),
            };
            match git.run(repo, &["show", &spec]).await {
                Ok(b) => b,
                Err(e) if is_missing(&e) => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    };
    let size = bytes.len();
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    let truncated = size > limit;
    let text = if binary { String::new() } else { String::from_utf8_lossy(&bytes[..size.min(limit)]).into_owned() };
    Ok(Some(FileContent { text, size, binary, truncated }))
}

fn is_missing(e: &anyhow::Error) -> bool {
    let m = e.to_string();
    m.contains("does not exist") || m.contains("exists on disk, but not in") || m.contains("invalid object name")
        || m.contains("bad revision") || m.contains("unknown revision")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub size: usize,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub subject: String,
}

const SEP: char = '\x1f';
const END: char = '\x1e';

/// The commit log from HEAD, newest first; empty on an unborn branch.
pub async fn log(git: &Git, repo: &Path, skip: usize, limit: usize) -> Result<Vec<Commit>> {
    let format = format!("--format=%H{SEP}%P{SEP}%an{SEP}%ae{SEP}%at{SEP}%s{END}");
    let out = match git
        .run(repo, &["log", &format, &format!("--skip={skip}"), &format!("--max-count={limit}"), "HEAD", "--"])
        .await
    {
        Ok(o) => o,
        Err(e) if is_missing(&e) || e.to_string().contains("does not have any commits") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(String::from_utf8_lossy(&out)
        .split(END)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split(SEP).collect();
            (f.len() == 6).then(|| Commit {
                hash: f[0].into(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].into(),
                email: f[3].into(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].into(),
            })
        })
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub status: char,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub message: String,
    pub files: Vec<CommitFile>,
}

/// A commit's metadata, full message, and changed files against its first parent.
pub async fn show_commit(git: &Git, repo: &Path, hash: &str) -> Result<CommitDetails> {
    let format = format!("--format=%H{SEP}%P{SEP}%an{SEP}%ae{SEP}%at{SEP}%cn{SEP}%B{END}");
    let out = git.run(repo, &["show", "-s", &format, hash, "--"]).await?;
    let text = String::from_utf8_lossy(&out);
    let f: Vec<&str> = text.trim_end().trim_end_matches(END).splitn(7, SEP).collect();
    if f.len() != 7 {
        bail!("unexpected git show output");
    }
    // --root shows the first commit's files too; -m with --first-parent covers merges.
    let names = git
        .run(repo, &["diff-tree", "-r", "-z", "--root", "--name-status", "-M", "-m", "--first-parent", "--no-commit-id", hash])
        .await?;
    let names = String::from_utf8_lossy(&names);
    let mut tokens = names.split('\0').filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(st) = tokens.next() {
        let status = st.chars().next().unwrap_or('M');
        if matches!(status, 'R' | 'C') {
            let orig = tokens.next().map(String::from);
            if let Some(path) = tokens.next() {
                files.push(CommitFile { status, path: path.into(), orig_path: orig });
            }
        } else if let Some(path) = tokens.next() {
            files.push(CommitFile { status, path: path.into(), orig_path: None });
        }
    }
    Ok(CommitDetails {
        hash: f[0].into(),
        parents: f[1].split_whitespace().map(String::from).collect(),
        author: f[2].into(),
        email: f[3].into(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].into(),
        message: f[6].trim_end().into(),
        files,
    })
}

/// Talks to the repo's remote: `fetch` (with pruning), `pull` (fast-forward only, so a button
/// never creates a merge) or `push` (to the branch's upstream). These can take a while and wait on
/// the network, so they don't hold one of the slots status scans use, they get two minutes, and
/// they run with the login shell's whole environment, for the SSH agent and credential helpers.
pub async fn remote(repo: &Path, action: &str) -> Result<()> {
    let args: &[&str] = match action {
        "fetch" => &["fetch", "--prune"],
        "pull" => &["pull", "--ff-only"],
        "push" => &["push"],
        _ => bail!("unknown remote action {action}"),
    };
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(repo)
        .envs(crate::shellenv::get())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().context("starting git")?;
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .with_context(|| format!("git {} timed out after two minutes", args.join(" ")))??;
    if !out.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Which of a file's changes a revert throws away, as the repos view groups them.
pub enum Revert {
    /// Changes not staged: the working tree goes back to the index.
    Changes,
    /// An untracked file: deleted.
    Untracked,
    /// Staged changes: the index and the working tree go back to HEAD. A file HEAD doesn't have
    /// is unstaged and deleted; a renamed file's old path comes back too.
    Staged,
}

/// Throws away a file's changes (VS Code's "Discard Changes"); `path` is relative to the repo.
pub async fn revert(git: &Git, repo: &Path, what: Revert, path: &str, orig_path: Option<&str>) -> Result<()> {
    match what {
        Revert::Changes => {
            git.run(repo, &["restore", "--worktree", "--", path]).await?;
        }
        Revert::Untracked => {
            // Only a file git lists as untracked is deleted, which also keeps the path inside the repo.
            let out = git.run(repo, &["ls-files", "--others", "--exclude-standard", "-z", "--", path]).await?;
            if !out.split(|&b| b == 0).any(|p| p == path.as_bytes()) {
                bail!("{path} isn't an untracked file");
            }
            tokio::fs::remove_file(repo.join(path)).await.with_context(|| format!("deleting {path}"))?;
        }
        Revert::Staged => {
            for p in std::iter::once(path).chain(orig_path) {
                let in_head = git.run(repo, &["cat-file", "-e", &format!("HEAD:{p}")]).await.is_ok();
                if in_head {
                    git.run(repo, &["restore", "--source=HEAD", "--staged", "--worktree", "--", p]).await?;
                } else {
                    git.run(repo, &["rm", "-q", "--cached", "--ignore-unmatch", "--", p]).await?;
                    match tokio::fs::remove_file(repo.join(p)).await {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                            return Err(anyhow::Error::from(e).context(format!("deleting {p}")));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    /// Local branches, most recently committed to first.
    pub local: Vec<String>,
    /// Remote branches with no local branch of the same name (`origin/feature`), likewise.
    pub remote: Vec<String>,
}

/// The branches a repo can switch to.
pub async fn branches(git: &Git, repo: &Path) -> Result<Branches> {
    let out = git
        .run(repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(symref)", "refs/heads", "refs/remotes"])
        .await?;
    let mut b = Branches::default();
    let mut remote = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let (name, symref) = line.split_once('\t').unwrap_or((line, ""));
        if !symref.is_empty() {
            continue; // origin/HEAD
        }
        if let Some(n) = name.strip_prefix("refs/heads/") {
            b.local.push(n.to_string());
        } else if let Some(n) = name.strip_prefix("refs/remotes/") {
            remote.push(n.to_string());
        }
    }
    b.remote = remote.into_iter().filter(|r| r.split_once('/').is_none_or(|(_, n)| !b.local.iter().any(|l| l == n))).collect();
    Ok(b)
}

/// Switches to a local branch, or to a new local branch tracking a remote one (`origin/feature`).
/// Git refuses when uncommitted changes would be overwritten, and says so.
pub async fn switch(git: &Git, repo: &Path, branch: &str, remote: bool) -> Result<()> {
    let refname = format!("refs/{}/{branch}", if remote { "remotes" } else { "heads" });
    if branch.starts_with('-') || git.run(repo, &["show-ref", "--verify", "--quiet", &refname]).await.is_err() {
        bail!("there's no branch {branch}");
    }
    if remote {
        git.run(repo, &["switch", "--track", branch]).await?;
    } else {
        git.run(repo, &["switch", "--no-guess", branch]).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
