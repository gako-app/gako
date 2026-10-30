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

//! What Gako adds when it starts an agent: a hook, so the agent bar can tell its states apart, and
//! what it takes to resume the agent's conversation later.
//!
//! Claude Code shows the same title when it has finished a turn and when it waits for approval (see
//! docs/terminals.md), but it runs a Notification hook for the second. So Gako starts `claude` with one more
//! hook, passed with `--settings` (which Claude Code adds to the user's own settings rather than
//! replacing them): it runs `gako-core notify`, which turns the hook's message into a terminal
//! notification (OSC 9). The frontend shows that as "waiting for you". The `agentHooks` setting
//! turns this off.
//!
//! Resuming: Gako starts an agent on a session whose ID it picks, and passes the ID again to resume
//! it when the terminal reopens (the frontend does that; see docs/terminals.md). Claude Code, Pi
//! and OpenCode take an ID to start with, and an agent in the settings can say how it does
//! (`session`, `resume`). Codex picks its own, so Gako learns it: Codex runs a `notify` program
//! after every turn, with the thread's ID, and Gako passes one (`-c notify=…`), `gako-core
//! codex-notify`, which hands the ID to the terminal in a sequence of Gako's own (OSC 6973) and
//! then runs the user's own `notify` program, if their Codex settings name one. The
//! `agentResume` setting turns this off.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;
use serde_json::json;

use crate::settings::{Agent, SessionSetting};

/// How an agent's sessions are started and resumed. `{id}` in the arguments stands for the
/// session's ID, a UUID; they go after the agent's own command.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sessions {
    /// Starts the agent on a session with the ID Gako picks. None: the agent picks it.
    pub session: Option<Vec<String>>,
    /// Resumes the session. None: `session` does.
    pub resume: Option<Vec<String>>,
    /// The agent picks the ID and Gako learns it (Codex, see the module's notes).
    pub learns_id: bool,
}

fn args(a: &[&str]) -> Option<Vec<String>> {
    Some(a.iter().map(|s| s.to_string()).collect())
}

/// The program's name, lower case and without a path or extension: `claude` for
/// `C:\…\claude.exe`.
fn program_name(cmd: &[String]) -> Option<String> {
    Path::new(cmd.first()?)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
}

/// What Gako knows of the sessions of the agent `cmd` runs, whatever the settings say.
pub fn builtin(cmd: &[String]) -> Option<Sessions> {
    let (session, resume, learns_id) = match program_name(cmd)?.as_str() {
        "claude" => (
            args(&["--session-id", "{id}"]),
            args(&["--resume", "{id}"]),
            false,
        ),
        // Both create a session that doesn't exist yet. OpenCode's IDs start with "ses".
        "pi" => (args(&["--session-id", "{id}"]), None, false),
        "opencode" => (args(&["--session", "ses_{id}"]), None, false),
        "codex" => (None, args(&["resume", "{id}"]), true),
        _ => return None,
    };
    Some(Sessions {
        session,
        resume,
        learns_id,
    })
}

/// The programs Gako knows how to resume, by name, with what it knows (for the settings screen).
pub fn known() -> Vec<(&'static str, Sessions)> {
    ["claude", "codex", "opencode", "pi"]
        .into_iter()
        .filter_map(|name| Some((name, builtin(&[name.to_string()])?)))
        .collect()
}

/// How the agent's sessions are started and resumed: as its settings say, or as Gako knows for its
/// program. None: it isn't resumed, which is also the case for a command that already picks a
/// session of its own.
pub fn sessions(agent: &Agent) -> Option<Sessions> {
    let found = match &agent.session {
        Some(SessionSetting::Flag(false)) => return None,
        Some(SessionSetting::Args(session)) => Sessions {
            session: Some(session.clone()),
            resume: agent.resume.clone(),
            learns_id: false,
        },
        _ => {
            let mut known = builtin(&agent.command)?;
            if agent.resume.is_some() {
                known.resume = agent.resume.clone();
            }
            known
        }
    };
    let mut flags: Vec<&str> = vec![
        "--session",
        "--session-id",
        "--resume",
        "-r",
        "--continue",
        "--fork-session",
        "resume",
        "fork",
    ];
    for a in [&found.session, &found.resume].into_iter().flatten() {
        if let Some(first) = a.first() {
            flags.push(first);
        }
    }
    let picks = |arg: &String| flags.contains(&arg.split('=').next().unwrap_or(arg));
    if agent.command.iter().skip(1).any(picks) {
        return None;
    }
    Some(found)
}

/// The command to run for `cmd`: with Gako's hook added for Claude Code (`hooks`), and with its
/// `notify` program for Codex, to learn the session's ID (`resume`).
pub fn adjust(cmd: Vec<String>, hooks: bool, resume: bool) -> Vec<String> {
    match program_name(&cmd).as_deref() {
        Some("claude") if hooks => claude_hook(cmd),
        Some("codex") if resume => codex_notify(cmd, codex_user_notify()),
        _ => cmd,
    }
}

fn claude_hook(cmd: Vec<String>) -> Vec<String> {
    // A command that brings its own --settings is left alone.
    if cmd
        .iter()
        .any(|a| a == "--settings" || a.starts_with("--settings="))
    {
        return cmd;
    }
    let Ok(exe) = std::env::current_exe() else {
        return cmd;
    };
    let program = cmd[0].clone();
    let settings = json!({
        "hooks": {"Notification": [{"hooks": [{"type": "command", "command": format!("{} notify", quote(&exe))}]}]}
    });
    let mut out = vec![program, "--settings".into(), settings.to_string()];
    out.extend(cmd.into_iter().skip(1));
    out
}

/// Codex with `gako-core codex-notify` as its `notify` program, passing it the user's own (`user`)
/// to run after. A command that sets `notify` itself is left alone.
fn codex_notify(cmd: Vec<String>, user: Vec<String>) -> Vec<String> {
    let sets_notify = cmd
        .windows(2)
        .any(|w| (w[0] == "-c" || w[0] == "--config") && w[1].trim_start().starts_with("notify"))
        || cmd
            .iter()
            .any(|a| a.starts_with("--config=notify") || a.starts_with("-cnotify"));
    if sets_notify {
        return cmd;
    }
    let Ok(exe) = std::env::current_exe() else {
        return cmd;
    };
    let mut notify = vec![exe.to_string_lossy().into_owned(), "codex-notify".into()];
    notify.extend(user);
    // A JSON array of strings is also a TOML one, which is how Codex reads the value.
    let value = format!("notify={}", serde_json::Value::from(notify));
    let mut out = vec![cmd[0].clone(), "-c".into(), value];
    out.extend(cmd.into_iter().skip(1));
    out
}

/// The `notify` program in the user's Codex settings (`$CODEX_HOME/config.toml`, by default in
/// `~/.codex`), with its arguments; empty if there's none.
fn codex_user_notify() -> Vec<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")));
    let Some(text) = home.and_then(|h| std::fs::read_to_string(h.join("config.toml")).ok()) else {
        return Vec::new();
    };
    read_notify(&text)
}

fn read_notify(config: &str) -> Vec<String> {
    let Ok(table) = config.parse::<toml::Table>() else {
        return Vec::new();
    };
    match table.get("notify") {
        Some(toml::Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// `gako-core codex-notify [program args…] <json>`: run by Codex after a turn, with the event's
/// JSON last. Hands the thread's ID to the terminal (OSC 6973, `session=<id>`), then runs the
/// user's own `notify` program, if one was passed, with the same JSON.
pub fn codex_notify_main() -> Result<()> {
    let mut rest: Vec<String> = std::env::args().skip(2).collect();
    let Some(event) = rest.pop() else {
        return Ok(());
    };
    let parsed: serde_json::Value = serde_json::from_str(&event).unwrap_or_default();
    if let Some(id) = conversation(&parsed) {
        write_tty(&format!("\x1b]6973;session={id}\x07"));
    }
    if let Some((program, args)) = rest.split_first() {
        // Not waited for: Codex doesn't wait for its notify program either.
        let _ = std::process::Command::new(program)
            .args(args)
            .arg(&event)
            .spawn();
    }
    Ok(())
}

/// The conversation a `notify` event is about: its thread, unless the turn was the one Codex runs
/// on a thread of its own to title the conversation, whose answer is `{"title": …}`.
fn conversation(event: &serde_json::Value) -> Option<&str> {
    let answer = event["last-assistant-message"].as_str().unwrap_or("");
    let titling = serde_json::from_str::<serde_json::Value>(answer)
        .ok()
        .and_then(|v| {
            v.as_object()
                .map(|o| o.len() == 1 && o.contains_key("title"))
        })
        .unwrap_or(false);
    if event["type"] != "agent-turn-complete" || titling {
        return None;
    }
    event["thread-id"].as_str().filter(|id| session_id(id))
}

/// An ID safe to put in a terminal sequence.
fn session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Quotes a path for the shell Claude Code runs hooks with.
fn quote(path: &Path) -> String {
    let p = path.to_string_lossy();
    if cfg!(windows) {
        format!("\"{p}\"")
    } else {
        format!("'{}'", p.replace('\'', r"'\''"))
    }
}

/// `gako-core notify`: reads a Claude Code hook's JSON on stdin and writes its message to the
/// terminal as an OSC 9 notification.
pub fn notify_main() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let event: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();
    let message = event["message"]
        .as_str()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("Claude Code needs you");
    write_tty(&format!("\x1b]9;{}\x07", clean(message)));
    Ok(())
}

/// Writes a sequence to the terminal the agent runs in. Hooks run detached, without a controlling
/// terminal, so it goes to the device the core named in `GAKO_TTY`; the sequence then comes out of
/// the terminal like the agent's own output.
fn write_tty(sequence: &str) {
    let path = std::env::var_os("GAKO_TTY")
        .unwrap_or_else(|| (if cfg!(windows) { "CONOUT$" } else { "/dev/tty" }).into());
    // Best effort: without a terminal (the agent run elsewhere) there's nobody to tell, and a
    // failing hook would only show up as an error in the agent.
    if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = tty.write_all(sequence.as_bytes());
    }
}

/// A message without control characters, which would end or break the sequence.
fn clean(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_gets_the_notification_hook() {
        let cmd = adjust(v(&["claude", "--verbose"]), true, true);
        assert_eq!(cmd[0], "claude");
        assert_eq!(cmd[1], "--settings");
        let settings: serde_json::Value = serde_json::from_str(&cmd[2]).unwrap();
        let hook = settings["hooks"]["Notification"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(hook.ends_with(" notify"), "{hook}");
        assert_eq!(&cmd[3..], &v(&["--verbose"])[..]);
        // Also by full path.
        assert_eq!(
            adjust(v(&["/usr/local/bin/claude"]), true, true)[1],
            "--settings"
        );
        // Not with the hooks turned off.
        assert_eq!(adjust(v(&["claude"]), false, true), v(&["claude"]));
    }

    #[test]
    fn other_programs_and_own_settings_are_left_alone() {
        assert_eq!(adjust(v(&["aider"]), true, true), v(&["aider"]));
        assert_eq!(adjust(v(&["codex"]), true, false), v(&["codex"]));
        assert_eq!(
            adjust(v(&["claude", "--settings", "x.json"]), true, true),
            v(&["claude", "--settings", "x.json"])
        );
        assert_eq!(adjust(v(&[]), true, true), v(&[]));
    }

    #[test]
    fn codex_gets_the_notify_program_and_keeps_the_users() {
        let cmd = codex_notify(
            v(&["codex", "-m", "o3"]),
            v(&["/apps/My Notifier", "turn-ended"]),
        );
        assert_eq!(cmd[0], "codex");
        assert_eq!(cmd[1], "-c");
        let value: toml::Table = cmd[2].parse().unwrap();
        let notify: Vec<&str> = value["notify"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert!(
            notify[0].ends_with(
                std::env::current_exe()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
        );
        assert_eq!(
            &notify[1..],
            &["codex-notify", "/apps/My Notifier", "turn-ended"]
        );
        assert_eq!(&cmd[3..], &v(&["-m", "o3"])[..]);
        // A notify of the command's own wins.
        let own = v(&["codex", "-c", "notify=[\"x\"]"]);
        assert_eq!(codex_notify(own.clone(), Vec::new()), own);
    }

    #[test]
    fn the_users_codex_notify_is_read_from_its_settings() {
        let config = "model = \"o3\"\nnotify = [\"/apps/n\", 'turn-ended']\n[profiles.x]\nnotify = [\"no\"]\n";
        assert_eq!(read_notify(config), v(&["/apps/n", "turn-ended"]));
        assert_eq!(read_notify("model = \"o3\""), Vec::<String>::new());
        assert_eq!(read_notify("not toml ["), Vec::<String>::new());
    }

    fn agent(command: &[&str]) -> Agent {
        Agent {
            name: "A".into(),
            command: v(command),
            ..Default::default()
        }
    }

    #[test]
    fn known_agents_resume_without_settings() {
        let claude = sessions(&agent(&["claude", "--model", "x"])).unwrap();
        assert_eq!(claude.session, Some(v(&["--session-id", "{id}"])));
        assert_eq!(claude.resume, Some(v(&["--resume", "{id}"])));
        let opencode = sessions(&agent(&["/bin/opencode"])).unwrap();
        assert_eq!(opencode.session, Some(v(&["--session", "ses_{id}"])));
        assert_eq!(opencode.resume, None);
        let codex = sessions(&agent(&["codex"])).unwrap();
        assert!(codex.learns_id && codex.session.is_none());
        assert_eq!(sessions(&agent(&["aider"])), None);
        assert_eq!(known().len(), 4);
    }

    #[test]
    fn settings_say_how_an_agent_resumes_or_that_it_doesnt() {
        let mut own = agent(&["myagent"]);
        own.session = Some(SessionSetting::Args(v(&["--id", "{id}"])));
        own.resume = Some(v(&["--back", "{id}"]));
        let s = sessions(&own).unwrap();
        assert_eq!(
            (s.session, s.resume),
            (Some(v(&["--id", "{id}"])), Some(v(&["--back", "{id}"])))
        );
        let mut off = agent(&["claude"]);
        off.session = Some(SessionSetting::Flag(false));
        assert_eq!(sessions(&off), None);
        let mut on = agent(&["pi"]);
        on.session = Some(SessionSetting::Flag(true));
        assert!(sessions(&on).is_some());
    }

    #[test]
    fn a_command_that_picks_its_session_is_left_alone() {
        assert_eq!(sessions(&agent(&["claude", "--continue"])), None);
        assert_eq!(sessions(&agent(&["claude", "--resume=abc"])), None);
        assert_eq!(sessions(&agent(&["codex", "resume", "--last"])), None);
        let mut own = agent(&["myagent", "--id", "x"]);
        own.session = Some(SessionSetting::Args(v(&["--id", "{id}"])));
        assert_eq!(sessions(&own), None);
    }

    #[test]
    fn codex_turns_name_their_conversation_but_titling_doesnt() {
        let turn = json!({"type": "agent-turn-complete", "thread-id": "01a18a1f-a726", "last-assistant-message": "fig"});
        assert_eq!(conversation(&turn), Some("01a18a1f-a726"));
        let title = json!({"type": "agent-turn-complete", "thread-id": "01a18a1f-adb2", "last-assistant-message": "{\"title\":\"Reply with fig\"}"});
        assert_eq!(conversation(&title), None);
        let other = json!({"type": "approval-requested", "thread-id": "01a18a1f-a726"});
        assert_eq!(conversation(&other), None);
    }

    #[test]
    fn session_ids_are_safe_in_a_sequence() {
        assert!(session_id("01a0c98b-49ce-7801-aed9-cd3ffa690085"));
        assert!(!session_id("x\x07y"));
        assert!(!session_id(""));
    }

    #[test]
    fn messages_lose_control_characters() {
        assert_eq!(
            clean("needs\x07 your\npermission"),
            "needs  your permission"
        );
    }

    #[test]
    fn paths_are_quoted_for_the_shell() {
        if !cfg!(windows) {
            assert_eq!(
                quote(Path::new("/a b/it's/gako-core")),
                r"'/a b/it'\''s/gako-core'"
            );
        }
    }
}
