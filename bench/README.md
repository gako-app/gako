# Measuring Gako

How to run Gako's measurement suites on a fresh machine: macOS, Windows or Linux. The budgets they
check and the method behind them are in [docs/performance.md](../docs/performance.md); results are
committed in [results/](results/).

There are three suites:

- **Terminals and the viewer:** a measurement harness (`frontend/bench.html`) in the real shell,
  against VS Code in the same scenarios. About 75 minutes.
- **The Git view:** the real app on generated layouts of 25 and 100 repositories, against VS Code.
- **Files, search and navigation:** the core alone, on the same layouts. A minute or two.

## 1. Prerequisites

All platforms:

- **Git**
- **Rust stable** via [rustup](https://rustup.rs)
- **Node.js** LTS or newer
- **Python 3.11+** and **[uv](https://docs.astral.sh/uv/)**, which installs `psutil` into
  `bench/.venv` from `bench/uv.lock`, with nothing system-wide
- **VS Code**, for the baseline, with the extensions you actually use

Per platform:

- **macOS:** Xcode or the Command Line Tools.
- **Windows:** Visual Studio Build Tools with "Desktop development with C++" (for Rust).
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential`. If Electron refuses to start
  because of its sandbox helper, see Electron's Linux sandbox notes, and record any workaround with
  the results.

## 2. Build

From the repository root:

```bash
npm install
npm run build -w frontend
cargo build --release --manifest-path core/Cargo.toml
```

## 3. Test data

```bash
cd bench
uv run fixtures/generate.py
```

About 830 MB in `bench/out/fixtures/` (gitignored), identical on every machine: a sample workspace
with five nested repositories, a 5,000-line diff, a 5 MB file, three 250 MB dumps and a 50 MB log,
and the two repository layouts (`work`: 25 repositories, three with 3,000 untracked files;
`stress`: 100 repositories up to four levels deep).

## 4. Before measuring

- **Close other apps**, especially other Electron and WebView2 apps (Teams, Slack, Outlook,
  Discord), and quit VS Code. Memory is counted per process tree, never by process name, but other
  apps still compete for the CPU and GPU.
- **Keep the screen unlocked and the window visible**, and don't use the machine during a run.
  Windows stop drawing when they're hidden or the screen locks, and the timings depend on drawing.
- **Plug in the power adapter** and turn off low-power mode.
- On Windows, note whether the machine is a physical desktop or a remote or virtual one; `dxdiag`
  shows whether graphics acceleration is on.

The budgets are relative to VS Code, so **run its baseline first** and look at its numbers before
the Gako runs.

## 5. Terminals and the viewer

```bash
cd bench
uv run measure/run.py suite
uv run measure/report.py
```

Or one run at a time: `uv run measure/run.py <electron|vscode> <scenario>`, with the scenarios
`coldstart`, `idle`, `ui`, `load`, `dump`, `cycle` and `lifecycle` (`--help` for the options).
Each run writes `bench/out/runs/<run id>/`, with `result.json`, the app's timing log and the test
agents' reports. `report.py` turns a day's runs into `bench/results/<platform>-<app>-<date>.md`:
one file for Gako, with every budget and its verdict, and one for the VS Code baseline. Commit
them.

## 6. The Git view

The `panel` scenario runs the real app on a fresh copy of a generated layout. It measures the first
scan, how long a file edit, a revert and a commit from a terminal take to show, and CPU and memory
while nothing changes. VS Code on the same layout gives the CPU and memory baseline.

```bash
cd bench
for app in vscode electron; do for l in work stress; do uv run measure/run.py $app panel --layout $l; done; done
uv run measure/report.py
```

`report.py` writes `bench/results/<platform>-phase1-<date>.md`.

Runs carry a label (`--phase`): 0 for the terminal and viewer suite and 1 for the Git view by
default. Re-running a suite with newer code under another label keeps its results in a file of
their own, against the same VS Code baseline.

## 7. Files, search and navigation

Measured against `gako-core` alone, on fresh copies of the same layouts:

```bash
node bench/measure/core.mjs work
node bench/measure/core.mjs stress
```

It prints JSON: listing a folder, search (first results and the whole workspace), go to file, the
symbol index's build time and size, definition and symbol lookups, how soon a saved function
becomes findable, and the core's memory.

## 8. The VS Code baseline

`run.py vscode …` starts VS Code with its own `--user-data-dir` under the run's folder, so your real
profile is untouched, with your usual extensions. Its `settings.json` is:

- **your own `settings.json`**, plus
- **automation settings** (both modes): automatic tasks on, workspace trust off, no startup editor,
  no window restore, a maximized window, no updates or extension updates, telemetry off,
  `git.repositoryScanMaxDepth: 2` (so the nested repositories are found), and terminals in the
  editor area (so each terminal gets the whole window, as in Gako).
- **Matched mode** also pins `terminal.integrated.scrollback: 1000`,
  `terminal.integrated.gpuAcceleration: "on"` and `terminal.integrated.fontSize: 12`. **Default**
  ("out of the box") mode keeps your own values.

The exact settings are saved in each run's `result.json` and listed in the baseline's results file.

The scenarios in VS Code are driven by tasks in a generated `.code-workspace` that run when the
folder opens:

- **idle:** the sample workspace open, the 5,000-line diff opened with `code --diff`, and one idle
  terminal, not revealed.
- **load:** four `tui-load` agent terminals and, after 20 seconds, `tui-load dump` of the 50 MB log
  in a fifth.
- **dump:** one terminal running `tui-load dump` of the three 250 MB files in turn, with pauses:
  the same command Gako's dump scenario types into its shell.
- **coldstart:** from launch until the first task starts.

VS Code's terminal size can't be set. The first run on a machine (or any run with `--probe`) opens
VS Code briefly to see what size its terminals get there, and pins Gako's terminals to that size
(saved in `bench/out/terminal-size-<platform>.json`; `--cols` and `--rows` override it). Diff and
file open times and keystroke-to-echo are measured in Gako only, because VS Code exposes no
equivalent timing.

## 9. By hand

- **Minimize and restore** the Gako window a few times during the `cycle` run, which switches
  terminals on its own. Afterwards every terminal must show its program, not a blank or garbled
  screen.
- **Real agents:** start Gako (`npm run app -- <folder>`), start four agents with real work across
  the sample workspace's repositories for a few minutes, and look for anything wrong: garbled
  redraws, lag, resize problems, processes left after quitting. Write what you saw into the results
  file under a "Real agents" heading.
- **Screenshots** of anything that fails go next to the results file.

## How it measures

- **Memory** (`measure/proctree.py`): the app's whole process tree from its root process, as
  [performance.md](../docs/performance.md#method) describes. On macOS `run.py` starts every app with
  responsibility disclaimed, as macOS does for apps it launches itself, so the helper processes are
  attributed to the app. On Linux, `run.py` asks for your sudo password once and runs only its
  sampling helper as root; the apps run as you. Every sample lists any process it couldn't read,
  and the results flag such runs as undercounting.
- **Timings** come from the frontend's log (`performance.now()` from a request to the first render
  after its result) and from `tui-load`'s reports. Keystroke to echo runs from xterm.js's input to
  the render that shows the echo; it leaves out the browser's key dispatch (well under a
  millisecond) and the compositor's last frame.
- **Integrity:** every byte the frontend receives is hashed and compared with the core's hash of
  what it read from the PTY, and the test agents' and dumps' self-checking lines (a sequence number
  and a CRC-32) are checked in xterm.js's buffer afterwards. `npm test -w frontend` checks the
  checkers themselves against xterm.js's real buffer.

## Other tools

- **`core/tui-load`** stands in for an agent's terminal interface: colours, cursor movement,
  partial redraws, a spinner and bursts of text, about 30 redraws a second, with self-checking
  output. It also dumps files with timing (`tui-load dump`).
- **`measure/agent_signals.py`** lists what an agent sent its terminal (titles, notifications,
  bells, prompt marks) in a recording made with `GAKO_RECORD_DIR`; see
  [docs/terminals.md](../docs/terminals.md#how-gako-knows).
