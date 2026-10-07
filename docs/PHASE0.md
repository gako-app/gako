# Phase 0 brief

The working brief for phase 0. Read [PLAN.md](PLAN.md) first: it holds the goal, the pass/fail
table, the memory method and the decision rule. This file says what to build to produce those
numbers, and who does which part.

**Status: done on 2026-10-06, with the Windows run skipped. Electron was chosen.** See *Outcome* at
the end, and PLAN.md's *Host decision and the hedge*.

## What phase 0 answers

1. **Tauri or Electron?** Same frontend, same core, two shells, measured on macOS, the Windows work
   machine and Linux.
2. **Does the terminal plan hold?** xterm.js + `portable-pty` (ConPTY on Windows) with backpressure,
   under several agents at once.

Phase 0 is not product work. The frontend UI is a test harness and can be thrown away. The core's PTY
and transport code, and the frontend's transport layer, are meant to be kept.

## Architecture for phase 0

```text
┌──────────── shell (Tauri 2 or bare Electron) ────────────┐
│  window + web view  ──  loads frontend/  (same build)     │
│  starts gako-core, passes ws://127.0.0.1:<port> + token   │
└───────────────────────────┬──────────────────────────────┘
                            │ WebSocket (loopback only)
                   ┌────────┴────────┐
                   │   gako-core     │  Rust binary
                   │   PTYs, files   │
                   └─────────────────┘
```

- **`gako-core`** is one Rust binary. Both shells start it as a child process and stop it on quit.
  It binds to `127.0.0.1` on a random port and only accepts connections presenting a random one-time
  token it was started with. It must exit when its parent shell exits, even if the shell crashes.
- **One WebSocket carries everything.** JSON text frames for control messages (open terminal,
  resize, close, read file, acknowledgements); binary frames for terminal output and input, tagged
  with the terminal id. Don't base64 terminal bytes into JSON.
- **Backpressure, as in PLAN.md's flow-control trap.** The frontend acknowledges bytes after
  xterm.js's `write()` callback fires. The core stops reading a PTY when its unacknowledged bytes pass
  a high-water mark and resumes below a low-water mark. Start with 512 KB high and 128 KB low, and
  record the values with the results.
- **The core reads PTY output in fixed-size chunks** and forwards them as they are. Never buffer until
  a newline.
- **The frontend talks to the core only through one `Transport` interface.** No shell APIs in
  frontend code, apart from one small module that obtains the core's address and token from
  whichever shell it's running in (and, since 2026-10-07, the shell's native folder picker for
  "Open folder…", when it has one).
- **The shells contain no app logic.** Window creation, starting and stopping `gako-core`, passing
  the address and token, and the native dialogs only a shell can show (the folder picker, the
  warning before quitting with agents running). Nothing else.

## Repository layout

```text
gako/
  AGENTS.md, CLAUDE.md, README.md
  docs/PLAN.md, docs/PHASE0.md
  core/              Rust workspace
    gako-core/       the core binary
    tui-load/        synthetic agent-TUI output generator (see below)
  frontend/          TypeScript + Vite, Monaco, xterm.js; no UI framework
  shells/tauri/      Tauri 2 shell
  shells/electron/   bare Electron shell
  bench/
    fixtures/        generators for test data (generated files are gitignored)
    measure/         memory and timing scripts
    results/         one Markdown file per platform run, committed
    RUNNING.md       how to run the whole suite on a fresh machine
```

**Toolchain:** Rust stable via rustup; Node.js LTS or newer with npm workspaces; plain TypeScript
built with Vite; no UI framework (it would add memory to both shells and blur the comparison).
Use current stable versions at the start and pin them in the lockfiles. Python 3 with `psutil` for
the memory script.

## What to build

### Frontend (one build, loaded by both shells)

- A **diff view**: Monaco's diff editor, read-only, side by side, showing the generated 5,000-line
  diff.
- A **file view**: Monaco read-only editor showing the generated 5 MB file.
- **Terminal tabs**: xterm.js with the WebGL renderer by default and a setting to use the DOM
  renderer instead. Scrollback 1,000 rows by default, configurable. Fixed size for measurements:
  200 columns × 50 rows. Release the WebGL context when a tab is hidden and recreate it when shown.
- **Built-in timing**: diff-open time and file-open time (`performance.now()` from request to first
  render), frames per second during a scripted scroll, and keystroke-to-echo time (from `keydown` to
  xterm.js rendering the echoed character). Shown in a small overlay and written to a log the
  measurement scripts can read.

### Test data and load (`bench/fixtures`, `core/tui-load`)

- **Sample workspace:** a base Git repo with five nested, independent repos (not submodules), each
  with a few uncommitted changes. Generated by a script, so it's identical on every machine.
- **Diff fixture:** two versions of a 5,000-line source file with scattered changes.
- **Large file:** a 5 MB source-like text file.
- **Dumps, 250 MB each:** normal line-oriented log output; very long lines with few newlines; long
  runs of combining characters mixed with emoji sequences (ZWJ families, flags, skin-tone modifiers).
  Plus a 50 MB log for the load test. Each dump prints its elapsed time when it finishes.
- **`tui-load`:** a small program that behaves like an agent TUI in a terminal: colored output,
  cursor movement, partial-screen redraws, a spinner, bursts of streamed text, about 30 redraws a
  second. Four of these stand in for the four agents, so measurements don't need logged-in real
  agents. Also do one manual sanity run with real agents (`claude`, `codex`), recorded separately.

### Measurement (`bench/measure`)

- **Memory:** a Python script that takes a root process id, walks its whole process tree, and sums
  unique memory (USS via `psutil`) at fixed intervals. It follows every rule in PLAN.md's "How to
  measure it": tree walk from the root, never by process name, two-minute settle, record the tool
  versions. On macOS also record `footprint` for the same processes as a cross-check.
- **Timing:** reads the frontend's timing log and the dumps' elapsed-time output.
- **Results:** writes `bench/results/<platform>-<shell>-<date>.md` with every row of PLAN.md's
  table, the pass/fail result, and all pinned settings (scrollback, renderer, terminal size,
  water marks, versions).

### VS Code baseline

The same scenarios in VS Code on the same machine: the sample workspace open, the same diff in its
diff editor, one idle terminal; then four `tui-load` terminals and the dumps. Pin
`terminal.integrated.scrollback`, `terminal.integrated.gpuAcceleration` and the terminal size to
match, and measure with the same script. `bench/RUNNING.md` must include the exact VS Code settings
and steps.

## Who does what

| Step | Agent | Sena |
|---|---|---|
| Install prerequisites on this Mac (Rust via rustup, etc.) | Asks first, then installs | Approves |
| Build core, frontend, both shells, fixtures, `tui-load`, scripts | ✓ | |
| Run the full suite on macOS, including the VS Code baseline | ✓ | |
| Write `bench/RUNNING.md` so the suite runs on a fresh machine | ✓ | |
| Check the thresholds against VS Code before any Gako run, and record any adjustment | Prepares the numbers on macOS | Confirms, and repeats on Windows |
| Run the suite on the Windows work machine and on Linux | | ✓ |
| Real-agent sanity run | On macOS if agents are available | On Windows |
| Apply PLAN.md's decision rule and record the outcome | Drafts it from the results | Decides |
| Trial week (see PLAN.md) | | ✓ |

## Done means

- Results files for macOS, the Windows work machine and Linux, each covering both shells and the
  VS Code baseline.
- The Tauri-or-Electron decision applied by PLAN.md's rule and recorded in PLAN.md, with links to
  the results files. If a judgment call was needed (the "built into the engine" case), the written
  choice is recorded too.
- PLAN.md updated with anything the results changed: scrollback default, water marks, bytes per
  cell, the WebGL context limit.

## Outcome

Against *Done means*:

- **Results files:** macOS and Linux, each with both shells and the VS Code baseline, in
  [`bench/results/`](../bench/results/). **The Windows work machine wasn't run**; running the
  suite there wasn't practical at the time.
- **Decision:** Electron, as a written choice that departs from the rule (which gives Windows the
  deciding vote). Recorded in PLAN.md with the reasons and the costs accepted.
- **PLAN.md updated** with what the results changed: the macOS memory metric and process walk, the
  terminal-size pin, and the confirmed combining-character trap. The scrollback default (1,000
  rows) and the water marks (512 KB / 128 KB) held, so they stay. Bytes per cell and the WebGL
  context limit weren't measured; zero context losses showed in about 1,800 tab switches across
  all cycle runs with four agent tabs.

**Does the terminal plan hold?** On macOS and Linux, yes. No byte was lost or garbled in any run;
keystroke-to-echo stayed under 30 ms in Electron, also under load; backpressure kept memory flat for
line-oriented and long-line output; and no process outlived a closed tab, a quit or a crash.
Combining characters are the exception, for xterm.js's storage rather than our pipeline: a byte
budget per tab is phase 2 work. ConPTY on Windows is untested.

**Not done, carried forward:** the real-agent sanity run (`claude`, `codex`) and the
minimize-and-restore check during tab cycling. Both belong with phase 2's terminal tabs, and with
the first use on the Windows work machine.

## Out of scope for phase 0

The Git panel, file explorer, search, navigation, language servers, ACP, installers and code
signing, auto-update, settings UI. If something feels needed to make a measurement work, add the
smallest version that does, and note it in the results.
