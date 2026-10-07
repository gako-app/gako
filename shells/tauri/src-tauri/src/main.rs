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

//! Tauri 2 shell: one window, gako-core as a child process, no app logic.
//!
//! Starts gako-core with a random token, reads the port from its first stdout line, and hands
//! both to the frontend with an initialization script. The frontend never calls Tauri APIs. The
//! core watches its stdin: when this process exits, even by crashing, the pipe closes and the core
//! exits too.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Core {
    child: Child,
    stdin: Option<ChildStdin>,
}

fn find_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.join("docs").join("PLAN.md").is_file() && p.join("core").is_dir())
        .map(Path::to_path_buf)
}

fn start_core(root: &Path, token: &str) -> (Core, u16) {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let bin = std::env::var_os("GAKO_CORE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("core").join("target").join("release").join(format!("gako-core{exe}")));
    let mut cmd = Command::new(&bin);
    cmd.env("GAKO_TOKEN", token)
        .env("GAKO_SHELL_KIND", "tauri")
        .env("GAKO_ROOT", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().unwrap_or_else(|e| panic!("cannot start {}: {e}", bin.display()));
    let stdout = child.stdout.take().expect("core stdout");
    let mut line = String::new();
    std::io::BufReader::new(stdout).read_line(&mut line).expect("core ready line");
    let ready: serde_json::Value = serde_json::from_str(&line).expect("core ready JSON");
    let port = ready["port"].as_u64().expect("core port") as u16;
    let stdin = child.stdin.take();
    (Core { child, stdin }, port)
}

fn stop_core(core: &Mutex<Option<Core>>) {
    let Some(mut core) = core.lock().unwrap().take() else { return };
    // Closing stdin is the normal stop signal; the kill is a fallback.
    drop(core.stdin.take());
    for _ in 0..20 {
        if matches!(core.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = core.child.kill();
    let _ = core.child.wait();
}

fn main() {
    let root = std::env::var_os("GAKO_ROOT")
        .map(PathBuf::from)
        .or_else(find_root)
        .expect("cannot find the repository root; set GAKO_ROOT");
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("random token");
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    let (core, port) = start_core(&root, &token);
    let core = std::sync::Arc::new(Mutex::new(Some(core)));
    let boot = serde_json::json!({
        "url": format!("ws://127.0.0.1:{port}"),
        "token": token,
        "shell": "tauri",
    });

    let app = tauri::Builder::default()
        .setup(move |app| {
            // bench/ sets GAKO_SCENARIO to drive the phase 0 measurement harness.
            let page = if std::env::var_os("GAKO_SCENARIO").is_some() { "bench.html" } else { "index.html" };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("Gako")
                .inner_size(1600.0, 1000.0)
                .initialization_script(format!("window.__GAKO_BOOT__ = {boot};"))
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app");

    let on_exit = core.clone();
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            stop_core(&on_exit);
        }
    });
}
