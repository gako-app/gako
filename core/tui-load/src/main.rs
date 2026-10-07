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

//! tui-load: stands in for a coding agent's terminal UI, and dumps files into a terminal.
//!
//! `tui-load run` draws like an agent TUI in the normal screen buffer: a panel at the bottom
//! (spinner, progress, tool box, input line, status line) redrawn about 30 times a second with
//! cursor movement and partial updates, and bursts of streamed text that scroll up into the
//! scrollback above it. Typed input is echoed in the input line straight away.
//!
//! Every streamed line has the form `<seq> <text> #<crc32>`, so a checker can read the terminal's
//! buffer afterwards and tell whether anything was lost or garbled. On exit, the report file holds
//! the last sequence number and the exact text the panel rows must show.
//!
//! `tui-load dump <file>...` writes files to the terminal in fixed-size chunks and prints how long
//! each took. With `--report` or `--report-dir`, the same numbers go to JSON files.

use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PANEL_ROWS: u16 = 8;
const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS: [&str; 40] = [
    "the", "agent", "reads", "src/lib.rs", "and", "updates", "parser", "tests", "→", "✓", "build",
    "passes", "refactor", "handler", "config", "日本語", "retry", "cache", "fn", "struct", "impl",
    "returns", "Result", "error", "async", "await", "commit", "diff", "branch", "merge", "repo",
    "lint", "fmt", "check", "query", "index", "token", "stream", "render", "frame",
];
const COLORS: [u8; 6] = [31, 32, 33, 34, 35, 36];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        Some("dump") => dump(&args[1..]),
        Some("stamp") => stamp(&args[1..]),
        _ => Err("usage: tui-load run [--seconds S] [--seed N] [--fps F] [--report FILE]\n       \
                  tui-load dump FILE... [--delay S] [--pause S] [--report FILE | --report-dir DIR]\n       \
                  tui-load stamp FILE"
            .to_string()),
    };
    if let Err(e) = result {
        eprintln!("tui-load: {e}");
        std::process::exit(2);
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

// --- dump ---------------------------------------------------------------------------------------

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// `dump FILE... [--delay S] [--pause S] [--report FILE | --report-dir DIR]`: writes each file to
/// stdout, waiting `--delay` seconds before the first and `--pause` seconds after each. With
/// `--report-dir`, each file's report is `dump-<file stem>.json`.
fn dump(args: &[String]) -> Result<(), String> {
    let mut files = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i].starts_with("--") {
            i += 2;
        } else {
            files.push(args[i].clone());
            i += 1;
        }
    }
    if files.is_empty() {
        return Err("dump needs a file".into());
    }
    let secs = |name| flag(args, name).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let (delay, pause) = (secs("--delay"), secs("--pause"));
    let report = flag(args, "--report").map(PathBuf::from);
    let report_dir = flag(args, "--report-dir").map(PathBuf::from);

    std::thread::sleep(Duration::from_secs_f64(delay));
    for path in &files {
        let mut file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut out = std::io::stdout().lock();
        let start_epoch = epoch_ms();
        let start = Instant::now();
        let mut bytes = 0u64;
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            bytes += n as u64;
        }
        out.flush().map_err(|e| e.to_string())?;
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        write!(out, "\x1b[0m\r\n[dump] done file={path} bytes={bytes} elapsed_ms={elapsed_ms:.0}\r\n")
            .map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        let json = format!(
            "{{\"file\":{},\"bytes\":{bytes},\"elapsedMs\":{elapsed_ms:.1},\"startEpochMs\":{start_epoch:.0},\
             \"endEpochMs\":{:.0}}}\n",
            json_string(path),
            epoch_ms()
        );
        let target = match (&report, &report_dir) {
            (Some(r), _) if files.len() == 1 => Some(r.clone()),
            (_, Some(dir)) => {
                let stem = std::path::Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("dump");
                Some(dir.join(format!("dump-{stem}.json")))
            }
            _ => None,
        };
        if let Some(target) = target {
            write_report(&target, &json)?;
        }
        std::thread::sleep(Duration::from_secs_f64(pause));
    }
    Ok(())
}

/// `stamp FILE`: writes the current time, so a script can tell when a task started.
fn stamp(args: &[String]) -> Result<(), String> {
    let path = args.first().ok_or("stamp needs a file")?;
    write_report(std::path::Path::new(path), &format!("{{\"epochMs\":{:.0}}}\n", epoch_ms()))
}

// --- run ----------------------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Ui {
    rng: Rng,
    frame: u64,
    seq: u64,
    cols: u16,
    rows: u16,
    input: String,
    started: Instant,
}

impl Ui {
    /// One streamed line: colored on screen, plain `<seq> <text> #<crc>` in the buffer.
    fn stream_line(&mut self, out: &mut Vec<u8>) {
        self.seq += 1;
        let max = (self.cols as usize).saturating_sub(12).clamp(20, 160);
        let mut plain = format!("{:08}", self.seq);
        let mut colored = plain.clone();
        loop {
            let word = WORDS[self.rng.below(WORDS.len() as u64) as usize];
            if display_width(&plain) + 1 + display_width(word) > max {
                break;
            }
            plain.push(' ');
            plain.push_str(word);
            colored.push(' ');
            if self.rng.below(4) == 0 {
                let c = COLORS[self.rng.below(COLORS.len() as u64) as usize];
                colored.push_str(&format!("\x1b[1;{c}m{word}\x1b[0m"));
            } else {
                colored.push_str(word);
            }
        }
        let crc = crc32(plain.as_bytes());
        colored.push_str(&format!(" \x1b[2m#{crc:08x}\x1b[0m\r\n"));
        out.extend_from_slice(colored.as_bytes());
    }

    /// The panel's rows as plain text (what the buffer must show) and with colors.
    fn panel(&self) -> Vec<(String, String)> {
        let w = self.cols as usize;
        let secs = self.started.elapsed().as_secs();
        let spin = SPINNER[(self.frame % SPINNER.len() as u64) as usize];
        let pct = (self.frame * 7) % 101;
        let bar_w = 40usize.min(w.saturating_sub(20));
        let filled = bar_w * pct as usize / 100;
        let bar = format!("{}{}", "█".repeat(filled), "░".repeat(bar_w - filled));
        let file = WORDS[(self.frame / 15 % WORDS.len() as u64) as usize];
        let tail: String = {
            let chars: Vec<char> = self.input.chars().collect();
            chars[chars.len().saturating_sub(40)..].iter().collect()
        };
        let rows = [
            ("─".repeat(w.min(200)), "\x1b[38;5;240m".to_string()),
            (format!("{spin} Working… ({secs}s · frame {})", self.frame), "\x1b[38;5;208m".to_string()),
            (format!("  {bar} {pct:3}%"), "\x1b[32m".to_string()),
            (format!("  ⎿ Reading {file}"), "\x1b[36m".to_string()),
            (format!("  ⎿ {} lines streamed", self.seq), "\x1b[36m".to_string()),
            (format!("  ⎿ cache hits {}", self.frame * 3 % 997), "\x1b[36m".to_string()),
            (format!("> {tail}"), "\x1b[1m".to_string()),
            (format!("tui-load · {}x{} · seq {}", self.cols, self.rows, self.seq), "\x1b[2m".to_string()),
        ];
        rows.into_iter()
            .map(|(plain, sgr)| {
                let plain = truncate_width(&plain, w.saturating_sub(1));
                let colored = format!("{sgr}{plain}\x1b[0m");
                (plain, colored)
            })
            .collect()
    }

    fn panel_top(&self) -> u16 {
        self.rows.saturating_sub(PANEL_ROWS) + 1
    }

    /// Streamed lines (if any) above the panel, then the whole panel.
    fn full_draw(&mut self, out: &mut Vec<u8>, lines: usize) {
        out.extend_from_slice(format!("\x1b[{};1H\x1b[J", self.panel_top()).as_bytes());
        for _ in 0..lines {
            self.stream_line(out);
        }
        self.draw_panel(out);
    }

    fn full_draw_final(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(format!("\x1b[{};1H\x1b[J", self.panel_top()).as_bytes());
        self.draw_panel(out);
    }

    fn draw_panel(&self, out: &mut Vec<u8>) {
        let panel = self.panel();
        for (i, (_, colored)) in panel.iter().enumerate() {
            out.extend_from_slice(colored.as_bytes());
            if i + 1 < panel.len() {
                out.extend_from_slice(b"\r\n");
            }
        }
        self.place_cursor(out, &panel);
    }

    /// Only the rows that change every frame, with absolute cursor moves.
    fn partial_draw(&self, out: &mut Vec<u8>) {
        let top = self.panel_top();
        let panel = self.panel();
        for row in [1usize, 2, 3, 4, 5, 7] {
            out.extend_from_slice(format!("\x1b[{};1H\x1b[K", top + row as u16).as_bytes());
            out.extend_from_slice(panel[row].1.as_bytes());
        }
        self.place_cursor(out, &panel);
    }

    fn input_draw(&self, out: &mut Vec<u8>) {
        let panel = self.panel();
        out.extend_from_slice(format!("\x1b[{};1H\x1b[K", self.panel_top() + 6).as_bytes());
        out.extend_from_slice(panel[6].1.as_bytes());
    }

    fn place_cursor(&self, out: &mut Vec<u8>, panel: &[(String, String)]) {
        let col = display_width(&panel[6].0) + 1;
        out.extend_from_slice(format!("\x1b[{};{}H", self.panel_top() + 6, col).as_bytes());
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let seconds: Option<f64> = flag(args, "--seconds").and_then(|s| s.parse().ok());
    let seed: u64 = flag(args, "--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    let fps: f64 = flag(args, "--fps").and_then(|s| s.parse().ok()).unwrap_or(30.0);
    let report = flag(args, "--report").map(PathBuf::from);

    let (cols, rows) = terminal_size().unwrap_or((80, 24));
    let ui = Arc::new(Mutex::new(Ui {
        rng: Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1),
        frame: 0,
        seq: 0,
        cols,
        rows,
        input: String::new(),
        started: Instant::now(),
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let written = Arc::new(Mutex::new(0u64));

    let raw = crossterm::terminal::enable_raw_mode().is_ok();
    let emit = {
        let written = written.clone();
        move |bytes: &[u8]| {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(bytes);
            let _ = out.flush();
            *written.lock().unwrap() += bytes.len() as u64;
        }
    };

    // Typed input: echo it in the input line immediately, like a real TUI. Ctrl-C quits.
    {
        let ui = ui.clone();
        let stop = stop.clone();
        let emit = emit.clone();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 256];
            while let Ok(n) = stdin.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if buf[..n].contains(&3) {
                    stop.store(true, Ordering::SeqCst);
                    break;
                }
                let mut out = Vec::new();
                {
                    let mut ui = ui.lock().unwrap();
                    for ch in String::from_utf8_lossy(&buf[..n]).chars() {
                        match ch {
                            '\x7f' | '\x08' => {
                                ui.input.pop();
                            }
                            '\r' | '\n' => ui.input.clear(),
                            c if !c.is_control() => ui.input.push(c),
                            _ => {}
                        }
                    }
                    ui.input_draw(&mut out);
                    let panel = ui.panel();
                    ui.place_cursor(&mut out, &panel);
                    emit(&out);
                }
            }
        });
    }

    let frame_time = Duration::from_secs_f64(1.0 / fps);
    let start = Instant::now();
    let mut next = start;
    // A burst streams a few lines per frame for a while, then pauses.
    let mut burst_left = 0u32;
    {
        let mut ui = ui.lock().unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(b"\r\n".repeat(PANEL_ROWS as usize).as_slice());
        ui.full_draw(&mut out, 0);
        emit(&out);
    }
    while !stop.load(Ordering::SeqCst) {
        if seconds.is_some_and(|s| start.elapsed().as_secs_f64() >= s) {
            break;
        }
        let mut out = Vec::new();
        {
            let mut ui = ui.lock().unwrap();
            ui.frame += 1;
            if let Some((c, r)) = terminal_size()
                && (c, r) != (ui.cols, ui.rows)
            {
                ui.cols = c;
                ui.rows = r;
                out.extend_from_slice(b"\x1b[2J");
                ui.full_draw(&mut out, 0);
            }
            if burst_left == 0 && ui.rng.below(20) == 0 {
                burst_left = 5 + ui.rng.below(40) as u32;
            }
            if burst_left > 0 {
                burst_left -= 1;
                let lines = 1 + ui.rng.below(4) as usize;
                ui.full_draw(&mut out, lines);
            } else {
                ui.partial_draw(&mut out);
            }
            // Written under the lock, so a keystroke's echo never interleaves with a frame.
            emit(&out);
        }
        next += frame_time;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }

    // Final frame: the whole panel, so its expected text is exact.
    // Hold the lock until the report is written, so a late keystroke can't change the panel.
    let ui = ui.lock().unwrap();
    let mut out = Vec::new();
    ui.full_draw_final(&mut out);
    emit(&out);
    if raw {
        let _ = crossterm::terminal::disable_raw_mode();
    }
    if let Some(report) = report {
        let panel: Vec<String> = ui.panel().into_iter().map(|(plain, _)| json_string(&plain)).collect();
        let json = format!(
            "{{\"seed\":{seed},\"frames\":{},\"lastSeq\":{},\"cols\":{},\"rows\":{},\"bytes\":{},\
             \"elapsedMs\":{:.1},\"panel\":[{}]}}\n",
            ui.frame,
            ui.seq,
            ui.cols,
            ui.rows,
            *written.lock().unwrap(),
            start.elapsed().as_secs_f64() * 1000.0,
            panel.join(",")
        );
        write_report(&report, &json)?;
    }
    Ok(())
}

/// The terminal's size, or nothing when it reports zero (no terminal, or one with no size yet).
fn terminal_size() -> Option<(u16, u16)> {
    crossterm::terminal::size().ok().filter(|&(c, r)| c > 0 && r > 0)
}

fn display_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

/// Enough of wcwidth for the characters tui-load prints.
fn char_width(c: char) -> usize {
    match c as u32 {
        0x1100..=0x115f | 0x2e80..=0xa4cf | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xff00..=0xff60 => 2,
        _ => 1,
    }
}

fn truncate_width(s: &str, max: usize) -> String {
    let mut w = 0;
    s.chars()
        .take_while(|&c| {
            w += char_width(c);
            w <= max
        })
        .collect()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn write_report(path: &std::path::Path, json: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(path, json).map_err(|e| format!("{}: {e}", path.display()))
}

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
