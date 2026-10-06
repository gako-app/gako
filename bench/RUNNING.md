# Running the phase 0 suite

How to build Gako's phase 0 harness and run the whole measurement suite on a fresh machine:
macOS, Windows or Linux. What the numbers mean and how they decide Tauri or Electron is in
[PLAN.md](../docs/PLAN.md); what was built is in [PHASE0.md](../docs/PHASE0.md).

## 1. Prerequisites

All platforms:

- **Git**
- **Rust stable** via [rustup](https://rustup.rs)
- **Node.js** LTS or newer (npm workspaces)
- **Python 3.11+** and **[uv](https://docs.astral.sh/uv/)** (installs `psutil` into `bench/.venv`
  from `bench/uv.lock`; nothing system-wide)
- **VS Code**, for the baseline. Install the extensions you actually use.

Per platform:

- **macOS:** Xcode or the Command Line Tools.
- **Windows:** Visual Studio Build Tools with "Desktop development with C++" (for Rust), and
  WebView2 (preinstalled on Windows 10 21H2+ and 11).
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential libwebkit2gtk-4.1-dev libssl-dev
  libayatana-appindicator3-dev librsvg2-dev` (Tauri's prerequisites). If Electron refuses to
  start because of its sandbox helper, see Electron's Linux sandbox notes; record any workaround
  with the results.

## 2. Build

From the repository root:

```bash
npm install
npm run build -w frontend
cargo build --release --manifest-path core/Cargo.toml
cargo build --release --manifest-path shells/tauri/src-tauri/Cargo.toml
```

Rebuild the Tauri shell after every frontend build: it embeds the frontend when it's compiled
(Electron loads it at run time). `run.py` refuses to run a Tauri build that's older than the
frontend build.

The first Electron start downloads the Electron runtime (checked against the checksums pinned in
the `electron` package).

## 3. Test data

```bash
cd bench
uv run fixtures/generate.py
```

About 830 MB in `bench/out/fixtures/` (gitignored): the sample workspace with five nested repos,
the 5,000-line diff, the 5 MB file, three 250 MB dumps and a 50 MB log. The output is identical on
every machine.

Optional check that the integrity checkers work against xterm.js's real buffer:

```bash
npm test -w frontend
```

## 4. Before measuring

- **Close other apps**, and especially other Electron and WebView2 apps (Teams, Slack, Outlook,
  Discord), and quit VS Code. The memory script walks each app's own process tree and never counts
  processes by name, but other apps still compete for CPU and GPU.
- **Keep the screen unlocked and the Gako or VS Code window visible.** Web views stop drawing
  when the screen is locked or the window is hidden, and the timings depend on drawing. Don't use
  the machine during a run.
- **Plug in the power adapter** and turn off low-power mode.
- On Windows, note whether the machine is a physical desktop or a remote or virtual one
  (PLAN.md's first open question). `dxdiag` shows whether graphics acceleration is on.

## 5. Run

The whole suite, about 75 minutes:

```bash
cd bench
uv run measure/run.py suite
uv run measure/report.py
```

Or one run at a time: `uv run measure/run.py <tauri|electron|vscode> <scenario>`, with scenarios
`coldstart`, `idle`, `ui`, `load`, `dump`, `cycle` and `lifecycle` (`--help` for options). Each
run writes `bench/out/runs/<run id>/` with `result.json`, the app's timing log and the agents'
reports. `report.py` turns the day's runs into `bench/results/<platform>-<shell>-<date>.md`: one
file per Gako shell with every row of PLAN.md's table and its verdict, and one for the VS Code
baseline. Commit those files.

**Check the thresholds against VS Code before the Gako runs** (PLAN.md: adjust them only then,
never after). Run the VS Code baseline first, look at its numbers, record any adjustment in
PLAN.md, then run Gako.

## 6. The VS Code baseline

`run.py vscode …` starts VS Code with its own `--user-data-dir` under the run's folder, so your
real profile is untouched, and with your usual extensions. Its `settings.json` is:

- **your own `settings.json`**, plus
- **automation settings** (both modes): automatic tasks on, workspace trust off, no startup
  editor, no window restore, maximized window, no updates or extension updates, telemetry off,
  `git.repositoryScanMaxDepth: 2` (so the nested repos are found) and terminals in the editor
  area (so each terminal gets the full window, as in Gako).
- **matched mode** also pins `terminal.integrated.scrollback: 1000`,
  `terminal.integrated.gpuAcceleration: "on"` and `terminal.integrated.fontSize: 12`. **Default**
  ("out of the box") mode keeps your own values.

The exact settings are saved in each run's `result.json` and listed in the baseline results
file.

Scenarios in VS Code, all driven by tasks in a generated `.code-workspace` that run when the folder
opens:

- **idle:** the sample workspace open, the 5,000-line diff opened with `code --diff`, and one idle
  shell terminal (not revealed, like Gako's hidden terminal tab).
- **load:** four `tui-load` agent terminals and, after 20 seconds, `tui-load dump` of the 50 MB log
  in a fifth.
- **dump:** one terminal running `tui-load dump` of the three 250 MB files in sequence, with
  pauses, the same command Gako's dump scenario types into its shell.
- **coldstart:** launch until the first task starts.

VS Code's terminal size can't be set. `run.py suite` first opens VS Code briefly to see what size
its terminals get on this machine, and pins Gako's terminals to that size (saved in
`bench/out/terminal-size-<platform>.json`; `--cols` and `--rows` override it). The agents in the
load run also report the size they saw, listed in the baseline results file. Diff and file open times and keystroke-to-echo are measured in
Gako only, because VS Code exposes no equivalent timing.

## 7. By hand

- **Minimize and restore** the Gako window a few times during the `cycle` run (it switches tabs
  on its own). Afterwards every agent tab must show its panel, not a blank or garbled screen.
- **Real-agent sanity run:** start each shell by hand (`npm start -w shells/tauri`,
  `npm start -w shells/electron`), open four terminal tabs with the **+ terminal** button, start `claude` or `codex` in them, give them real work across the sample
  workspace's repos for a few minutes, and look for anything wrong: garbled redraws, lag,
  resize problems, leftover processes after quitting. Write what you saw into the results file
  under a "Real agents" heading.
- **Screenshots** of anything that fails go next to the results file.

## What gets measured, and how

- **Memory** (`measure/proctree.py`): the app's whole process tree from its root process, never
  by process name. On macOS, WebKit's helper processes are XPC services whose parent is launchd,
  so the walk also follows macOS's "responsible process" link, which is how Activity Monitor
  groups them. For that link to point at the app, `run.py` starts every app with responsibility
  disclaimed, as macOS does for apps it launches itself. The metric is USS on Windows (private working set) and Linux, and the physical
  footprint on macOS (psutil can't read USS there without root, and can't read it at all for
  Apple's WebKit processes); on macOS `footprint` is also run on the same processes as a
  cross-check. Two minutes of settling, then one minute of samples; the median is reported.
- **Timings** come from the frontend's log (`performance.now()` from request to the first render
  after the result) and from `tui-load`'s reports.
- **Integrity**: every byte the frontend receives is hashed and compared with the core's hash of
  what it read from the PTY; and the agents' and dumps' self-checking lines (sequence number plus
  CRC-32) are validated in xterm.js's buffer afterwards.
- **Keystroke to echo** is measured from xterm.js's input to the render that shows the echo. It
  doesn't include the browser's key event dispatch (well under a millisecond) or the compositor's
  last frame to the display.
