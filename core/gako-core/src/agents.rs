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

//! What Gako adds when it starts an agent, so the agent bar can tell its states apart.
//!
//! Claude Code shows the same title when it has finished a turn and when it waits for approval (see
//! PHASE2.md), but it runs a Notification hook for the second. So Gako starts `claude` with one more
//! hook, passed with `--settings` (which Claude Code adds to the user's own settings rather than
//! replacing them): it runs `gako-core notify`, which turns the hook's message into a terminal
//! notification (OSC 9). The frontend shows that as "waiting for you". The `agentHooks` setting
//! turns this off.

use std::io::{Read, Write};
use std::path::Path;

use anyhow::Result;
use serde_json::json;

/// The command to run for `cmd`, with Gako's hook added for Claude Code.
pub fn adjust(cmd: Vec<String>) -> Vec<String> {
    let Some(program) = cmd.first() else { return cmd };
    let name = Path::new(program).file_stem().map(|s| s.to_string_lossy().to_lowercase());
    // A command that brings its own --settings is left alone.
    if name.as_deref() != Some("claude") || cmd.iter().any(|a| a == "--settings" || a.starts_with("--settings=")) {
        return cmd;
    }
    let Ok(exe) = std::env::current_exe() else { return cmd };
    let settings = json!({
        "hooks": {"Notification": [{"hooks": [{"type": "command", "command": format!("{} notify", quote(&exe))}]}]}
    });
    let mut out = vec![program.clone(), "--settings".into(), settings.to_string()];
    out.extend(cmd.into_iter().skip(1));
    out
}

/// Quotes a path for the shell Claude Code runs hooks with.
fn quote(path: &Path) -> String {
    let p = path.to_string_lossy();
    if cfg!(windows) { format!("\"{p}\"") } else { format!("'{}'", p.replace('\'', r"'\''")) }
}

/// `gako-core notify`: reads a Claude Code hook's JSON on stdin and writes its message to the
/// terminal as an OSC 9 notification. Claude Code runs hooks detached, without a controlling
/// terminal, so it writes to the device the core named in `GAKO_TTY`; the sequence then comes out
/// of the terminal like the agent's own output.
pub fn notify_main() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let event: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();
    let message = event["message"].as_str().filter(|m| !m.trim().is_empty()).unwrap_or("Claude Code needs you");
    let sequence = format!("\x1b]9;{}\x07", clean(message));
    let path = std::env::var_os("GAKO_TTY").unwrap_or_else(|| (if cfg!(windows) { "CONOUT$" } else { "/dev/tty" }).into());
    // Best effort: without a terminal (Claude Code run elsewhere) there's nobody to tell, and a
    // failing hook would only show up as an error in Claude Code.
    if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = tty.write_all(sequence.as_bytes());
    }
    Ok(())
}

/// A message without control characters, which would end or break the sequence.
fn clean(message: &str) -> String {
    message.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_gets_the_notification_hook() {
        let cmd = adjust(v(&["claude", "--model", "opus"]));
        assert_eq!(cmd[0], "claude");
        assert_eq!(cmd[1], "--settings");
        let settings: serde_json::Value = serde_json::from_str(&cmd[2]).unwrap();
        let hook = settings["hooks"]["Notification"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(hook.ends_with(" notify"), "{hook}");
        assert_eq!(&cmd[3..], &v(&["--model", "opus"])[..]);
        // Also by full path.
        assert_eq!(adjust(v(&["/usr/local/bin/claude"]))[1], "--settings");
    }

    #[test]
    fn other_programs_and_own_settings_are_left_alone() {
        assert_eq!(adjust(v(&["codex"])), v(&["codex"]));
        assert_eq!(adjust(v(&["claude", "--settings", "x.json"])), v(&["claude", "--settings", "x.json"]));
        assert_eq!(adjust(v(&[])), v(&[]));
    }

    #[test]
    fn messages_lose_control_characters() {
        assert_eq!(clean("needs\x07 your\npermission"), "needs  your permission");
    }

    #[test]
    fn paths_are_quoted_for_the_shell() {
        if !cfg!(windows) {
            assert_eq!(quote(Path::new("/a b/it's/gako-core")), r"'/a b/it'\''s/gako-core'");
        }
    }
}
