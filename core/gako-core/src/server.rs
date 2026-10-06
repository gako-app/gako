//! The WebSocket protocol.
//!
//! One connection carries everything. Text frames are JSON control messages:
//!
//! - `{"t":"req","id":1,"m":"<method>","p":{...}}` → `{"t":"res","id":1,"r":...}` or `{"t":"res","id":1,"e":"..."}`
//! - `{"t":"ack","term":7,"n":4096}`: bytes of terminal 7 that xterm.js has processed
//! - `{"t":"resize","term":7,"cols":200,"rows":50}`, `{"t":"close","term":7}`
//! - `{"t":"log","rec":{...}}`: appends one record to the timing log
//! - from the core: `{"t":"exit","term":7,"code":0,"stats":{...}}`
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
use crate::settings;
use crate::workspace::Workspace;

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
                Some(Mutex::new(OpenOptions::new().create(true).append(true).open(path)?))
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
        let terms: Vec<_> = self.terminals.lock().unwrap().drain().map(|(_, t)| t).collect();
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
        let token = req.uri().query().and_then(|q| {
            q.split('&').find_map(|kv| kv.strip_prefix("token="))
        });
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
                        tokio::spawn(async move {
                            let result = match ws {
                                Some(ws) if m.starts_with("git") => git_request(&ws, &m, p).await,
                                Some(ws) if m.starts_with("search") || m.starts_with("symbol") || m == "findFiles" => {
                                    search_request(&ws, &m, p).await
                                }
                                Some(ws) => file_request(&ws, &m, p).await,
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
                        let result = request(&state, &mut mine, &mut workspace, &tx, &m, p).await;
                        let reply = match result {
                            Ok(r) => json!({"t": "res", "id": id, "r": r}),
                            Err(e) => json!({"t": "res", "id": id, "e": format!("{e:#}")}),
                        };
                        let _ = tx.send(Event::Text(reply.to_string()));
                        if m == "termOpen"
                            && let Some(t) = reply["r"]["term"].as_u64().and_then(|id| mine.get(&(id as u32)))
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
    drop(tx);
    let _ = writer.await;
    Ok(())
}

async fn request(
    state: &Arc<State>,
    mine: &mut HashMap<u32, Arc<Terminal>>,
    workspace: &mut Option<Arc<Workspace>>,
    tx: &mpsc::UnboundedSender<Event>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "hello" => Ok(state.hello()),
        "readFile" => {
            let path: PathBuf = serde_json::from_value(params["path"].clone())?;
            let path = if path.is_absolute() { path } else { state.root.join(path) };
            let bytes = tokio::fs::read(&path).await?;
            Ok(json!({"text": String::from_utf8_lossy(&bytes)}))
        }
        "termOpen" => {
            let mut req: OpenRequest = serde_json::from_value(params)?;
            if workspace.as_ref().is_none_or(|w| w.settings.agent_hooks) {
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
            let t = mine.get(&id).ok_or_else(|| anyhow::anyhow!("no terminal {id}"))?;
            Ok(serde_json::to_value(t.stats())?)
        }
        "agents" => {
            // The configured agents, and whether each is on the PATH.
            let user = settings::user_file();
            let s = match workspace {
                Some(ws) => ws.settings.clone(),
                None => settings::load(user.as_deref(), None)?,
            };
            let agents: Vec<Value> = s
                .agents
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
            let setting = match workspace {
                Some(ws) => ws.settings.editor.clone(),
                None => settings::load(settings::user_file().as_deref(), None)?.editor,
            };
            let (found, default) = tokio::task::spawn_blocking(move || crate::editors::offered(setting.as_ref())).await?;
            Ok(json!({"editors": found, "default": default}))
        }
        "workspaceOpen" => {
            let user = settings::user_file();
            let given: Option<PathBuf> = serde_json::from_value(params["base"].clone())?;
            let base = match given {
                Some(b) => b,
                None => settings::load(user.as_deref(), None)?
                    .base
                    .ok_or_else(|| anyhow::anyhow!("no base folder given, and none in the settings"))?,
            };
            let settings = settings::load(user.as_deref(), Some(&base))?;
            // The previous workspace, if any, stops watching when it's dropped here.
            let ws = Workspace::open(base, settings, tx.clone())?;
            *workspace = Some(ws.clone());
            Ok(json!({
                "base": ws.base,
                "settings": ws.settings,
                "settingsFiles": {"user": user, "workspace": settings::workspace_file(&ws.base)},
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
    let kind = params["scope"]["kind"].as_str().unwrap_or("all").to_string();
    let chosen: Vec<String> = serde_json::from_value(params["scope"]["repos"].clone()).unwrap_or_default();
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
            let from: Option<PathBuf> = serde_json::from_value(params["path"].clone()).unwrap_or(None);
            let Some(index) = ws.symbols() else { return Ok(json!({"ready": false, "symbols": []})) };
            let repo = from.as_deref().and_then(|p| ws.repo_of(p));
            let found = index.read().unwrap().definitions(&name, from.as_deref(), repo.as_deref());
            Ok(json!({"ready": true, "symbols": found}))
        }
        "symbolSearch" => {
            let query: String = param(&params, "query")?;
            let Some(index) = ws.symbols() else { return Ok(json!({"ready": false, "symbols": []})) };
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
            let hits = tokio::task::spawn_blocking(move || crate::search::find_files(&files, &base, &query, 50)).await?;
            Ok(serde_json::to_value(hits)?)
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

/// The file explorer's requests, limited to the workspace's folders.
async fn file_request(ws: &Arc<Workspace>, method: &str, params: Value) -> Result<Value> {
    let path: PathBuf = param(&params, "path")?;
    let path = crate::files::inside(&ws.roots(), &path)?;
    match method {
        "filesList" => {
            let listing = tokio::task::spawn_blocking(move || crate::files::list(&path)).await??;
            Ok(serde_json::to_value(listing)?)
        }
        "fileRead" => Ok(serde_json::to_value(crate::files::read(&path, 50 << 20).await?)?),
        "openInEditor" => {
            let line = params["line"].as_u64().unwrap_or(1) as u32;
            let column = params["column"].as_u64().unwrap_or(1) as u32;
            let choice = params["editor"].as_str().map(str::to_string);
            let setting = ws.settings.editor.clone();
            let cmd = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
                let cmd = crate::editors::command(setting.as_ref(), choice.as_deref(), &path, line, column)?;
                crate::editors::spawn(&cmd)?;
                Ok(cmd)
            })
            .await??;
            Ok(json!({"command": cmd}))
        }
        _ => anyhow::bail!("unknown method {method}"),
    }
}

/// Requests against the open workspace's repos: reading them, and fetch, pull and push (staging
/// and committing are left to the agents). A fetch, pull or push refreshes the repo's status before
/// replying, so the frontend sees the new status no later than the reply.
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
            Ok(serde_json::to_value(git::file(g, &repo.root, rev, &path, 50 << 20).await?)?)
        }
        "gitLog" => {
            let skip = params["skip"].as_u64().unwrap_or(0) as usize;
            let limit = params["limit"].as_u64().unwrap_or(200) as usize;
            Ok(serde_json::to_value(git::log(g, &repo.root, skip, limit).await?)?)
        }
        "gitCommitDetails" => {
            let hash: String = param(&params, "hash")?;
            Ok(serde_json::to_value(git::show_commit(g, &repo.root, &hash).await?)?)
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
