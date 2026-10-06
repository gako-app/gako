//! gako-core: the Rust core process.
//!
//! Both shells start this binary as a child process. It binds a WebSocket server to 127.0.0.1 on a
//! random port, prints one JSON "ready" line with the port to stdout, and only accepts connections
//! that present the token it was started with (`GAKO_TOKEN`). It exits when its stdin closes, which
//! is how it notices that the parent shell has gone, even after a crash.

mod pty;
mod server;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::pty::FlowConfig;
use crate::server::State;

fn main() -> Result<()> {
    let generated_token = std::env::var("GAKO_TOKEN").is_err();
    let token = match std::env::var("GAKO_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => random_token()?,
    };
    let root = match std::env::var_os("GAKO_ROOT") {
        Some(r) => PathBuf::from(r),
        None => find_root().context("cannot find the repository root; set GAKO_ROOT")?,
    };
    let log_path = match std::env::var_os("GAKO_LOG") {
        Some(p) => PathBuf::from(p),
        None => root.join("bench").join("out").join("logs").join("gako.jsonl"),
    };
    let flow = FlowConfig {
        high: env_usize("GAKO_FLOW_HIGH", 512 * 1024),
        low: env_usize("GAKO_FLOW_LOW", 128 * 1024),
        chunk: env_usize("GAKO_CHUNK", 32 * 1024),
    };
    let port: u16 = std::env::var("GAKO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);

    // Settings and scenario for the frontend: every GAKO_* variable except the token.
    let env: BTreeMap<String, String> = std::env::vars()
        .filter(|(k, _)| k.starts_with("GAKO_") && k != "GAKO_TOKEN")
        .collect();

    let state = Arc::new(State::new(root, token.clone(), &log_path, flow, env)?);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        let port = listener.local_addr()?.port();

        let mut ready = serde_json::json!({
            "gakoCore": "ready",
            "port": port,
            "pid": std::process::id(),
        });
        if generated_token {
            ready["token"] = token.into();
        }
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{ready}")?;
        stdout.flush()?;
        drop(stdout);

        if std::env::var_os("GAKO_NO_STDIN_WATCH").is_none() {
            watch_parent(state.clone());
        }
        tokio::spawn(watch_signals(state.clone()));

        server::serve(listener, state).await
    })
}

/// Exits once stdin reaches end of file: the parent shell closed its end of the pipe or died.
fn watch_parent(state: Arc<State>) {
    std::thread::spawn(move || {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut sink) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        state.shutdown();
        std::process::exit(0);
    });
}

async fn watch_signals(state: Arc<State>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut hup = signal(SignalKind::hangup()).expect("SIGHUP handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            _ = hup.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    state.shutdown();
    std::process::exit(0);
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("getrandom: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Walks up from the executable and the working directory to the folder holding `docs/PLAN.md`.
fn find_root() -> Option<PathBuf> {
    let is_root = |p: &Path| p.join("docs").join("PLAN.md").is_file() && p.join("core").is_dir();
    let starts = [std::env::current_exe().ok(), std::env::current_dir().ok()];
    starts
        .into_iter()
        .flatten()
        .find_map(|start| start.ancestors().find(|p| is_root(p)).map(Path::to_path_buf))
}
