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

//! The WebSocket protocol.
//!
//! One connection carries everything. Text frames are JSON control messages:
//!
//! - `{"t":"req","id":1,"m":"<method>","p":{...}}` → `{"t":"res","id":1,"r":...}` or `{"t":"res","id":1,"e":"..."}`
//! - `{"t":"ack","term":7,"n":4096}`: bytes of terminal 7 that xterm.js has processed
//! - `{"t":"resize","term":7,"cols":200,"rows":50}`, `{"t":"close","term":7}`
//! - `{"t":"log","rec":{...}}`: appends one record to the timing log
//! - from the core: `{"t":"exit","term":7,"code":0,"stats":{...}}`; `{"t":"settings","settings":{...}}`
//!   when the settings file changes, or `{"t":"settings","error":"..."}` when it can't be read
//!
//! Binary frames carry terminal bytes in both directions: a 4-byte big-endian terminal id followed
//! by the payload.

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;

use crate::git;
use crate::pty::{Event, FlowConfig, OpenRequest, Terminal};
use crate::settings::{self, Settings};
use crate::workspace::Workspace;

/// The settings as last read from the user's file, kept up to date by watching it. Agents, the
/// editor and the agent hook come from here; the open workspace keeps the copy it was opened with
/// (the frontend opens it again when a repository setting changes).
struct Current {
    settings: Settings,
    /// Why the file can't be read, while it can't; the last good settings stay in use.
    error: Option<String>,
}

impl Current {
    fn read() -> Current {
        let mut c = Current {
            settings: Settings::default(),
            error: None,
        };
        c.update(settings::load(settings::user_file().as_deref()));
        c
    }

    /// Takes a new reading of the file; returns the event for the frontend if anything changed.
    fn update(&mut self, read: Result<Settings>) -> Option<Value> {
        match read {
            Ok(s) => {
                if s == self.settings && self.error.is_none() {
                    return None;
                }
                self.settings = s;
                self.error = None;
                Some(json!({"t": "settings", "settings": self.settings}))
            }
            Err(e) => {
                let e = format!("{e:#}");
                if self.error.as_ref() == Some(&e) {
                    return None;
                }
                self.error = Some(e.clone());
                Some(json!({"t": "settings", "error": e}))
            }
        }
    }
}

pub struct State {
    root: PathBuf,
    token: String,
    flow: FlowConfig,
    env: BTreeMap<String, String>,
    /// The event log, when there is one (see main.rs).
    log: Option<Mutex<File>>,
    next_term: AtomicU32,
    terminals: Mutex<HashMap<u32, Arc<Terminal>>>,
}

impl State {
    pub fn new(
        root: PathBuf,
        token: String,
        log_path: Option<&Path>,
        flow: FlowConfig,
        env: BTreeMap<String, String>,
    ) -> Result<State> {
        let log = match log_path {
            Some(path) => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                Some(Mutex::new(
                    OpenOptions::new().create(true).append(true).open(path)?,
                ))
            }
            None => None,
        };
        Ok(State {
            root,
            token,
            flow,
            env,
            log,
            next_term: AtomicU32::new(1),
            terminals: Mutex::new(HashMap::new()),
        })
    }

    /// Kills every terminal's child process. Called before the core exits.
    pub fn shutdown(&self) {
        let terms: Vec<_> = self
            .terminals
            .lock()
            .unwrap()
            .drain()
            .map(|(_, t)| t)
            .collect();
        // The core exits next, so it waits until each program is gone (a few seconds at most).
        let ending: Vec<_> = terms.iter().filter_map(|t| t.close()).collect();
        for e in ending {
            let _ = e.join();
        }
        self.log_record(json!({"ev": "coreExit"}));
    }

    fn log_record(&self, mut rec: Value) {
        let Some(log) = &self.log else { return };
        if let Value::Object(map) = &mut rec {
            map.insert("coreTs".into(), json!(epoch_ms()));
        }
        let mut log = log.lock().unwrap();
        let _ = writeln!(log, "{rec}");
        let _ = log.flush();
    }

    fn hello(&self) -> Value {
        json!({
            "root": self.root,
            "binDir": std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "flow": self.flow,
            "env": self.env,
        })
    }
}

pub async fn serve(listener: TcpListener, state: Arc<State>) -> Result<()> {
    loop {
        let (stream, addr) = listener.accept().await?;
        if !addr.ip().is_loopback() {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = connection(stream, state).await {
                eprintln!("gako-core: connection ended: {e}");
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ClientMessage {
    Req {
        id: u64,
        m: String,
        #[serde(default)]
        p: Value,
    },
    Ack {
        term: u32,
        n: usize,
    },
    Resize {
        term: u32,
        cols: u16,
        rows: u16,
    },
    Close {
        term: u32,
    },
    Log {
        rec: Value,
    },
}

async fn connection(stream: TcpStream, state: Arc<State>) -> Result<()> {
    stream.set_nodelay(true)?;
    let expected = state.token.clone();
    // The error type is tungstenite's, fixed by its callback signature.
    #[allow(clippy::result_large_err)]
    let ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| {
        let token = req
            .uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")));
        match token {
            Some(t) if constant_time_eq(t.as_bytes(), expected.as_bytes()) => Ok(resp),
            _ => {
                let mut err = ErrorResponse::new(Some("bad token".into()));
                *err.status_mut() = StatusCode::UNAUTHORIZED;
                Err(err)
            }
        }
    })
    .await?;

    let (mut sink, mut source) = ws.split();
    // One queue for everything sent, so a reply is never overtaken by output it announces.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

    let writer = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let msg = match ev {
                Event::Data(frame) => Message::binary(frame),
                Event::Exit(info) => {
                    let mut v = serde_json::to_value(&info).unwrap_or_default();
                    v["t"] = "exit".into();
                    Message::text(v.to_string())
                }
                Event::Text(text) => Message::text(text),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut mine: HashMap<u32, Arc<Terminal>> = HashMap::new();
    let mut workspace: Option<Arc<Workspace>> = None;
    let current = Arc::new(Mutex::new(Current::read()));
    let settings_watch = settings::user_file().and_then(|path| {
        let current = current.clone();
        let tx = tx.clone();
        settings::watch(path, move |read| {
            if let Some(ev) = current.lock().unwrap().update(read) {
                let _ = tx.send(Event::Text(ev.to_string()));
            }
        })
        .map_err(|e| eprintln!("gako-core: can't watch the settings file: {e:#}"))
        .ok()
    });

    while let Some(msg) = source.next().await {
        match msg? {
            Message::Binary(bytes) => {
                if bytes.len() >= 4 {
                    let id = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                    if let Some(t) = mine.get(&id) {
                        t.write(bytes[4..].to_vec());
                    }
                }
            }
            Message::Text(text) => {
                let msg: ClientMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("gako-core: bad message: {e}");
                        continue;
                    }
                };
                match msg {
                    ClientMessage::Ack { term, n } => {
                        if let Some(t) = mine.get(&term) {
                            t.ack(n);
                        }
                    }
                    ClientMessage::Resize { term, cols, rows } => {
                        if let Some(t) = mine.get(&term) {
                            let _ = t.resize(cols, rows);
                        }
                    }
                    ClientMessage::Close { term } => {
                        if let Some(t) = mine.remove(&term) {
                            state.terminals.lock().unwrap().remove(&term);
                            t.close();
                        }
                    }
                    ClientMessage::Log { rec } => state.log_record(rec),
                    // Git and file requests run on their own, so a slow one never holds up terminal
                    // traffic.
                    ClientMessage::Req { id, m, p }
                        if m.starts_with("git")
                            || m.starts_with("file")
                            || m.starts_with("search")
                            || m.starts_with("symbol")
                            || m == "openInEditor"
                            || m == "findFiles" =>
                    {
                        let ws = workspace.clone();
                        let tx = tx.clone();
                        let current = current.clone();
                        tokio::spawn(async move {
                            let result = match ws {
                                Some(ws) if m.starts_with("git") => git_request(&ws, &m, p).await,
                                Some(ws)
                                    if m.starts_with("search")
                                        || m.starts_with("symbol")
                                        || m == "findFiles" =>
                                {
                                    search_request(&ws, &m, p).await
                                }
                                Some(ws) => file_request(&ws, &current, &m, p).await,
                                None => Err(anyhow::anyhow!("no workspace is open")),
                            };
                            let reply = match result {
                                Ok(r) => json!({"t": "res", "id": id, "r": r}),
                                Err(e) => json!({"t": "res", "id": id, "e": format!("{e:#}")}),
                            };
                            let _ = tx.send(Event::Text(reply.to_string()));
                        });
                    }
                    ClientMessage::Req { id, m, p } => {
                        let result =
                            request(&state, &mut mine, &mut workspace, &current, &tx, &m, p).await;
                        let reply = match result {
                            Ok(r) => json!({"t": "res", "id": id, "r": r}),
                            Err(e) => json!({"t": "res", "id": id, "e": format!("{e:#}")}),
                        };
                        let _ = tx.send(Event::Text(reply.to_string()));
                        if m == "termOpen"
                            && let Some(t) = reply["r"]["term"]
                                .as_u64()
                                .and_then(|id| mine.get(&(id as u32)))
                        {
                            t.start();
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // A connection owns its terminals: when the page goes away, so do they.
    for (id, t) in mine.drain() {
        state.terminals.lock().unwrap().remove(&id);
        t.close();
    }
    // The watcher holds a sender too: the writer ends only once every sender is gone.
    drop(settings_watch);
    drop(tx);
    let _ = writer.await;
    Ok(())
}

async fn request(
    state: &Arc<State>,
    mine: &mut HashMap<u32, Arc<Terminal>>,
    workspace: &mut Option<Arc<Workspace>>,
    current: &Mutex<Current>,
    tx: &mpsc::UnboundedSender<Event>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "hello" => Ok(state.hello()),
        "readFile" => {
            let path: PathBuf = serde_json::from_value(params["path"].clone())?;
            let path = if path.is_absolute() {
                path
            } else {
                state.root.join(path)
            };
            let bytes = tokio::fs::read(&path).await?;
            Ok(json!({"text": String::from_utf8_lossy(&bytes)}))
        }
        "termOpen" => {
            let mut req: OpenRequest = serde_json::from_value(params)?;
            if current.lock().unwrap().settings.agent_hooks {
                req.cmd = req.cmd.map(crate::agents::adjust);
            }
            let id = state.next_term.fetch_add(1, Ordering::Relaxed);
            let term = Terminal::spawn(id, req, &state.root, state.flow, tx.clone())?;
            state.log_record(json!({"ev": "termSpawn", "term": id, "pid": term.pid}));
            state.terminals.lock().unwrap().insert(id, term.clone());
            let pid = term.pid;
            mine.insert(id, term);
            Ok(json!({"term": id, "pid": pid}))
        }
        "termStats" => {
            let id: u32 = serde_json::from_value(params["term"].clone())?;
            let t = mine
                .get(&id)
                .ok_or_else(|| anyhow::anyhow!("no terminal {id}"))?;
            Ok(serde_json::to_value(t.stats())?)
        }
        "agents" => {
            // The configured agents, and whether each is on the PATH.
            let agents = current.lock().unwrap().settings.agents.clone();
            let agents: Vec<Value> = agents
                .iter()
                .map(|a| {
                    let found = a.command.first().and_then(|p| crate::shellenv::which(p));
                    json!({"name": a.name, "command": a.command, "path": found})
                })
                .collect();
            Ok(json!({"shell": crate::pty::default_shell_name(), "agents": agents}))
        }
        "editors" => {
            // The editors "open in editor" can use, and the one to use unless the user picks.
            let setting = current.lock().unwrap().settings.editor.clone();
            let (found, default) =
                tokio::task::spawn_blocking(move || crate::editors::offered(setting.as_ref()))
                    .await?;
            Ok(json!({"editors": found, "default": default}))
        }
        "workspaceOpen" => {
            let settings = settings::load(settings::user_file().as_deref())?;
            let given: Option<PathBuf> = serde_json::from_value(params["base"].clone())?;
            let base = given
                .or_else(|| settings.base.clone())
                .ok_or_else(|| anyhow::anyhow!("no base folder given, and none in the settings"))?;
            // The previous workspace, if any, stops watching when it's dropped here.
            // Read just now, so the watcher's copy is no newer; an error it was reporting is over.
            current.lock().unwrap().update(Ok(settings.clone()));
            let ws = Workspace::open(base, settings, tx.clone())?;
            *workspace = Some(ws.clone());
            Ok(json!({
                "base": ws.base,
                "settings": ws.settings,
                "repos": ws.repos(),
                "statuses": ws.statuses(),
            }))
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

fn param<T: serde::de::DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params[key].clone()).map_err(|e| anyhow::anyhow!("parameter {key}: {e}"))
}

/// Search and go-to-file. Results stream as `{"t":"searchResults"}` events; the reply carries the
/// totals once the search ends.
async fn search_request(ws: &Arc<Workspace>, method: &str, params: Value) -> Result<Value> {
    let kind = params["scope"]["kind"]
        .as_str()
        .unwrap_or("all")
        .to_string();
    let chosen: Vec<String> =
        serde_json::from_value(params["scope"]["repos"].clone()).unwrap_or_default();
    match method {
        "search" => {
            let query: crate::search::Query = param(&params, "query")?;
            let search_id = params["search"].clone();
            let scope = ws.scope(&kind, &chosen);
            let cancel = ws.begin_search();
            let ws2 = ws.clone();
            let stats = tokio::task::spawn_blocking(move || {
                crate::search::search(&scope, &query, &cancel, &|files| {
                    ws2.emit(json!({"t": "searchResults", "search": search_id, "files": files}));
                })
            })
            .await??;
            Ok(serde_json::to_value(stats)?)
        }
        "searchCancel" => {
            ws.cancel_search();
            Ok(Value::Null)
        }
        "symbolDefinitions" => {
            let name: String = param(&params, "name")?;
            let from: Option<PathBuf> =
                serde_json::from_value(params["path"].clone()).unwrap_or(None);
            let Some(index) = ws.symbols() else {
                return Ok(json!({"ready": false, "symbols": []}));
            };
            let repo = from.as_deref().and_then(|p| ws.repo_of(p));
            let found = index
                .read()
                .unwrap()
                .definitions(&name, from.as_deref(), repo.as_deref());
            Ok(json!({"ready": true, "symbols": found}))
        }
        "symbolSearch" => {
            let query: String = param(&params, "query")?;
            let Some(index) = ws.symbols() else {
                return Ok(json!({"ready": false, "symbols": []}));
            };
            let found: Vec<Value> = index
                .read()
                .unwrap()
                .search(&query, 100)
                .into_iter()
                .map(|(s, positions)| json!({"symbol": s, "positions": positions}))
                .collect();
            Ok(json!({"ready": true, "symbols": found}))
        }
        "findFiles" => {
            let query: String = param(&params, "query")?;
            let files = ws.files().await;
            let base = ws.base.clone();
            let hits = tokio::task::spawn_blocking(move || {
                crate::search::find_files(&files, &base, &query, 50)
            })
            .await?;
            Ok(serde_json::to_value(hits)?)
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

/// The file explorer's requests, limited to the workspace's folders.
async fn file_request(
    ws: &Arc<Workspace>,
    current: &Mutex<Current>,
    method: &str,
    params: Value,
) -> Result<Value> {
    let path: PathBuf = param(&params, "path")?;
    let path = crate::files::inside(&ws.roots(), &path)?;
    match method {
        "filesList" => {
            let listing = tokio::task::spawn_blocking(move || crate::files::list(&path)).await??;
            Ok(serde_json::to_value(listing)?)
        }
        "fileRead" => Ok(serde_json::to_value(
            crate::files::read(&path, 50 << 20, params["raw"].as_bool().unwrap_or(false)).await?,
        )?),
        "openInEditor" => {
            let line = params["line"].as_u64().unwrap_or(1) as u32;
            let column = params["column"].as_u64().unwrap_or(1) as u32;
            let choice = params["editor"].as_str().map(str::to_string);
            let setting = current.lock().unwrap().settings.editor.clone();
            let cmd = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
                let cmd = crate::editors::command(
                    setting.as_ref(),
                    choice.as_deref(),
                    &path,
                    line,
                    column,
                )?;
                crate::editors::spawn(&cmd)?;
                Ok(cmd)
            })
            .await??;
            Ok(json!({"command": cmd}))
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

/// Requests against the open workspace's repos: reading them, reverting a file, switching branch,
/// and fetch, pull and push (staging and committing are left to the agents). Anything that changes
/// the repo refreshes its status before replying, so the frontend sees the new status no later
/// than the reply.
async fn git_request(ws: &Arc<Workspace>, method: &str, params: Value) -> Result<Value> {
    let repo = ws.repo(&param::<String>(&params, "repo")?)?;
    let g = &ws.git;
    match method {
        "gitFile" => {
            let path: String = param(&params, "path")?;
            let rev: String = param(&params, "rev")?;
            let rev = match rev.as_str() {
                "worktree" => git::Rev::WorkTree,
                "index" => git::Rev::Index,
                c => git::Rev::Commit(c),
            };
            Ok(serde_json::to_value(
                git::file(
                    g,
                    &repo.root,
                    rev,
                    &path,
                    50 << 20,
                    params["raw"].as_bool().unwrap_or(false),
                )
                .await?,
            )?)
        }
        "gitLog" => {
            let skip = params["skip"].as_u64().unwrap_or(0) as usize;
            let limit = params["limit"].as_u64().unwrap_or(200) as usize;
            Ok(serde_json::to_value(
                git::log(g, &repo.root, skip, limit).await?,
            )?)
        }
        "gitCommitDetails" => {
            let hash: String = param(&params, "hash")?;
            Ok(serde_json::to_value(
                git::show_commit(g, &repo.root, &hash).await?,
            )?)
        }
        "gitRevert" => {
            let path: String = param(&params, "path")?;
            let orig_path: Option<String> = param(&params, "origPath").unwrap_or(None);
            let what = match param::<String>(&params, "group")?.as_str() {
                "changes" => git::Revert::Changes,
                "untracked" => git::Revert::Untracked,
                "staged" => git::Revert::Staged,
                g => anyhow::bail!("can't revert {g}"),
            };
            git::revert(g, &repo.root, what, &path, orig_path.as_deref()).await?;
            ws.refresh(&repo.root).await;
            Ok(Value::Null)
        }
        "gitBranches" => Ok(serde_json::to_value(git::branches(g, &repo.root).await?)?),
        "gitSwitch" => {
            let branch: String = param(&params, "branch")?;
            let remote = params["remote"].as_bool().unwrap_or(false);
            git::switch(g, &repo.root, &branch, remote).await?;
            ws.refresh(&repo.root).await;
            Ok(Value::Null)
        }
        "gitFetch" | "gitPull" | "gitPush" => {
            git::remote(&repo.root, &method[3..].to_lowercase()).await?;
            ws.refresh(&repo.root).await;
            Ok(Value::Null)
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
