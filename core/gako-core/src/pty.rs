//! Terminals: one PTY per terminal tab, with backpressure.
//!
//! A reader thread reads PTY output in fixed-size chunks and forwards each chunk as it is, never
//! waiting for a newline. The frontend acknowledges bytes once xterm.js has processed them. When the
//! unacknowledged bytes pass the high-water mark, the reader stops reading until they fall below the
//! low-water mark, so the program writing to the terminal waits, as it would in any real terminal.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Condvar, Mutex};

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct FlowConfig {
    pub high: usize,
    pub low: usize,
    pub chunk: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub cols: u16,
    pub rows: u16,
    /// Program and arguments. The default shell when absent (see `default_shell`).
    pub cmd: Option<Vec<String>>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// What a terminal sends to its connection.
pub enum Event {
    /// Terminal id (4 bytes, big endian) followed by the output bytes.
    Data(Vec<u8>),
    Exit(ExitInfo),
    /// A JSON control message (replies go through the same queue, so they stay in order).
    Text(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub term: u32,
    pub code: Option<u32>,
    pub stats: Stats,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Bytes read from the PTY and forwarded.
    pub bytes: u64,
    /// FNV-1a (32 bit) over every forwarded byte, so the frontend can check nothing was lost.
    pub hash: u32,
    /// Times the reader stopped at the high-water mark.
    pub pauses: u64,
    pub max_unacked: usize,
}

struct FlowState {
    unacked: usize,
    closed: bool,
    stats: Stats,
}

struct Flow {
    config: FlowConfig,
    state: Mutex<FlowState>,
    cv: Condvar,
}

impl Flow {
    /// Records forwarded bytes and blocks while the frontend is too far behind.
    fn forwarded(&self, chunk: &[u8]) {
        let mut s = self.state.lock().unwrap();
        s.unacked += chunk.len();
        s.stats.bytes += chunk.len() as u64;
        s.stats.hash = fnv1a(s.stats.hash, chunk);
        s.stats.max_unacked = s.stats.max_unacked.max(s.unacked);
        if s.unacked > self.config.high {
            s.stats.pauses += 1;
            while s.unacked >= self.config.low && !s.closed {
                s = self.cv.wait(s).unwrap();
            }
        }
    }

    fn ack(&self, n: usize) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(n);
        if s.unacked < self.config.low {
            self.cv.notify_all();
        }
    }

    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cv.notify_all();
    }

    fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    fn stats(&self) -> Stats {
        self.state.lock().unwrap().stats
    }
}

pub const FNV_OFFSET: u32 = 0x811c_9dc5;

pub fn fnv1a(mut hash: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Signals a process group until it's gone: SIGHUP, then SIGTERM, then SIGKILL, with a grace period
/// between them.
#[cfg(unix)]
fn end_group(group: libc::pid_t) {
    use std::time::{Duration, Instant};
    // SAFETY: killpg only sends a signal; signal 0 checks whether any process is left in the group.
    let alive = || unsafe { libc::killpg(group, 0) } == 0;
    for (signal, grace) in [(libc::SIGHUP, 1000), (libc::SIGTERM, 1500)] {
        unsafe { libc::killpg(group, signal) };
        let until = Instant::now() + Duration::from_millis(grace);
        while Instant::now() < until {
            if !alive() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    unsafe { libc::killpg(group, libc::SIGKILL) };
}

/// `GAKO_SHELL` if set; otherwise PowerShell on Windows (VS Code's default there too) and the
/// user's login shell elsewhere.
fn default_shell() -> CommandBuilder {
    match std::env::var_os("GAKO_SHELL") {
        Some(shell) => CommandBuilder::new(shell),
        None if cfg!(windows) => CommandBuilder::new("powershell.exe"),
        None => CommandBuilder::new_default_prog(),
    }
}

/// The program a tab with no command runs, for display.
pub fn default_shell_name() -> String {
    match std::env::var("GAKO_SHELL") {
        Ok(s) => s,
        Err(_) if cfg!(windows) => "powershell.exe".into(),
        Err(_) => std::env::var("SHELL").unwrap_or_else(|_| "sh".into()),
    }
}

pub struct Terminal {
    pub pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    input: Mutex<Option<std_mpsc::Sender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<Flow>,
    start: Mutex<Option<std_mpsc::Sender<()>>>,
    recorder: Option<Arc<Recorder>>,
}

/// With `GAKO_RECORD_DIR` set, each terminal's output and input go to a file there, one JSON line
/// per chunk with its time: `{"ms":12,"out":"…"}` or `{"ms":40,"in":"…"}`. For finding out what
/// agents send to the terminal (titles, bells, notifications), not for normal use.
struct Recorder {
    file: Mutex<std::fs::File>,
    started: std::time::Instant,
}

impl Recorder {
    fn open(id: u32, program: &str) -> Option<Arc<Recorder>> {
        let dir = std::env::var_os("GAKO_RECORD_DIR")?;
        let name = std::path::Path::new(program).file_name().map_or("shell".into(), |n| n.to_string_lossy().into_owned());
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let path = std::path::Path::new(&dir).join(format!("{secs}-{id}-{name}.jsonl"));
        let file = std::fs::create_dir_all(&dir).and_then(|_| std::fs::File::create(&path));
        match file {
            Ok(f) => Some(Arc::new(Recorder { file: Mutex::new(f), started: std::time::Instant::now() })),
            Err(e) => {
                eprintln!("gako-core: can't record to {}: {e}", path.display());
                None
            }
        }
    }

    fn record(&self, key: &str, bytes: &[u8]) {
        let line = serde_json::json!({"ms": self.started.elapsed().as_millis() as u64, key: String::from_utf8_lossy(bytes)});
        let _ = writeln!(self.file.lock().unwrap(), "{line}");
    }
}

impl Terminal {
    pub fn spawn(
        id: u32,
        req: OpenRequest,
        default_cwd: &std::path::Path,
        config: FlowConfig,
        tx: UnboundedSender<Event>,
    ) -> Result<Arc<Terminal>> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: req.rows, cols: req.cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let recorder = Recorder::open(id, req.cmd.as_deref().and_then(|c| c.first()).map_or("shell", |p| p.as_str()));
        let mut cmd = match req.cmd.as_deref() {
            Some([program, args @ ..]) => {
                let mut c = CommandBuilder::new(program);
                c.args(args);
                c
            }
            _ => default_shell(),
        };
        cmd.cwd(req.cwd.as_deref().unwrap_or(default_cwd));
        for (k, v) in crate::shellenv::get() {
            cmd.env(k, v);
        }
        cmd.env_remove("GAKO_TOKEN");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "gako");
        // The terminal's device, for helpers that run without one, such as an agent's hooks (see
        // agents.rs).
        if let Some(tty) = pair.master.tty_name() {
            cmd.env("GAKO_TTY", tty);
        }
        for (k, v) in &req.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).context("spawn")?;
        // The slave must be closed here, or the reader never sees end of file on Unix.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().context("pty reader")?;
        let mut writer = pair.master.take_writer().context("pty writer")?;

        let flow = Arc::new(Flow {
            config,
            state: Mutex::new(FlowState { unacked: 0, closed: false, stats: Stats { hash: FNV_OFFSET, ..Stats::default() } }),
            cv: Condvar::new(),
        });

        let (input_tx, input_rx) = std_mpsc::channel::<Vec<u8>>();
        let (start_tx, start_rx) = std_mpsc::channel::<()>();
        std::thread::Builder::new().name(format!("pty-{id}-in")).spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })?;

        let term = Arc::new(Terminal {
            pid,
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input_tx)),
            killer: Mutex::new(killer),
            flow: flow.clone(),
            start: Mutex::new(Some(start_tx)),
            recorder: recorder.clone(),
        });

        let (status_tx, status_rx) = std_mpsc::channel::<Option<u32>>();
        let waiter_term = term.clone();
        std::thread::Builder::new().name(format!("pty-{id}-wait")).spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let _ = status_tx.send(code);
            // With ConPTY the reader only reaches end of file once the pseudoconsole is closed.
            if cfg!(windows) {
                std::thread::sleep(std::time::Duration::from_millis(250));
                waiter_term.master.lock().unwrap().take();
            }
        })?;

        let chunk_size = config.chunk;
        std::thread::Builder::new().name(format!("pty-{id}-out")).spawn(move || {
            // Output waits until the reply announcing this terminal is queued (see `start`).
            let _ = start_rx.recv();
            let mut buf = vec![0u8; chunk_size];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // Unix PTYs report EIO once the child side is closed.
                    Err(_) => break,
                };
                let mut frame = Vec::with_capacity(4 + n);
                frame.extend_from_slice(&id.to_be_bytes());
                frame.extend_from_slice(&buf[..n]);
                if tx.send(Event::Data(frame)).is_err() {
                    break;
                }
                if let Some(r) = &recorder {
                    r.record("out", &buf[..n]);
                }
                flow.forwarded(&buf[..n]);
                if flow.is_closed() {
                    break;
                }
            }
            // The PTY closes before waiting for the program: on macOS a program can't finish exiting
            // while its terminal still holds output nobody reads, so holding it here would leave both
            // waiting on each other (and the program alive, stuck exiting).
            drop(reader);
            let code = status_rx.recv().ok().flatten();
            let _ = tx.send(Event::Exit(ExitInfo { term: id, code, stats: flow.stats() }));
        })?;

        Ok(term)
    }

    /// Lets the reader forward output. Called once the `termOpen` reply is queued, so the frontend
    /// knows the terminal id before its first bytes arrive.
    pub fn start(&self) {
        if let Some(start) = self.start.lock().unwrap().take() {
            let _ = start.send(());
        }
    }

    pub fn write(&self, bytes: Vec<u8>) {
        if let Some(r) = &self.recorder {
            r.record("in", &bytes);
        }
        if let Some(input) = self.input.lock().unwrap().as_ref() {
            let _ = input.send(bytes);
        }
    }

    pub fn ack(&self, n: usize) {
        self.flow.ack(n);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if let Some(master) = self.master.lock().unwrap().as_ref() {
            master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        }
        Ok(())
    }

    pub fn stats(&self) -> Stats {
        self.flow.stats()
    }

    /// Kills the child and releases the PTY. The reader thread then reports the exit.
    /// Ends the program: SIGHUP first, as a terminal closing does. Some programs ignore it (Claude
    /// Code does) or leave children behind, so on Unix its whole process group then gets SIGTERM
    /// and finally SIGKILL, on a thread that's returned for callers that must wait for it (the
    /// core exiting).
    pub fn close(&self) -> Option<std::thread::JoinHandle<()>> {
        self.start();
        let _ = self.killer.lock().unwrap().kill();
        self.flow.close();
        self.input.lock().unwrap().take();
        self.master.lock().unwrap().take();
        #[cfg(unix)]
        {
            // The program leads its own session, so its process group has its pid.
            let group = self.pid? as libc::pid_t;
            std::thread::Builder::new().name("pty-end".into()).spawn(move || end_group(group)).ok()
        }
        #[cfg(not(unix))]
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// A program that ignores SIGHUP, as Claude Code does, and its child are still ended when
    /// their terminal closes.
    #[test]
    fn closing_ends_programs_that_ignore_sighup() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child");
        let script = format!("trap '' HUP; sleep 60 & echo $! > {}; wait", pid_file.display());
        let req = OpenRequest {
            cols: 80,
            rows: 24,
            cmd: Some(vec!["sh".into(), "-c".into(), script]),
            cwd: None,
            env: BTreeMap::new(),
        };
        let config = FlowConfig { high: 1 << 20, low: 1 << 18, chunk: 4096 };
        let term = Terminal::spawn(1, req, dir.path(), config, tx).unwrap();
        term.start();
        let pid = term.pid.unwrap();
        let started = std::time::Instant::now();
        while !pid_file.exists() && started.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let child: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        assert!(alive(pid) && alive(child));
        term.close().unwrap().join().unwrap();
        // The program is reaped by its waiter thread; give it a moment.
        std::thread::sleep(std::time::Duration::from_millis(200));
        while rx.try_recv().is_ok() {}
        assert!(!alive(child), "the child survived");
        assert!(!alive(pid), "the program survived");
    }

    /// A program that writes a lot as it exits, after the page that read its terminal has gone,
    /// still finishes exiting (on macOS it can't while its unread output is held).
    #[test]
    fn closing_ends_programs_that_write_on_exit() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let script = format!(
            "trap 'head -c 4000000 /dev/zero | tr \\0 x; exit 0' HUP TERM; touch {}; while :; do sleep 1; done",
            ready.display()
        );
        let req = OpenRequest { cols: 80, rows: 24, cmd: Some(vec!["sh".into(), "-c".into(), script]), cwd: None, env: BTreeMap::new() };
        let config = FlowConfig { high: 1 << 20, low: 1 << 18, chunk: 4096 };
        let term = Terminal::spawn(1, req, dir.path(), config, tx).unwrap();
        term.start();
        let pid = term.pid.unwrap();
        let started = std::time::Instant::now();
        while !ready.exists() && started.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        drop(rx);
        let closed = std::time::Instant::now();
        term.close().unwrap().join().unwrap();
        while alive(pid) && closed.elapsed().as_secs() < 6 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!alive(pid), "the program is stuck exiting");
    }
}
