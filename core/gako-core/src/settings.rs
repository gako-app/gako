//! Settings: a JSON file in the platform's config folder, overridden per workspace by
//! `<base>/.gako/settings.json`. Every key is optional; defaults suit a layout of 10–30 repos,
//! one or two levels deep.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The base folder to open when none is given.
    pub base: Option<PathBuf>,
    /// How many folder levels below the base folder to look for repos.
    pub scan_depth: usize,
    /// Folder names never descended into while looking for repos.
    pub scan_ignore: Vec<String>,
    /// More folders to look for repos in, scanned to the same depth.
    pub extra_folders: Vec<PathBuf>,
    /// How many `git` processes may run at once.
    pub max_git_processes: usize,
    /// How long a repo must be quiet after a change before its status is refreshed.
    pub debounce_ms: u64,
    /// Untracked files listed per repo; the rest are counted.
    pub untracked_limit: usize,
    /// Seconds before a `git` command is given up on.
    pub git_timeout_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            base: None,
            scan_depth: 2,
            scan_ignore: vec!["node_modules".into()],
            extra_folders: Vec::new(),
            max_git_processes: 4,
            debounce_ms: 150,
            untracked_limit: 2000,
            git_timeout_secs: 30,
        }
    }
}

/// `~/Library/Application Support/Gako`, `%APPDATA%\Gako` or `~/.config/gako`.
pub fn user_file() -> Option<PathBuf> {
    let name = if cfg!(any(target_os = "macos", windows)) { "Gako" } else { "gako" };
    dirs::config_dir().map(|d| d.join(name).join("settings.json"))
}

pub fn workspace_file(base: &Path) -> PathBuf {
    base.join(".gako").join("settings.json")
}

fn read(path: &Path) -> Result<Option<Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text).with_context(|| format!("{}", path.display()))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("{}", path.display())),
    }
}

/// Keys in `over` replace those in `base`; objects merge key by key.
fn merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                merge(b.entry(k).or_insert(Value::Null), v);
            }
        }
        (b, o) => *b = o,
    }
}

/// The user's settings, with `base`'s workspace file on top if a base folder is given.
pub fn load(user: Option<&Path>, base: Option<&Path>) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())?;
    if let Some(v) = user.map(read).transpose()?.flatten() {
        merge(&mut value, v);
    }
    if let Some(v) = base.map(|b| read(&workspace_file(b))).transpose()?.flatten() {
        merge(&mut value, v);
    }
    let mut settings: Settings = serde_json::from_value(value).context("settings")?;
    settings.max_git_processes = settings.max_git_processes.max(1);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_overrides_user() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.json");
        std::fs::write(&user, r#"{"scanDepth": 4, "maxGitProcesses": 8}"#).unwrap();
        std::fs::create_dir(dir.path().join(".gako")).unwrap();
        std::fs::write(workspace_file(dir.path()), r#"{"scanDepth": 3}"#).unwrap();
        let s = load(Some(&user), Some(dir.path())).unwrap();
        assert_eq!(s.scan_depth, 3);
        assert_eq!(s.max_git_processes, 8);
        assert_eq!(s.debounce_ms, Settings::default().debounce_ms);
    }

    #[test]
    fn missing_files_give_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(Some(&dir.path().join("none.json")), Some(dir.path())).unwrap();
        assert_eq!(s, Settings::default());
    }
}
