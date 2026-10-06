# Phase 2 brief

The working brief for phase 2: terminal tabs, one per agent, with a status strip. Read
[PLAN.md](PLAN.md) first (*Agents: terminal now, ACP later*, and the terminal items under *Known
traps*). Phase 0 already proved the terminal pipeline (PTYs, backpressure, xterm.js, WebGL release
on hide); this phase turns it into the app's terminal.

**Status: built and measured on macOS (2026-10-06)**: every row of phase 0's table re-run with the
app's terminal code passes, the combining-and-emoji dump included
([results](../bench/results/macos-electron-phase2-2026-10-06.md)). Still to do, at the end: the
real-agent run with `claude` and `codex`, and Windows and Linux. Decisions were taken without a
review round, at the user's request; they're listed at the end and can be changed.

## What phase 2 delivers

- **Terminals for agents**: each runs a shell or an agent (`claude`, `codex`, or any configured
  command) in the base folder or one of its repos. The harness TUIs are untouched: Gako never
  replaces them (PLAN.md).
- **An agent bar** on the right (it replaced the first build's terminal tabs and status-bar chips;
  see decision 1): one entry per terminal with its name, folder and state, working (output in the
  last two seconds), quiet, exited or failed (with the exit code). Picking one shows its terminal in
  the main area. A terminal that finishes a stretch of work while you aren't looking at it is
  marked, bold with a blue dot, until you look.
- **Terminals sized to the window** (phase 0 used a fixed size for measuring), resized with it.
- **The combining-character limit** from phase 0's results: a run of more than 4 combining marks on
  one character is dropped whole, keeping the character, which keeps a tab's memory bounded (see
  *Results that shaped this phase*).
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

So xterm.js's own cost comes from long combining-mark runs, not emoji. But cutting runs to 8 marks
then backfired in the real app. Re-running phase 0's third dump in Electron with the WebGL renderer
(memory over the whole process tree; the growth was all in Chromium's GPU process):

| Emoji dump | Time | Peak memory | GPU process |
|---|---|---|---|
| No limit (phase 0) | 19.5 s | 1.3 GB | 0.6 GB |
| Runs cut to 8 marks | 7.2 s | 6.2 GB, 8 GB afterwards | 7.8 GB |
| Runs cut to 8, glyph atlas cleared at 256 MB | 10.9 s | 12.8 GB | 12.5 GB |
| Runs cut to 8, DOM renderer | 165 s | 0.6 GB | 0.2 GB |
| At most 1 mark kept | 4.4 s | 0.5 GB | 0.1 GB |
| **Runs over 4 dropped whole** | **4.7 s** | **0.45 GB, flat** | **0.1 GB** |

The WebGL renderer caches every distinct stack of marks as a glyph in its texture atlas, held by the
GPU process. Illegible 300-mark stacks happen not to be cached, but cut to 8 random marks they're
small enough, and almost every one is new, so the cache grows without end; clearing the atlas
doesn't hand the memory back. What bounds it is limiting the variety, not the length. Real writing
stays within 4 marks per character (Vietnamese, Thai, Hebrew with points, Indic scripts), and a
longer run is noise, so a run over 4 is dropped whole and the character it sat on is kept.

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
   *Changed after the user's first trial (2026-10-06):* terminals moved to a collapsible agent bar on
   the right, which also shows their states, so the status-bar chips went. The top tab bar now holds
   only diffs, files and histories, as VS Code's editor tabs do: a single click opens a preview tab
   (in italics) that the next one replaces, and a double click keeps it. A terminal and the
   documents take turns in the whole main area.
   *Finished, unseen:* output that lasted at least 1.5 s after the user's last keystroke, then
   stopped (or the program exited), while that terminal wasn't in front of a focused window. The
   keystroke rule keeps the echo of typing from counting as work. Reading an agent's own signals
   (waiting for input, for instance) is the next step.
   *What the agents send (recorded 2026-10-06 with `GAKO_RECORD_DIR` and
   `bench/measure/agent_signals.py`):* Claude Code titles itself with a spinner (◐ ◑) while working
   and ✳ otherwise, the same when finished and when waiting for approval, with no bell. Codex uses a
   braille spinner while working, a plain title when idle, and `[ ! ] Action Required` (blinking
   once a second, so output alone reads it as working) while waiting for approval. OpenCode keeps a
   fixed title but asks whether the terminal supports OSC 99 notifications, which xterm.js doesn't
   answer. Pi sends nothing beyond a fixed title. *States from titles* (built
   2026-10-06, `frontend/src/app/agentstate.ts`): once a program shows a spinner or one of these
   markers in its title, its title decides between working, waiting for you (yellow, and marked
   like a finished turn) and quiet; output alone no longer counts for it. The agent bar shows the
   title's topic next to the state. Not built yet: a Claude Code hook (through `--settings`) to tell
   its approvals apart, and answering OpenCode's OSC 99 query.
2. **New tabs:** a menu picks the program (shell, or a configured agent found on the PATH) and the
   folder (the base folder or a repo; the repo of the selected file comes first).
3. **Settings:** `agents` (name and command; Claude Code, Codex, OpenCode and Pi by default, each offered
   only if it's on the PATH),
   `terminalScrollback` (1,000), `terminalRenderer` (`webgl` or `dom`), `terminalFontSize` (12),
   `terminalFontFamily`, `terminalMaxCombining` (4; 0 turns the limit off).
4. **Closing a tab** with a running program asks first. An exited tab stays open, with its output,
   until closed, and can be restarted.
