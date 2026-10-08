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

//! Opening files in the user's editor.
//!
//! Gako never edits; "open in editor" hands the file to an editor at a line. The editors it knows
//! are found on the PATH or, failing that, where their installers put them: an editor's command-line
//! tool is often not on the PATH (VS Code's `code` needs a menu command on macOS, for one), and the
//! operating system's "open with the default app" is no substitute, since it ignores the line and
//! sends each file type to a different app. Any other editor can be set as a command in the
//! settings.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The `editor` setting: one of the known editors by id (`"zed"`), or a command line with `{file}`,
/// `{line}` and `{column}` placeholders.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum EditorSetting {
    Known(String),
    Command(Vec<String>),
}

/// An editor Gako knows how to find and how to open at a line.
struct Known {
    id: &'static str,
    name: &'static str,
    /// The command-line tool's name on the PATH.
    cli: &'static str,
    /// macOS: app bundle names, and the tool's path inside the bundle.
    mac_apps: &'static [&'static str],
    mac_tool: &'static str,
    /// Windows: (environment variable, path under it).
    windows: &'static [(&'static str, &'static str)],
    linux: &'static [&'static str],
    /// Arguments to open a file at a line.
    file: &'static [&'static str],
}

// The macOS locations are checked; the Windows and Linux ones are the installers' documented defaults,
// to be confirmed in the Windows and Linux pass.

const VSCODE_FILE: &[&str] = &["-g", "{file}:{line}:{column}"];

const KNOWN: &[Known] = &[
    Known {
        id: "vscode",
        name: "VS Code",
        cli: "code",
        mac_apps: &["Visual Studio Code.app"],
        mac_tool: "Contents/Resources/app/bin/code",
        windows: &[
            ("LOCALAPPDATA", r"Programs\Microsoft VS Code\bin\code.cmd"),
            ("ProgramFiles", r"Microsoft VS Code\bin\code.cmd"),
        ],
        linux: &["/usr/share/code/bin/code", "/snap/bin/code"],
        file: VSCODE_FILE,
    },
    Known {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        cli: "code-insiders",
        mac_apps: &["Visual Studio Code - Insiders.app"],
        mac_tool: "Contents/Resources/app/bin/code",
        windows: &[
            (
                "LOCALAPPDATA",
                r"Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
            ),
            (
                "ProgramFiles",
                r"Microsoft VS Code Insiders\bin\code-insiders.cmd",
            ),
        ],
        linux: &[
            "/usr/share/code-insiders/bin/code-insiders",
            "/snap/bin/code-insiders",
        ],
        file: VSCODE_FILE,
    },
    Known {
        id: "vscodium",
        name: "VSCodium",
        cli: "codium",
        mac_apps: &["VSCodium.app"],
        mac_tool: "Contents/Resources/app/bin/codium",
        windows: &[
            ("LOCALAPPDATA", r"Programs\VSCodium\bin\codium.cmd"),
            ("ProgramFiles", r"VSCodium\bin\codium.cmd"),
        ],
        linux: &["/usr/share/codium/bin/codium", "/snap/bin/codium"],
        file: VSCODE_FILE,
    },
    Known {
        id: "cursor",
        name: "Cursor",
        cli: "cursor",
        mac_apps: &["Cursor.app"],
        mac_tool: "Contents/Resources/app/bin/cursor",
        windows: &[(
            "LOCALAPPDATA",
            r"Programs\cursor\resources\app\bin\cursor.cmd",
        )],
        linux: &["/usr/share/cursor/bin/cursor"],
        file: VSCODE_FILE,
    },
    Known {
        id: "windsurf",
        name: "Windsurf",
        cli: "windsurf",
        mac_apps: &["Windsurf.app"],
        mac_tool: "Contents/Resources/app/bin/windsurf",
        windows: &[("LOCALAPPDATA", r"Programs\Windsurf\bin\windsurf.cmd")],
        linux: &["/usr/share/windsurf/bin/windsurf"],
        file: VSCODE_FILE,
    },
    Known {
        id: "zed",
        name: "Zed",
        cli: "zed",
        mac_apps: &["Zed.app"],
        mac_tool: "Contents/MacOS/cli",
        windows: &[("LOCALAPPDATA", r"Programs\Zed\bin\zed.exe")],
        linux: &["~/.local/bin/zed"],
        file: &["{file}:{line}:{column}"],
    },
    Known {
        id: "sublime",
        name: "Sublime Text",
        cli: "subl",
        mac_apps: &["Sublime Text.app"],
        mac_tool: "Contents/SharedSupport/bin/subl",
        windows: &[("ProgramFiles", r"Sublime Text\subl.exe")],
        linux: &["/opt/sublime_text/sublime_text"],
        file: &["{file}:{line}:{column}"],
    },
];

/// An editor found on this machine.
#[derive(Clone, Debug, Serialize)]
pub struct Found {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    program: PathBuf,
    #[serde(skip)]
    file: Vec<String>,
}

/// The known editors installed here, in the order above.
pub fn detect() -> Vec<Found> {
    KNOWN
        .iter()
        .filter_map(|k| {
            let program = crate::shellenv::which(k.cli).or_else(|| installed(k))?;
            Some(Found {
                id: k.id.into(),
                name: k.name.into(),
                program,
                file: k.file.iter().map(|s| s.to_string()).collect(),
            })
        })
        .collect()
}

fn installed(k: &Known) -> Option<PathBuf> {
    let home = dirs::home_dir();
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        let roots = [
            Some(PathBuf::from("/Applications")),
            home.map(|h| h.join("Applications")),
        ];
        roots
            .into_iter()
            .flatten()
            .flat_map(|r| k.mac_apps.iter().map(move |a| r.join(a).join(k.mac_tool)))
            .collect()
    } else if cfg!(windows) {
        k.windows
            .iter()
            .filter_map(|(var, rel)| std::env::var_os(var).map(|v| PathBuf::from(v).join(rel)))
            .collect()
    } else {
        k.linux
            .iter()
            .filter_map(|p| match p.strip_prefix("~/") {
                Some(rest) => home.as_ref().map(|h| h.join(rest)),
                None => Some(PathBuf::from(p)),
            })
            .collect()
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// The editors to offer: those found, plus the settings' own command if there is one (as
/// `custom`), and which one to use when the user hasn't picked.
/// Every editor Gako knows, installed or not: its id and name.
pub fn known() -> Vec<(&'static str, &'static str)> {
    KNOWN.iter().map(|k| (k.id, k.name)).collect()
}

pub fn offered(setting: Option<&EditorSetting>) -> (Vec<Found>, Option<String>) {
    let mut found = detect();
    if let Some(EditorSetting::Command(cmd)) = setting
        && let Some(program) = cmd.first()
    {
        let name = Path::new(program)
            .file_name()
            .map_or(program.clone(), |n| n.to_string_lossy().into_owned());
        found.insert(
            0,
            Found {
                id: "custom".into(),
                name,
                program: PathBuf::from(program),
                file: cmd[1..].to_vec(),
            },
        );
    }
    // An editor named in the settings but not installed is reported when it's used, not swapped
    // for another one.
    let default = match setting {
        Some(EditorSetting::Known(id)) => found.iter().any(|f| &f.id == id).then(|| id.clone()),
        _ => found.first().map(|f| f.id.clone()),
    };
    (found, default)
}

/// The command that opens `path` in the editor `choice` (or the default one): at `line` and
/// `column` for a file, or just the folder.
pub fn command(
    setting: Option<&EditorSetting>,
    choice: Option<&str>,
    path: &Path,
    line: u32,
    column: u32,
) -> Result<Vec<String>> {
    let (found, default) = offered(setting);
    let id = choice.map(str::to_string).or(default);
    let Some(editor) = id.and_then(|id| found.into_iter().find(|f| f.id == id)) else {
        if let Some(EditorSetting::Known(id)) = setting {
            bail!(
                "the editor \"{id}\" set in settings.json isn't installed (or isn't one Gako knows)"
            );
        }
        bail!(
            "no editor found: install VS Code, Zed, Cursor or Sublime Text, or set \"editor\" in settings.json to the command that opens one"
        );
    };
    Ok(fill(&editor.program, &editor.file, path, line, column))
}

fn fill(program: &Path, args: &[String], path: &Path, line: u32, column: u32) -> Vec<String> {
    let file = path.to_string_lossy();
    let mut cmd = vec![program.to_string_lossy().into_owned()];
    if path.is_dir() {
        // A folder has no line: only the path, without the arguments that place the cursor.
        cmd.push(file.into_owned());
        return cmd;
    }
    cmd.extend(args.iter().map(|a| {
        a.replace("{file}", &file)
            .replace("{line}", &line.max(1).to_string())
            .replace("{column}", &column.max(1).to_string())
    }));
    cmd
}

/// Starts the editor and doesn't wait for it (a thread reaps it when it exits).
pub fn spawn(cmd: &[String]) -> Result<()> {
    let Some((program, args)) = cmd.split_first() else {
        bail!("the editor command is empty")
    };
    let resolved = crate::shellenv::which(program).unwrap_or_else(|| PathBuf::from(program));
    let mut child = std::process::Command::new(resolved)
        .args(args)
        .envs(crate::shellenv::get())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_placeholders_for_files() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("a.rs");
        std::fs::write(&f, "").unwrap();
        let args: Vec<String> = VSCODE_FILE.iter().map(|s| s.to_string()).collect();
        let cmd = fill(Path::new("/bin/code"), &args, &f, 12, 0);
        assert_eq!(
            cmd,
            vec![
                "/bin/code".to_string(),
                "-g".into(),
                format!("{}:12:1", f.display())
            ]
        );
    }

    #[test]
    fn folders_open_without_a_line() {
        let t = tempfile::tempdir().unwrap();
        let args: Vec<String> = VSCODE_FILE.iter().map(|s| s.to_string()).collect();
        let cmd = fill(Path::new("/bin/code"), &args, t.path(), 12, 3);
        assert_eq!(
            cmd,
            vec!["/bin/code".to_string(), t.path().display().to_string()]
        );
    }

    #[test]
    fn a_custom_command_comes_first_and_is_the_default() {
        let setting = EditorSetting::Command(vec![
            "/opt/ed/bin/ed".into(),
            "+{line}".into(),
            "{file}".into(),
        ]);
        let (found, default) = offered(Some(&setting));
        assert_eq!(found[0].id, "custom");
        assert_eq!(found[0].name, "ed");
        assert_eq!(default.as_deref(), Some("custom"));
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("x");
        std::fs::write(&f, "").unwrap();
        let cmd = command(Some(&setting), None, &f, 7, 2).unwrap();
        assert_eq!(
            cmd,
            vec![
                "/opt/ed/bin/ed".to_string(),
                "+7".into(),
                f.display().to_string()
            ]
        );
    }

    #[test]
    fn an_unknown_editor_id_is_an_error() {
        let setting = EditorSetting::Known("no-such-editor".into());
        let err = command(Some(&setting), None, Path::new("/x"), 1, 1)
            .unwrap_err()
            .to_string();
        assert!(err.contains("no-such-editor"), "{err}");
    }

    #[test]
    fn the_setting_reads_as_an_id_or_a_command() {
        let id: EditorSetting = serde_json::from_str("\"zed\"").unwrap();
        assert_eq!(id, EditorSetting::Known("zed".into()));
        let cmd: EditorSetting =
            serde_json::from_str("[\"code\", \"-g\", \"{file}:{line}\"]").unwrap();
        assert_eq!(
            cmd,
            EditorSetting::Command(vec!["code".into(), "-g".into(), "{file}:{line}".into()])
        );
    }
}
