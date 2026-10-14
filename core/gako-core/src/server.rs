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
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
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
    next_connection: AtomicU64,
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
            next_connection: AtomicU64::new(1),
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

    let conn_id = state.next_connection.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut source) = ws.split();
    // One queue for everything sent, so a reply is never overtaken by output it announces.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

    let mut writer = tokio::spawn(async move {
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
    // Shared with the requests that run on their own; `workspaceOpen` replaces it.
    let workspace: Arc<Mutex<Option<Arc<Workspace>>>> = Arc::new(Mutex::new(None));
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

    // A connection that can no longer be written to is over, even if it can still be read:
    // replies and terminal output would be dropped without anyone knowing.
    let mut outcome: Result<()> = Ok(());
    loop {
        let msg = tokio::select! {
            m = source.next() => match m {
                Some(Ok(m)) => m,
                Some(Err(e)) => {
                    outcome = Err(e.into());
                    break;
                }
                None => break,
            },
            _ = &mut writer => {
                outcome = Err(anyhow::anyhow!("can't write to the connection any more"));
                break;
            }
        };
        match msg {
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
                    // traffic (input and acknowledgements are read by this loop).
                    ClientMessage::Req { id, m, p }
                        if m.starts_with("git")
                            || m.starts_with("file")
                            || m.starts_with("search")
                            || m.starts_with("symbol")
                            || m == "openInEditor"
                            || m == "findFiles"
                            || m == "workspaceOpen" =>
                    {
                        let slot = workspace.clone();
                        let ws = slot.lock().unwrap().clone();
                        let tx = tx.clone();
                        let current = current.clone();
                        tokio::spawn(async move {
                            let result = match ws {
                                _ if m == "workspaceOpen" => {
                                    workspace_open(&slot, &current, &tx, p).await
                                }
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
                            // A big file's reply is serialized off the workers, too.
                            let text = if m == "fileRead" || m == "gitFile" {
                                tokio::task::spawn_blocking(move || reply.to_string())
                                    .await
                                    .unwrap_or_else(|e| {
                                        json!({"t": "res", "id": id, "e": format!("{e}")})
                                            .to_string()
                                    })
                            } else {
                                reply.to_string()
                            };
                            let _ = tx.send(Event::Text(text));
                        });
                    }
                    ClientMessage::Req { id, m, p } => {
                        let result =
                            request(&state, conn_id, &mut mine, &current, &tx, &m, p).await;
                        let reply = match result {
                            Ok(r) => json!({"t": "res", "id": id, "r": r}),
                            Err(e) => json!({"t": "res", "id": id, "e": format!("{e:#}")}),
                        };
                        let _ = tx.send(Event::Text(reply.to_string()));
                        if (m == "termOpen" || m == "termAttach")
                            && let Some(t) = reply["r"]["term"]
                                .as_u64()
                                .and_then(|id| mine.get(&(id as u32)))
                        {
                            // The reply is queued: output may follow it now.
                            if m == "termOpen" {
                                t.start();
                            } else {
                                t.resume();
                            }
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // A connection owns its terminals: when the page goes away, so do they. But a connection
    // that was lost (the socket reset, as when the Mac sleeps) leaves them running, for the page
    // to attach to again on a new connection; they wait, and the core's exit ends them.
    let lost = outcome.is_err();
    for (id, t) in mine.drain() {
        if t.owner() != conn_id {
            continue; // a newer connection has it
        }
        t.detach();
        if !lost {
            state.terminals.lock().unwrap().remove(&id);
            t.close();
        }
    }
    // The watchers hold senders too: don't wait for them. Whatever is still queued goes out first,
    // briefly.
    drop(settings_watch);
    workspace.lock().unwrap().take();
    drop(tx);
    if !writer.is_finished() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), &mut writer).await;
        writer.abort();
    }
    outcome
}

async fn request(
    state: &Arc<State>,
    conn_id: u64,
    mine: &mut HashMap<u32, Arc<Terminal>>,
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
            // Spawning reads the login shell's environment; wait for it here, off the workers.
            crate::shellenv::ready().await;
            if current.lock().unwrap().settings.agent_hooks {
                req.cmd = req.cmd.map(crate::agents::adjust);
            }
            let id = state.next_term.fetch_add(1, Ordering::Relaxed);
            let term = Terminal::spawn(id, req, &state.root, state.flow, tx.clone())?;
            term.set_owner(conn_id);
            state.log_record(json!({"ev": "termSpawn", "term": id, "pid": term.pid}));
            state.terminals.lock().unwrap().insert(id, term.clone());
            let pid = term.pid;
            mine.insert(id, term);
            Ok(json!({"term": id, "pid": pid}))
        }
        "termAttach" => {
            // A page that lost its connection takes its terminals back.
            let id: u32 = param(&params, "term")?;
            let received: u64 = param(&params, "received")?;
            let processed: u64 = param(&params, "processed")?;
            let term = state
                .terminals
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no terminal {id}"))?;
            term.set_owner(conn_id);
            let exit = term.attach(id, tx.clone(), received, processed);
            mine.insert(id, term);
            Ok(json!({"term": id, "exit": exit}))
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
            let agents: Vec<Value> = tokio::task::spawn_blocking(move || {
                agents
                    .iter()
                    .map(|a| {
                        let found = a.command.first().and_then(|p| crate::shellenv::which(p));
                        json!({"name": a.name, "command": a.command, "path": found})
                    })
                    .collect()
            })
            .await?;
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
        "settingsGet" => {
            // For the settings screen: the settings in use, the defaults, which keys the file
            // sets, and what the file's error is, if it has one.
            let path = settings::user_file();
            let in_file: Vec<String> = path
                .as_deref()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|t| serde_json::from_str::<serde_json::Map<String, Value>>(&t).ok())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            let c = current.lock().unwrap();
            let known: Vec<Value> = crate::editors::known()
                .into_iter()
                .map(|(id, name)| json!({"id": id, "name": name}))
                .collect();
            Ok(json!({
                "path": path,
                "settings": c.settings,
                "defaults": Settings::default(),
                "inFile": in_file,
                "error": c.error,
                "knownEditors": known,
            }))
        }
        "settingsSave" => {
            let path = settings::user_file()
                .ok_or_else(|| anyhow::anyhow!("no folder for the settings file on this system"))?;
            let changes: serde_json::Map<String, Value> = param(&params, "changes")?;
            let saved = settings::save(&path, &changes)?;
            // Applied now rather than when the watcher sees the file (it then finds nothing new).
            if let Some(ev) = current.lock().unwrap().update(Ok(saved.clone())) {
                let _ = tx.send(Event::Text(ev.to_string()));
            }
            Ok(json!({"settings": saved}))
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

/// Opens the workspace: finding the repos and starting the watcher take a while on a big folder,
/// so this runs on its own and on a blocking thread, and the connection keeps serving terminals.
async fn workspace_open(
    slot: &Mutex<Option<Arc<Workspace>>>,
    current: &Arc<Mutex<Current>>,
    tx: &mpsc::UnboundedSender<Event>,
    params: Value,
) -> Result<Value> {
    let given: Option<PathBuf> = serde_json::from_value(params["base"].clone())?;
    let tx2 = tx.clone();
    let current2 = current.clone();
    let ws = tokio::task::spawn_blocking(move || -> Result<Arc<Workspace>> {
        let settings = settings::load(settings::user_file().as_deref())?;
        let base = given
            .or_else(|| settings.base.clone())
            .ok_or_else(|| anyhow::anyhow!("no base folder given, and none in the settings"))?;
        // Read just now, so the watcher's copy is no newer; an error it was reporting is over.
        current2.lock().unwrap().update(Ok(settings.clone()));
        Workspace::open(base, settings, tx2)
    })
    .await??;
    // The previous workspace, if any, stops watching when it's dropped here.
    *slot.lock().unwrap() = Some(ws.clone());
    Ok(json!({
        "base": ws.base,
        "settings": ws.settings,
        "repos": ws.repos(),
        "statuses": ws.statuses(),
    }))
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
            // Reading the index can wait for an update to land: not on an async worker.
            let found = tokio::task::spawn_blocking(move || {
                index
                    .read()
                    .unwrap()
                    .definitions(&name, from.as_deref(), repo.as_deref())
            })
            .await?;
            Ok(json!({"ready": true, "symbols": found}))
        }
        "symbolSearch" => {
            let query: String = param(&params, "query")?;
            let Some(index) = ws.symbols() else {
                return Ok(json!({"ready": false, "symbols": []}));
            };
            let found: Vec<Value> = tokio::task::spawn_blocking(move || {
                index
                    .read()
                    .unwrap()
                    .search(&query, 100)
                    .into_iter()
                    .map(|(s, positions)| json!({"symbol": s, "positions": positions}))
                    .collect()
            })
            .await?;
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
    // Resolving paths touches the file system, which can be slow (a network or cloud folder).
    let ws2 = ws.clone();
    let path =
        tokio::task::spawn_blocking(move || crate::files::inside(&ws2.roots(), &path)).await??;
    match method {
        "filesList" => {
            let listing = tokio::task::spawn_blocking(move || crate::files::list(&path)).await??;
            Ok(serde_json::to_value(listing)?)
        }
        "fileRead" => {
            let content =
                crate::files::read(&path, 50 << 20, params["raw"].as_bool().unwrap_or(false))
                    .await?;
            Ok(tokio::task::spawn_blocking(move || serde_json::to_value(content)).await??)
        }
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
            let content = git::file(
                g,
                &repo.root,
                rev,
                &path,
                50 << 20,
                params["raw"].as_bool().unwrap_or(false),
            )
            .await?;
            Ok(tokio::task::spawn_blocking(move || serde_json::to_value(content)).await??)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio_tungstenite::client_async;

    type Client = tokio_tungstenite::WebSocketStream<TcpStream>;

    async fn connect(port: u16) -> Client {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (ws, _) = client_async(format!("ws://127.0.0.1:{port}/?token=tok"), stream)
            .await
            .unwrap();
        ws
    }

    async fn request(ws: &mut Client, id: u64, m: &str, p: Value) {
        let msg = json!({"t": "req", "id": id, "m": m, "p": p});
        ws.send(Message::text(msg.to_string())).await.unwrap();
    }

    /// Reads until the reply to `id` and returns it, with the terminal output seen on the way.
    async fn reply(ws: &mut Client, id: u64, out: &mut Vec<u8>) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .expect("no reply")
                .unwrap()
                .unwrap();
            match msg {
                Message::Binary(b) => out.extend_from_slice(&b[4..]),
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["t"] == "res" && v["id"] == id {
                        return v;
                    }
                }
                _ => {}
            }
        }
    }

    /// Reads terminal output until it contains `needle`.
    async fn until(ws: &mut Client, out: &mut Vec<u8>, needle: &str) {
        while !String::from_utf8_lossy(out).contains(needle) {
            let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .unwrap_or_else(|_| panic!("no {needle:?} in {:?}", String::from_utf8_lossy(out)))
                .unwrap()
                .unwrap();
            if let Message::Binary(b) = msg {
                out.extend_from_slice(&b[4..]);
            }
        }
    }

    /// The window's socket is closed without a closing handshake (macOS does this when the screen
    /// sleeps). The terminal goes on, and a new connection takes it over and is sent exactly what
    /// the first one hadn't received.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_terminal_survives_a_lost_connection() {
        let dir = tempfile::tempdir().unwrap();
        let flow = FlowConfig {
            high: 1 << 19,
            low: 1 << 17,
            chunk: 4096,
        };
        let state = Arc::new(
            State::new(
                dir.path().to_path_buf(),
                "tok".into(),
                None,
                flow,
                BTreeMap::new(),
            )
            .unwrap(),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, state.clone()));

        let mut first = connect(port).await;
        let script = "echo one; sleep 1; echo two; sleep 1; echo three";
        request(
            &mut first,
            1,
            "termOpen",
            json!({"cols": 80, "rows": 24, "cmd": ["sh", "-c", script]}),
        )
        .await;
        let mut seen = Vec::new();
        let opened = reply(&mut first, 1, &mut seen).await;
        let term = opened["r"]["term"].as_u64().unwrap();
        until(&mut first, &mut seen, "one").await;
        let received = seen.len() as u64;

        // Gone, with no close frame and nothing acknowledged.
        drop(first);
        // "two" and "three" are written while no one is connected.
        tokio::time::sleep(Duration::from_millis(2600)).await;

        let mut second = connect(port).await;
        request(
            &mut second,
            1,
            "termAttach",
            json!({"term": term, "received": received, "processed": 0}),
        )
        .await;
        let mut more = Vec::new();
        let attached = reply(&mut second, 1, &mut more).await;
        assert_eq!(attached["r"]["term"], term);
        until(&mut second, &mut more, "three").await;
        let text = String::from_utf8_lossy(&more);
        assert!(
            !text.contains("one"),
            "what it had was sent again: {text:?}"
        );
        assert!(
            text.contains("two"),
            "what it missed was not sent: {text:?}"
        );

        // The program ended while nobody was connected, and the new connection is told.
        let exit = loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), second.next())
                .await
                .expect("no exit")
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["t"] == "exit" {
                    break v;
                }
            }
        };
        assert_eq!(exit["term"], term);
        assert_eq!(exit["code"], 0);
        state.shutdown();
    }

    /// A page that closes its connection properly takes its terminals with it, as before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_connection_closes_its_terminals() {
        let dir = tempfile::tempdir().unwrap();
        let flow = FlowConfig {
            high: 1 << 19,
            low: 1 << 17,
            chunk: 4096,
        };
        let state = Arc::new(
            State::new(
                dir.path().to_path_buf(),
                "tok".into(),
                None,
                flow,
                BTreeMap::new(),
            )
            .unwrap(),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, state.clone()));

        let mut ws = connect(port).await;
        request(
            &mut ws,
            1,
            "termOpen",
            json!({"cols": 80, "rows": 24, "cmd": ["sh", "-c", "sleep 60"]}),
        )
        .await;
        let mut out = Vec::new();
        reply(&mut ws, 1, &mut out).await;
        assert_eq!(state.terminals.lock().unwrap().len(), 1);
        ws.close(None).await.unwrap();
        let started = std::time::Instant::now();
        while !state.terminals.lock().unwrap().is_empty() {
            assert!(started.elapsed() < Duration::from_secs(10), "still open");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        state.shutdown();
    }
}
