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

use crate::pty::{Event, FlowConfig, OpenRequest, Terminal};

pub struct State {
    root: PathBuf,
    token: String,
    flow: FlowConfig,
    env: BTreeMap<String, String>,
    log: Mutex<File>,
    next_term: AtomicU32,
    terminals: Mutex<HashMap<u32, Arc<Terminal>>>,
}

impl State {
    pub fn new(
        root: PathBuf,
        token: String,
        log_path: &Path,
        flow: FlowConfig,
        env: BTreeMap<String, String>,
    ) -> Result<State> {
        if let Some(dir) = log_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let log = OpenOptions::new().create(true).append(true).open(log_path)?;
        Ok(State {
            root,
            token,
            flow,
            env,
            log: Mutex::new(log),
            next_term: AtomicU32::new(1),
            terminals: Mutex::new(HashMap::new()),
        })
    }

    /// Kills every terminal's child process. Called before the core exits.
    pub fn shutdown(&self) {
        let terms: Vec<_> = self.terminals.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in terms {
            t.close();
        }
        self.log_record(json!({"ev": "coreExit"}));
    }

    fn log_record(&self, mut rec: Value) {
        if let Value::Object(map) = &mut rec {
            map.insert("coreTs".into(), json!(epoch_ms()));
        }
        let mut log = self.log.lock().unwrap();
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
                    ClientMessage::Req { id, m, p } => {
                        let result = request(&state, &mut mine, &tx, &m, p).await;
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
            let req: OpenRequest = serde_json::from_value(params)?;
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
