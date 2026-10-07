//! The file explorer's side of the core: listing a folder, reading a file, opening a file in the
//! user's editor. Everything is limited to the workspace's folders.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::git::FileContent;

/// Entries listed per folder; the rest are counted.
pub const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Dir,
    File,
    Symlink,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub kind: Kind,
    /// Excluded by `.gitignore` (or `.ignore`): shown dimmed.
    pub ignored: bool,
    /// A folder that is a repo of its own.
    pub repo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub omitted: usize,
}

/// `path` made absolute with symlinks resolved, as `canonicalize` does, but without the `\\?\`
/// prefix it adds on Windows (`\\?\C:\dev` becomes `C:\dev`) when the plain form means the same:
/// paths are shown to the user and handed to editors and tools, which handle that prefix badly or
/// not at all.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let p = path.canonicalize()?;
    Ok(match p.to_str().and_then(plain) {
        Some(s) => PathBuf::from(s),
        None => p,
    })
}

/// The plain form of a Windows verbatim path (`\\?\C:\x`, `\\?\UNC\server\share\x`), if it
/// has one: not too long for the plain form, and with no name Windows would read differently
/// without the prefix (`NUL`, `COM1`, a trailing dot or space).
fn plain(p: &str) -> Option<String> {
    let s = if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        let rest = p.strip_prefix(r"\\?\")?;
        let b = rest.as_bytes();
        if !(b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\') {
            return None;
        }
        rest.to_string()
    };
    const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let bad = |name: &str| {
        let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
        let numbered = stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit();
        name.ends_with('.') || name.ends_with(' ') || RESERVED.contains(&stem.as_str()) || numbered
    };
    (s.len() < 260 && !s.split('\\').skip(1).any(|n| !n.is_empty() && bad(n))).then_some(s)
}

/// The canonical form of `path`, if it lies inside one of `roots` (also canonical).
pub fn inside(roots: &[PathBuf], path: &Path) -> Result<PathBuf> {
    let p = canonical(path)?;
    if roots.iter().any(|r| p.starts_with(r)) {
        Ok(p)
    } else {
        bail!("{} is outside the workspace", path.display())
    }
}

/// A folder's entries: folders first, then files, by name. Ignored entries are marked, not dropped;
/// `.git` is left out. Symlinks aren't followed.
pub fn list(dir: &Path) -> Result<Listing> {
    // What the ignore rules keep: everything one level down that isn't ignored.
    let kept: HashSet<PathBuf> = ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .ignore(true)
        .require_git(true)
        .follow_links(false)
        .build()
        .flatten()
        .filter(|e| e.depth() == 1)
        .map(|e| e.into_path())
        .collect();
    let mut entries: Vec<Entry> = Vec::new();
    for e in std::fs::read_dir(dir)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let ft = e.file_type()?;
        let path = e.path();
        let kind = if ft.is_symlink() {
            Kind::Symlink
        } else if ft.is_dir() {
            Kind::Dir
        } else {
            Kind::File
        };
        let repo = kind == Kind::Dir && path.join(".git").exists();
        entries.push(Entry { ignored: !kept.contains(&path), name, path, kind, repo });
    }
    entries.sort_by(|a, b| {
        (a.kind != Kind::Dir).cmp(&(b.kind != Kind::Dir)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let omitted = entries.len().saturating_sub(MAX_ENTRIES);
    entries.truncate(MAX_ENTRIES);
    Ok(Listing { entries, omitted })
}

/// A file's content for the viewer: text up to `limit` bytes, binary reported.
pub async fn read(path: &Path, limit: usize) -> Result<FileContent> {
    let bytes = tokio::fs::read(path).await?;
    let size = bytes.len();
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    let text = if binary { String::new() } else { String::from_utf8_lossy(&bytes[..size.min(limit)]).into_owned() };
    Ok(FileContent { text, size, binary, truncated: size > limit })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_windows_paths_lose_their_prefix_when_safe() {
        assert_eq!(plain(r"\\?\C:\dev\projects").as_deref(), Some(r"C:\dev\projects"));
        assert_eq!(plain(r"\\?\UNC\server\share\x").as_deref(), Some(r"\\server\share\x"));
        // Names the plain form would read differently, paths too long for it, other prefixes,
        // and paths that aren't verbatim at all stay as they are.
        assert_eq!(plain(r"\\?\C:\dev\nul.txt"), None);
        assert_eq!(plain(r"\\?\C:\dev\COM1"), None);
        assert_eq!(plain(r"\\?\C:\dev\trailing."), None);
        assert_eq!(plain(&format!(r"\\?\C:\{}", "a".repeat(300))), None);
        assert_eq!(plain(r"\\?\Volume{1234}\x"), None);
        assert_eq!(plain("/Users/me/dev"), None);
        assert_eq!(plain(r"C:\dev"), None);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn lists_with_ignored_marked_and_git_hidden() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().canonicalize().unwrap();
        git(&d, &["init", "-q"]);
        std::fs::write(d.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::create_dir_all(d.join("build")).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("nested/.git")).unwrap();
        std::fs::write(d.join("app.log"), "x").unwrap();
        std::fs::write(d.join("Main.rs"), "x").unwrap();
        std::fs::write(d.join(".editorconfig"), "x").unwrap();
        let l = list(&d).unwrap();
        let names: Vec<(&str, bool, bool)> = l.entries.iter().map(|e| (e.name.as_str(), e.ignored, e.repo)).collect();
        assert_eq!(
            names,
            vec![
                ("build", true, false),
                ("nested", false, true),
                ("src", false, false),
                (".editorconfig", false, false),
                (".gitignore", false, false),
                ("app.log", true, false),
                ("Main.rs", false, false),
            ]
        );
    }

    #[test]
    fn outside_the_workspace_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("in")).unwrap();
        assert!(inside(&[root.join("in")], &root.join("in")).is_ok());
        assert!(inside(&[root.join("in")], &root.join("in/../")).is_err());
    }
}
