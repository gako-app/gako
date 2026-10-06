# Phase 2 brief

The working brief for phase 2: terminal tabs, one per agent, with a status strip. Read
[PLAN.md](PLAN.md) first (*Agents: terminal now, ACP later*, and the terminal items under *Known
traps*). Phase 0 already proved the terminal pipeline (PTYs, backpressure, xterm.js, WebGL release
on hide); this phase turns it into the app's terminal.

**Status: in progress (2026-10-06).** Decisions were taken without a review round, at the user's
request; they're listed at the end and can be changed.

## What phase 2 delivers

- **Terminal tabs** next to the review area: each runs a shell or an agent (`claude`, `codex`, or any
  configured command) in the base folder or one of its repos. The harness TUIs are untouched: Gako
  never replaces them (PLAN.md).
- **A status strip** in the status bar: one chip per tab with its name and state, working (output in
  the last two seconds), quiet, or exited (with the exit code). Clicking a chip shows its tab.
- **Terminals sized to the window** (phase 0 used a fixed size for measuring), resized with it.
- **The combining-character cap** from phase 0's results: runs of combining marks longer than 8 on
  one character are cut, which keeps a tab's memory bounded (see *Results that shaped this phase*).
- **The user's shell environment:** apps started from the Dock or Start menu don't get the PATH a
  login shell sets up, so `claude` and `codex` wouldn't be found. The core reads the login shell's
  environment once at startup, as VS Code does, and uses it for terminals and git.
- **Links in terminal output** open in the browser.

## Results that shaped this phase

An experiment with xterm.js's headless terminal (30 MB of each kind of output, 1,000 rows of
scrollback, 112 columns) shows what grew in phase 0's third dump:

| Output | xterm.js heap afterwards |
|---|---|
| Plain text | 6 MB |
| Emoji sequences (ZWJ families, flags, skin tones) | 8 MB |
| Runs of 8–300 combining marks per character | 47 MB |
| The same, capped at 16 marks | 18 MB |
| The same, capped at 8 marks | 8 MB |

So the cause is long combining-mark runs, not emoji. Real text stays far below 8 marks per
character, and a run beyond that isn't legible, so the cap loses nothing anyone could read.

## Out of scope for phase 2

ACP and any chat interface; alerts when an agent waits for input, one worktree per agent tab and
"what changed since this agent's turn started" (all in PLAN.md's *Ideas for later*); keeping
terminals alive across app restarts; split panes.

## How we'll know it works

- Phase 0's terminal rows, re-run with the app's terminal code: four agents plus a 50 MB dump with
  nothing lost, echo under 30 ms, the three 250 MB dumps with memory flat **including the
  combining-and-emoji dump**, tab cycling with no lost WebGL contexts.
- The app: open, resize, hide and close tabs with agents running; no processes left behind.
- The real-agent sanity run with `claude` and `codex` (the user's, at the end of the process).

## Decisions (2026-10-06)

1. **Layout:** the main area gets a tab bar: *Review* (the diffs and history from phase 1) and one tab
   per terminal. The status strip lives in the status bar.
2. **New tabs:** a menu picks the program (shell, or a configured agent found on the PATH) and the
   folder (the base folder or a repo; the repo of the selected file comes first).
3. **Settings:** `agents` (name and command; Claude Code and Codex by default),
   `terminalScrollback` (1,000), `terminalRenderer` (`webgl` or `dom`), `terminalFontSize` (12),
   `terminalFontFamily`, `terminalMaxCombining` (8; 0 turns the cap off).
4. **Closing a tab** with a running program asks first. An exited tab stays open, with its output,
   until closed, and can be restarted.
