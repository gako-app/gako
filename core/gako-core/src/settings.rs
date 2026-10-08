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

//! Settings: one JSON file in the platform's config folder. Every key is optional; defaults suit a
//! layout of 10–30 repos, one or two levels deep. Folders that Gako opens have no settings of
//! their own, so nothing in a repository can change what Gako runs. The file is watched, so edits
//! reach the running app.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
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
    /// Programs offered for new terminal tabs, besides the shell.
    pub agents: Vec<Agent>,
    /// Rows kept per terminal tab.
    pub terminal_scrollback: usize,
    /// `webgl` or `dom`.
    pub terminal_renderer: String,
    pub terminal_font_size: f64,
    pub terminal_font_family: String,
    /// Draw the font's ligatures in terminals (see docs/terminals.md).
    pub terminal_font_ligatures: bool,
    /// Combining marks allowed per character; a longer run is dropped whole (0: no limit). See
    /// docs/terminals.md.
    pub terminal_max_combining: usize,
    /// The file viewer's and the diff view's font, apart from the terminal's.
    pub file_font_size: f64,
    pub file_font_family: String,
    /// Draw the font's ligatures (`=>`, `!=`…) in the file viewer and the diff view.
    pub file_font_ligatures: bool,
    /// The editor files open in: a known editor's id (`"vscode"`, `"zed"`…), or a command with
    /// `{file}`, `{line}` and `{column}` placeholders. Unset: the first known editor installed. See
    /// docs/settings.md and editors.rs.
    pub editor: Option<crate::editors::EditorSetting>,
    /// Start Claude Code with a hook that reports when it waits for approval (see agents.rs).
    pub agent_hooks: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Agent {
    pub name: String,
    pub command: Vec<String>,
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
            agents: vec![
                Agent {
                    name: "Claude Code".into(),
                    command: vec!["claude".into()],
                },
                Agent {
                    name: "Codex".into(),
                    command: vec!["codex".into()],
                },
                Agent {
                    name: "OpenCode".into(),
                    command: vec!["opencode".into()],
                },
                Agent {
                    name: "Pi".into(),
                    command: vec!["pi".into()],
                },
            ],
            terminal_scrollback: 1000,
            terminal_renderer: "webgl".into(),
            terminal_font_size: if cfg!(target_os = "macos") {
                12.0
            } else {
                14.0
            },
            terminal_font_family: "Menlo, Consolas, 'DejaVu Sans Mono', monospace".into(),
            terminal_font_ligatures: false,
            terminal_max_combining: 4,
            file_font_size: 12.0,
            file_font_family: "Menlo, Consolas, 'DejaVu Sans Mono', monospace".into(),
            file_font_ligatures: false,
            editor: None,
            agent_hooks: true,
        }
    }
}

/// `~/Library/Application Support/Gako`, `%APPDATA%\Gako` or `~/.config/gako`.
pub fn user_file() -> Option<PathBuf> {
    let name = if cfg!(any(target_os = "macos", windows)) {
        "Gako"
    } else {
        "gako"
    };
    dirs::config_dir().map(|d| d.join(name).join("settings.json"))
}

fn read(path: &Path) -> Result<Option<Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).with_context(|| format!("{}", path.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("{}", path.display())),
    }
}

/// The user's settings file, over the defaults; the defaults alone if there's no file.
pub fn load(user: Option<&Path>) -> Result<Settings> {
    let value = match user.map(read).transpose()?.flatten() {
        Some(v) => v,
        None => serde_json::to_value(Settings::default())?,
    };
    let mut settings: Settings = serde_json::from_value(value).context("settings")?;
    settings.max_git_processes = settings.max_git_processes.max(1);
    Ok(settings)
}

pub struct Watcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

/// Calls `changed` with the file's settings, or why they can't be read, each time `path` is
/// written, replaced or deleted (deleted: the defaults). Its folder is watched rather than the file,
/// since editors often save by renaming a new file over the old one; it's created if it's missing,
/// so a settings file made later is seen too.
pub fn watch(
    path: PathBuf,
    changed: impl Fn(Result<Settings>) + Send + 'static,
) -> Result<Watcher> {
    let dir = path.parent().context("the settings file has no folder")?;
    std::fs::create_dir_all(dir).with_context(|| format!("{}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_os_string());
    let file = path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            if events
                .iter()
                .flat_map(|e| &e.event.paths)
                .any(|p| p.file_name() == name.as_deref())
            {
                changed(load(Some(&file)));
            }
        },
    )?;
    debouncer.watch(dir, RecursiveMode::NonRecursive)?;
    Ok(Watcher {
        _debouncer: debouncer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_user_file_overrides_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.json");
        std::fs::write(&user, r#"{"scanDepth": 4, "maxGitProcesses": 8}"#).unwrap();
        let s = load(Some(&user)).unwrap();
        assert_eq!(s.scan_depth, 4);
        assert_eq!(s.max_git_processes, 8);
        assert_eq!(s.debounce_ms, Settings::default().debounce_ms);
    }

    #[test]
    fn edits_are_seen_and_bad_ones_reported() {
        let dir = tempfile::tempdir().unwrap();
        // The folder doesn't exist yet: watching creates it.
        let path = dir.path().join("Gako").join("settings.json");
        let (tx, rx) = std::sync::mpsc::channel();
        let _w = watch(path.clone(), move |r| {
            let _ = tx.send(r.map_err(|e| format!("{e:#}")));
        })
        .unwrap();
        let next = || rx.recv_timeout(Duration::from_secs(10)).unwrap();

        std::fs::write(&path, r#"{"scanDepth": 4}"#).unwrap();
        assert_eq!(next().unwrap().scan_depth, 4);

        std::fs::write(&path, r#"{"scanDepth": 4,}"#).unwrap();
        let err = loop {
            match next() {
                Ok(_) => continue, // the write before, seen again
                Err(e) => break e,
            }
        };
        assert!(err.contains("settings.json"), "{err}");

        // Saved by renaming a new file over the old one.
        let tmp = path.with_file_name("settings.json.tmp");
        std::fs::write(&tmp, r#"{"scanDepth": 5}"#).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        while next().map(|s| s.scan_depth) != Ok(5) {}

        std::fs::remove_file(&path).unwrap();
        while next() != Ok(Settings::default()) {}
    }

    #[test]
    fn a_missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(Some(&dir.path().join("none.json"))).unwrap();
        assert_eq!(s, Settings::default());
    }
}
