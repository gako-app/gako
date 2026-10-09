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
use serde_json::{Map, Value};

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
    /// Copy a terminal's text to the clipboard as soon as it's selected with the mouse.
    pub terminal_copy_on_select: bool,
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
            terminal_scrollback: 10_000,
            terminal_renderer: "webgl".into(),
            terminal_font_size: if cfg!(target_os = "macos") {
                12.0
            } else {
                14.0
            },
            terminal_font_family: "Menlo, Consolas, 'DejaVu Sans Mono', monospace".into(),
            terminal_font_ligatures: false,
            terminal_max_combining: 4,
            terminal_copy_on_select: false,
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

/// Saves `changes` into the settings file at `path`, and returns the settings it now holds. A key
/// set to null or to its default is taken out, so the file names only what differs and a later
/// change of default still applies. Every other key stays as it was, ones Gako doesn't know
/// included, in the file's order. The file is replaced in one step (a new file renamed over it),
/// through a symbolic link if it's one. A file that can't be read is left alone: it says why.
pub fn save(path: &Path, changes: &Map<String, Value>) -> Result<Settings> {
    let defaults = match serde_json::to_value(Settings::default())? {
        Value::Object(m) => m,
        _ => unreachable!("settings are an object"),
    };
    let existed = path.exists();
    let mut file = match read(path)? {
        Some(Value::Object(m)) => m,
        Some(_) => anyhow::bail!("{}: not a JSON object", path.display()),
        None => Map::new(),
    };
    for (key, value) in changes {
        let Some(default) = defaults.get(key) else {
            anyhow::bail!("{key}: not a setting");
        };
        // Checked one by one, so an error names its setting. Null is the default, whatever the type.
        if !value.is_null() {
            let mut one = Map::new();
            one.insert(key.clone(), value.clone());
            serde_json::from_value::<Settings>(Value::Object(one)).with_context(|| key.clone())?;
        }
        // 12 and 12.0 are the same font size.
        let same = match (value.as_f64(), default.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => value == default,
        };
        if value.is_null() || same {
            file.shift_remove(key);
        } else {
            file.insert(key.clone(), value.clone());
        }
    }
    let settings = serde_json::from_value::<Settings>(Value::Object(file.clone()))?;
    if existed || !file.is_empty() {
        let target = if existed {
            std::fs::canonicalize(path).with_context(|| format!("{}", path.display()))?
        } else {
            let dir = path.parent().context("the settings file has no folder")?;
            std::fs::create_dir_all(dir).with_context(|| format!("{}", dir.display()))?;
            path.to_path_buf()
        };
        let mut name = target.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        let tmp = target.with_file_name(name);
        let text = serde_json::to_string_pretty(&Value::Object(file))? + "\n";
        std::fs::write(&tmp, text).with_context(|| format!("{}", tmp.display()))?;
        std::fs::rename(&tmp, &target).with_context(|| format!("{}", target.display()))?;
    }
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

    fn changes(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn saving_keeps_other_keys_and_drops_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"zKey": 1, "scanDepth": 3, "editor": "zed", "terminalFontSize": 16}"#,
        )
        .unwrap();
        let s = save(
            &path,
            &changes(serde_json::json!({
                "scanDepth": 2,          // the default: taken out
                "editor": null,          // taken out
                "agentHooks": null,      // not in the file: nothing to take out
                "terminalFontSize": 15,  // changed in place
                "fileFontSize": 12,      // the default, 12.0
                "fileFontLigatures": true,
            })),
        )
        .unwrap();
        assert!(s.file_font_ligatures);
        assert_eq!(s.terminal_font_size, 15.0);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "{\n  \"zKey\": 1,\n  \"terminalFontSize\": 15,\n  \"fileFontLigatures\": true\n}\n"
        );
        assert_eq!(load(Some(&path)).unwrap(), s);
    }

    #[test]
    fn saving_refuses_bad_values_and_bad_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let err = save(&path, &changes(serde_json::json!({"scanDepth": "deep"}))).unwrap_err();
        assert!(format!("{err:#}").starts_with("scanDepth: "), "{err:#}");
        let err = save(&path, &changes(serde_json::json!({"colour": "red"}))).unwrap_err();
        assert_eq!(format!("{err:#}"), "colour: not a setting");
        assert!(!path.exists());

        std::fs::write(&path, "{,}").unwrap();
        assert!(save(&path, &changes(serde_json::json!({"scanDepth": 3}))).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{,}");

        // Nothing to save into a file that isn't there: none is made.
        let other = dir.path().join("new").join("settings.json");
        save(&other, &changes(serde_json::json!({"scanDepth": 2}))).unwrap();
        assert!(!other.exists());
    }

    #[cfg(unix)]
    #[test]
    fn saving_writes_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("dotfiles-settings.json");
        let link = dir.path().join("settings.json");
        std::fs::write(&real, "{}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        save(&link, &changes(serde_json::json!({"scanDepth": 3}))).unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::read_to_string(&real)
                .unwrap()
                .contains("\"scanDepth\": 3")
        );
    }

    #[test]
    fn a_missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(Some(&dir.path().join("none.json"))).unwrap();
        assert_eq!(s, Settings::default());
    }
}
