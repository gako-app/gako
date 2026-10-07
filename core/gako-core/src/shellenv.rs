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

//! The user's login-shell environment.
//!
//! An app started from the Dock, Finder or a desktop launcher gets a minimal environment, without
//! the PATH that `.zprofile`, `.zshrc` or `.bashrc` set up, so `claude` or `codex` wouldn't be
//! found. Like VS Code, the core runs the user's shell once as an interactive login shell and
//! takes the environment it prints. That happens on a background thread at startup; terminals and
//! git wait for it (at most a few seconds) the first time they need it. Windows apps get the user's
//! environment from the system, so there it's skipped.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
static STARTED: std::sync::Once = std::sync::Once::new();
const TIMEOUT: Duration = Duration::from_secs(5);
const MARKER: &str = "__GAKO_SHELL_ENV__";

/// Starts resolving in the background (once; `get` starts it too if nobody has).
pub fn start() {
    STARTED.call_once(|| {
        std::thread::spawn(resolve_into_env);
    });
}

fn resolve_into_env() {
    {
        let env = if cfg!(windows) || std::env::var_os("GAKO_NO_SHELL_ENV").is_some() {
            HashMap::new()
        } else {
            resolve().unwrap_or_default()
        };
        let _ = ENV.set(env);
    }
}

/// The variables to set for programs the core starts: the login shell's environment (empty if it
/// couldn't be read), waiting for it if it's still being resolved.
pub fn get() -> &'static HashMap<String, String> {
    start();
    ENV.wait()
}

fn resolve() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    });
    let script = format!("printf '%s' '{MARKER}'; env -0; printf '%s' '{MARKER}'");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .env("GAKO_RESOLVING_SHELL_ENV", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                eprintln!(
                    "gako-core: reading the login shell's environment took too long; using the app's own"
                );
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = String::from_utf8_lossy(&reader.join().ok()?).into_owned();
    let body = out.split(MARKER).nth(1)?;
    let mut env: HashMap<String, String> = body
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    // Shell-session details that don't belong to the programs Gako starts.
    for k in [
        "GAKO_RESOLVING_SHELL_ENV",
        "SHLVL",
        "PWD",
        "OLDPWD",
        "_",
        "TERM_PROGRAM",
        "TERM_SESSION_ID",
    ] {
        env.remove(k);
    }
    env.retain(|k, _| !k.starts_with("GAKO_"));
    Some(env)
}

/// Finds `program` on the resolved PATH (or the core's own), as a shell would.
pub fn which(program: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(program);
    if p.components().count() > 1 {
        return p.is_file().then(|| p.to_path_buf());
    }
    let path = get()
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())?;
    let exts: Vec<String> = if cfg!(windows) {
        // Only names with one of these extensions run (an extensionless file beside an npm `.cmd`
        // is a script for Git Bash); a name that already has one is tried as it is first.
        let mut exts: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_lowercase())
            .collect();
        let lower = program.to_lowercase();
        if exts
            .iter()
            .any(|e| !e.is_empty() && lower.ends_with(e.as_str()))
        {
            exts.insert(0, String::new());
        }
        exts
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
