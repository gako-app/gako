# Architecture

How Gako is put together: three parts in two processes, one connection between them, and what
each part is allowed to do.

## The parts

```text
┌──────────────────── Electron shell (shells/electron) ────────────────────┐
│  windows · starts and stops the core · native dialogs · app:// pages      │
│                                                                           │
│  ┌──────────────── frontend (frontend/, in the window) ────────────────┐  │
│  │  sidebar · tabs · Monaco viewer and diffs · xterm.js terminals      │  │
│  │  talks to the core only through the Transport interface             │  │
│  └─────────────────────────────────┬───────────────────────────────────┘  │
└────────────────────────────────────┼──────────────────────────────────────┘
                                     │ one WebSocket, 127.0.0.1, token
                         ┌───────────┴───────────┐
                         │  gako-core (core/)     │  Rust, a child process
                         │  workspace · git · PTYs │
                         │  files · search · index │
                         └───────────────────────┘
```

- **The core** (`core/gako-core`, Rust) does everything that touches the system: finding
  repositories and running `git`, watching files, the terminals' PTYs, reading files, search, the
  symbol index, finding editors and opening files in them.
- **The frontend** (`frontend/`, TypeScript built with Vite, no UI framework) is the whole user
  interface. Monaco shows files and diffs, read-only; xterm.js draws terminals.
- **The shell** (`shells/electron/`) creates windows, starts the core and hands the frontend its
  address, and shows the few things only a native shell can: the folder picker, the warning before
  quitting with agents running, showing a file in the file manager, the About window. It has no
  app logic.

The frontend never calls Electron directly. Apart from `boot.ts`, which asks the shell for the
core's address, a folder picker and the About window, everything goes through the `Transport`
interface to the core. That keeps the shell replaceable: the frontend runs unchanged in a plain
browser for development, given the core's address in the URL.

## Starting and stopping

1. The shell generates a random 32-byte token and starts `gako-core` with it (`GAKO_TOKEN`), the
   folder to open if one was given (`GAKO_BASE`), and its stdin as a pipe.
2. The core binds a WebSocket server to `127.0.0.1` on a random port and prints one JSON line with
   the port.
3. The shell loads `app://gako/index.html` into the window. Its preload script hands the frontend
   the address and token, and nothing else of Electron's.
4. The frontend connects, asks the core what it found (`hello`), and opens the base folder: the one
   given on the command line, or the last one, or it asks.

The core exits when its stdin closes, which happens when the shell exits for any reason, a crash
included. On quit, the shell closes that pipe and kills the core two seconds later if it's still
there. Terminals close with their programs (see [terminals.md](terminals.md)).

## The connection

One WebSocket carries everything, so the order of messages is preserved: a reply never overtakes
output it announces.

- **Text frames** are JSON with a `t` field:
  - `{"t":"req","id":1,"m":"<method>","p":{…}}` → `{"t":"res","id":1,"r":…}`, or `"e"` with an
    error message.
  - `ack`, `resize`, `close` for terminals (see below), and `log` for timing records.
  - Events pushed by the core: `exit` (a terminal's program ended), `repoStatus`, `repoTouched`,
    `repos`, `scanDone`, `filesChanged`, `searchResults`, `indexReady`.
- **Binary frames** carry terminal bytes in both directions: a 4-byte big-endian terminal id, then
  the bytes. Terminal output is never base64'd into JSON.

The requests, by area:

| Area | Methods |
|---|---|
| Start | `hello` |
| Workspace and Git | `workspaceOpen`, `gitFile`, `gitLog`, `gitCommitDetails`, `gitRevert`, `gitBranches`, `gitSwitch`, `gitFetch`, `gitPull`, `gitPush` |
| Terminals | `termOpen`, `termStats`, `agents` |
| Files | `filesList`, `fileRead`, `readFile` (the measurement harness's) |
| Search and navigation | `search`, `searchCancel`, `findFiles`, `symbolDefinitions`, `symbolSearch` |
| Editors | `editors`, `openInEditor` |

The interface is shaped for long-lived two-way streams, not only request and reply, so terminal
output and pushed events share it with requests.

### Terminal flow control

A fast program can write far more than a window can draw. The pipeline uses **backpressure**, as VS
Code's terminal does, so output is never dropped and memory never grows without bound:

- The core reads each PTY in chunks of up to 32 KB and forwards them as they are, never waiting for
  a newline.
- The frontend acknowledges bytes (`ack`) once xterm.js has processed them.
- When a terminal's unacknowledged bytes pass 512 KB, the core stops reading its PTY; below 128 KB
  it reads again. The program writing simply waits, as it would in any slow terminal.

Splitting at arbitrary byte boundaries is safe: xterm.js holds incomplete escape sequences and
UTF-8 characters until the rest arrives.

## Security boundary

Gako runs as you, with your rights. What it guards against is everyone else:

- The core listens on the loopback interface only, and accepts a connection only if it presents
  the token from the shell, compared in constant time. The token never reaches the terminals'
  environment.
- Windows load only Gako's own pages from `app://gako/`, with context isolation, Chromium's
  sandbox and no Node.js in the page. Links open in your browser, and a window can't navigate away
  from the app.
- The preload scripts expose a short, fixed list of calls: the core's address and token, the folder
  picker and the About window for the main window; facts, "show in file manager" and Electron's own
  notices for the About window.
- Settings come only from your own settings file, never from a folder Gako opens.

[SECURITY.md](../SECURITY.md) says what counts as a vulnerability and how to report one.

## Where things are kept

| What | Where |
|---|---|
| Settings | `settings.json` in `~/Library/Application Support/Gako` (macOS), `%APPDATA%\Gako` (Windows), `~/.config/gako` (Linux). See [settings.md](settings.md). |
| Window size and position | `window.json` in the shell's data folder |
| Open tabs and terminals per base folder, the last base folder, panel sizes, the chosen editor and diff layout | The window's local storage, in the shell's data folder |
| The shell's data folder (Chromium's own files) | `Gako/Electron` in `%LOCALAPPDATA%` (Windows), `~/Library/Application Support` (macOS), `~/.config` (Linux) |

Deleting the shell's data folder starts Gako as if for the first time. The About window shows both
paths, with buttons to show them.

## Platform specifics

- **The login shell's environment (macOS and Linux).** An app started from the Dock or a desktop
  launcher doesn't get the `PATH` a login shell sets up, so agents installed by npm or Homebrew
  wouldn't be found. The core reads the login shell's environment once at startup, as VS Code does,
  and uses it for terminals, `git` and finding programs. Windows apps get the user's environment
  already.
- **Windows:**
  - Terminals run through ConPTY. The default shell is PowerShell, or `GAKO_SHELL`.
  - npm installs agents as `.cmd` shims, which Windows runs only through `cmd.exe`. The core finds
    the program itself and starts batch files as `cmd.exe /d /c`.
  - Gako must run from a local disk. Started from a network drive or a redirected folder, as
    corporate profiles and remote desktop hosts often have, Chromium can't start its sandboxed
    helper processes; the shell detects that and says so.
  - Chromium's data goes to `%LOCALAPPDATA%`, not the roaming `%APPDATA%`, which a corporate
    profile may put on a network drive.
- **macOS:** file events name only the folder that changed, and the first one after a quiet spell
  can arrive late (see [git.md](git.md#watching)).
- **Linux:** Chromium's sandbox needs Electron's `chrome-sandbox` helper to be root-owned and
  setuid on systems that restrict unprivileged user namespaces, such as Ubuntu 24.04.

## Repository layout

```text
core/
  gako-core/      the core: server.rs (connection), workspace.rs, git/, pty.rs, agents.rs,
                  files.rs, search.rs, symbols.rs, editors.rs, settings.rs, shellenv.rs
  tui-load/       a stand-in for an agent's terminal UI, for measurements and tests
frontend/
  index.html      the app; src/app/ is its UI
  about.html      the About window; src/about/
  bench.html      the measurement harness; src/bench/
  src/            transport.ts, boot.ts, terminal.ts, combining.ts, monaco.ts, shared by all three
  test/           the frontend's tests
shells/electron/  main.cjs, the preload scripts, packaging (scripts/) and the icon (build/)
bench/            fixtures, measurement scripts and committed results; see bench/README.md
docs/             these documents
```

## Building and packaging

`npm run app -- <folder>` builds the frontend and the core and starts the shell from the
repository. `npm run package` builds them, regenerates `THIRD-PARTY-NOTICES.txt`, and packages the
shell with the core binary, the built frontend, the licence and the notices in its resources:
`Gako.app` on macOS, a `Gako` folder on Windows, a `gako` folder on Linux, in `dist/`. Packaged
builds aren't signed yet.

The icon's source is `shells/electron/build/icon.svg`; `npm run icons -w shells/electron` renders
the files packaging uses from it.

For development and measurement, a few environment variables change how the parts behave:

| Variable | Effect |
|---|---|
| `GAKO_SHELL` | The program a plain terminal runs, instead of the login shell (PowerShell on Windows) |
| `GAKO_NO_SHELL_ENV` | Don't read the login shell's environment (macOS and Linux) |
| `GAKO_CORE_BIN` | The core binary the shell starts |
| `GAKO_ROOT` | The core's root folder (the repository, or the home folder when packaged) |
| `GAKO_LOG` | Where the core writes its timing log (kept only when run from the repository) |
| `GAKO_DEBUG_WATCH` | Log file events as the watcher delivers them |
| `GAKO_RECORD_DIR` | Record every terminal's output and input, for studying what agents send (see [terminals.md](terminals.md)) |
| `GAKO_FLOW_HIGH`, `GAKO_FLOW_LOW`, `GAKO_CHUNK` | The flow-control marks and read size |

The measurement suites set more of their own; see [bench/README.md](../bench/README.md).
