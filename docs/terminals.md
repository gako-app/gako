# Terminals and agents

Gako runs agents in real terminals and leaves their interfaces alone. What it adds is supervision:
which agents are working, which have finished, and which are waiting for you.

## Starting a terminal

The **+** button in the agent bar picks a program and a folder:

- **The program:** your shell, or one of the agents in the `agents` setting. By default those are
  Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`) and Pi (`pi`), each offered only if
  it's found on the `PATH`. Any program with a command line can be added; see
  [settings.md](settings.md).
- **The folder:** the base folder or one of its repositories. The repository of the file you're
  looking at comes first.

A terminal runs its program in a pseudo-terminal (ConPTY on Windows), with your login shell's
environment on macOS and Linux (see [architecture.md](architecture.md#platform-specifics)). The
plain shell is your login shell, or PowerShell on Windows.

## The agent bar

The bar on the right lists every terminal: its name, its folder, its state, and what the agent says
it's working on. Picking one shows its terminal:

- **Single pane:** the terminal takes the main area in turn with the files and diffs.
- **Dual pane:** the terminal gets a pane of its own beside the documents, sized by dragging the
  separator.

The switch at the right of the tab bar picks between them, and Gako remembers the choice and the
size. Dragging an entry moves it up or down the bar, and Escape during the drag puts it back. A
middle click or the × closes an entry, asking first if its program is still running. ⌘W (Ctrl+W
off macOS, except inside a terminal, where it stays with the shell) closes the tab in front, and
Ctrl+Tab steps through terminals when one is in front.

### States

| State | Meaning |
|---|---|
| Working | The agent says it's working, or the program wrote output in the last two seconds |
| Quiet | Nothing is happening |
| Waiting for you (yellow) | The agent asked for approval or sent a notification |
| Exited, failed | The program ended; failed shows its exit code |

A terminal that **finishes a stretch of work while you aren't looking at it** is marked, bold with
a blue dot, until you look. A stretch of work is output that went on for at least 1.5 seconds after
your last keystroke and then stopped, so the echo of your own typing doesn't count.

### How Gako knows

Output alone is a poor signal: a blinking cursor or a redraw looks like work, and an agent waiting
for approval looks like one that's finished. So Gako reads what the agents themselves send:

- **Titles.** Several agents set the terminal's title to show their state. Once a program's title
  shows one of these markers, the title decides its state instead of its output:

  | Agent | Working | Waiting for you | Otherwise |
  |---|---|---|---|
  | Claude Code | `◐ topic` (a turning circle) | the same as finished | `✳ topic` |
  | Codex | `⠦ topic` (a braille spinner) | `[ ! ] Action Required \| topic`, blinking | `topic` |
  | OpenCode, Pi | a fixed title: nothing to read | | |

- **Notifications.** A desktop notification sent through the terminal (OSC 9, OSC 777, or kitty's
  OSC 99, whose support query Gako answers) marks the agent as waiting for you and shows its text.
  Gako doesn't raise system notifications of its own.
- **Claude Code's approvals.** Claude Code shows the same title whether it has finished or is
  waiting for approval, but it runs a Notification hook for the second. Gako starts `claude` with
  one more hook, passed with `--settings` (which Claude Code adds to your own settings rather than
  replacing them). The hook runs `gako-core notify`, which writes an OSC 9 notification to the
  agent's terminal, named in `GAKO_TTY`: Claude Code runs hooks without a terminal of their own.
  The `agentHooks` setting turns this off. It works on macOS and Linux; on Windows, Claude Code's
  approvals aren't told apart from a finished turn yet.

OpenCode and Pi send nothing beyond output, so for them Gako has only output and its timing to go
on.

To see what an agent sends, start Gako with `GAKO_RECORD_DIR` set: every terminal's output and
input are recorded there, one JSON line per read, and `bench/measure/agent_signals.py` lists the
titles, notifications, bells and bursts of output in a recording.

## Closing, quitting and reopening

- **Closing a terminal** whose program is still running asks first. A terminal whose program has
  exited stays open, with its output, until you close it, and its agent can be restarted in place.
- **Ending a program** works as a terminal closing does: the program gets SIGHUP. Some programs
  ignore it, Claude Code among them, or leave children behind, so on macOS and Linux the program's
  whole process group then gets SIGTERM and, if that doesn't end it, SIGKILL. On Windows the program
  is ended, but programs it started may outlive it.
- **Quitting Gako** with agents running asks first, and names them.
- **Reopening:** Gako remembers, per base folder, the terminals that were open and reopens them:
  the same program in the same folder, as a new session. Agents' conversations aren't resumed.

## Output

- **Scrollback** is 1,000 rows per terminal by default, as in VS Code (`terminalScrollback`).
  Scrollback is a terminal's main memory cost, roughly rows × columns × bytes per cell, so the
  default is a memory decision as much as a convenience.
- **Rendering** uses xterm.js's WebGL renderer, or the DOM renderer (`terminalRenderer`). A hidden
  terminal releases its WebGL context and gets it back when shown, so many terminals don't run into
  the browser's limit on live WebGL contexts.
- **Links** in output open in your browser.
- **Nothing is lost or reordered** between the program and the screen, however fast it writes: the
  pipeline uses backpressure, described in [architecture.md](architecture.md#terminal-flow-control).

### Long runs of combining marks

One kind of output needs a limit: long runs of combining marks stacked on one character ("zalgo"
text, or a binary file dumped by mistake). They cost memory twice. xterm.js keeps a character's
marks as a growing string on its cell, and the WebGL renderer caches every distinct stack of marks
as a glyph, held by Chromium's GPU process.

Measured by dumping 250 MB of random combining runs mixed with emoji sequences into one terminal:

| Rule | Time | Peak memory | GPU process |
|---|---|---|---|
| No limit | 19.5 s | 1.3 GB | 0.6 GB |
| Runs cut to 8 marks | 7.2 s | 6.2 GB, 8 GB afterwards | 7.8 GB |
| Runs cut to 8, glyph atlas cleared at 256 MB | 10.9 s | 12.8 GB | 12.5 GB |
| Runs cut to 8, DOM renderer | 165 s | 0.6 GB | 0.2 GB |
| At most 1 mark kept | 4.4 s | 0.5 GB | 0.1 GB |
| **Runs over 4 dropped whole** | **4.7 s** | **0.45 GB, flat** | **0.1 GB** |

Cutting runs short made it worse: small random stacks are cacheable, and nearly every one is new,
so the cache grows without end, and clearing it doesn't give the memory back. What bounds it is
limiting the variety, not the length. Real writing stays within 4 marks per character (Vietnamese,
Thai, Hebrew with points, Indic scripts), so a run of more than 4 is dropped whole and the character
it sat on is kept. `terminalMaxCombining` changes the limit; 0 turns it off.

Emoji sequences (families joined with zero-width joiners, flags, skin tones) don't need the limit:
they cost little, and they're kept as they are.

### Ligatures

Off by default; `terminalFontLigatures` turns them on. A terminal draws each character in its own
cell, so the browser can't join `=>` or `!=` into one sign on its own: xterm.js's ligatures addon
reads the font's file, finds its ligatures, and tells the renderer which characters to draw
together. Both renderers support it.

- **The font's file** comes from the browser's local font access, the first family in
  `terminalFontFamily` that's installed. Electron allows it because Gako has no permission handler;
  if one is added, it has to allow `local-fonts`. In a plain browser (development), the browser asks.
  When the font can't be read, a fixed set of common ligatures is used instead.
- **Fonts without ligatures** (Menlo, Consolas, DejaVu Sans Mono) draw the same with the setting on.
- **Memory:** each terminal parses the font itself and keeps a cache of up to about 650 KB.
- **Cost:** every row drawn is searched for ligatures. It hasn't been measured; the harness can
  turn ligatures on with `GAKO_FONT_LIGATURES=1` and `GAKO_FONT_FAMILY` (see
  [bench/README.md](../bench/README.md#5-terminals-and-the-viewer)).
