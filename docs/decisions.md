# Decisions

The choices that shape Gako, why they were made, and what they cost. Read these before changing
one of them: each was made for a reason that isn't always visible in the code.

## A focused app, not a fork of VS Code or Zed

**Decision:** build a new app that does one thing, rather than strip down an existing editor.

**Why:**

- **A VS Code fork inherits what it set out to escape.** VS Code now ships a feature release every
  week; a fork either rebases on every one forever or falls behind on Electron and Chromium security
  fixes. The weight lives in its tightly wired core, so stripping the workbench saves little memory.
  Forks are also shut out of Microsoft's extension marketplace, and that's enforced.
- **The view that's needed can't be had inside VS Code.** It shows one Source Control section per
  repository, clean ones included, and declined to hide those without changes
  ([microsoft/vscode#33334](https://github.com/microsoft/vscode/issues/33334)). An extension can add
  a view of its own beside it, but you'd still be inside VS Code.
- **Zed keeps Git state per project**, so the multi-repository view would have to be built anyway,
  in a harder stack.
- **Fully native means writing a diff view, a viewer and a terminal three times**, when good
  standalone ones exist.

**Cost:** everything an editor gives for free has to be chosen deliberately, and most of it is left
out on purpose (see [scope.md](scope.md)).

## Gako never edits code

**Decision:** the viewer and diffs are read-only everywhere; editing is handed to an external
editor.

**Why:** agents do most of the editing, your editor does the rest, and an editor inside Gako would
be the largest and most demanding part of it. Keeping Monaco read-only keeps the line clear.

**Cost:** you switch to your editor for hand edits, which "Open in editor" makes one click.

## Electron, not Tauri

**Decision:** Electron is the app's shell. Tauri was the first choice, and was measured against
Electron with the same frontend and core before anything else was built.

**Why:** the measurements, on macOS and Linux:

| | Tauri | Electron | VS Code |
|---|---|---|---|
| Memory idle, macOS | 345 MB | 204 MB | 1,495 MB |
| Memory idle, Linux | 240 MB | 147 MB | 1,244 MB |
| Scrolling a large diff, Linux | about 28 fps | 60 fps | |
| Keystroke to echo in an agent's terminal, Linux (p95) | 33 ms | 21 ms | |

The expected advantage didn't hold: Electron used *less* memory than Tauri on both platforms, and
both used a fraction of VS Code's. The weight Gako escapes is VS Code's workbench and extensions,
not Chromium. And Tauri on Linux, through WebKitGTK, missed the scrolling and terminal budgets that
Electron met. Electron is also the stack VS Code runs on Windows every day.

**Cost:** Chromium updates are Gako's to ship (Electron supports each major version for about 24
weeks); a download of about 100 MB against Tauri's 10 MB; an extra Node.js process; and on Linux,
Chromium's sandbox needs a setuid helper on some systems.

**Evidence:** [bench/results/](../bench/results/), the `macos-*` and `linux-*` files for each.

## The core is a separate Rust process

**Decision:** the system-facing work lives in `gako-core`, a Rust binary the shell starts, and the
frontend talks to it over a loopback WebSocket with a one-time token.

**Why:** Electron can't call Rust directly, and a native Node.js add-on would tie the core to Node's
binary interface and to Electron. A separate process keeps the core in Rust, lets the same frontend
run in any shell or a plain browser, and made the Tauri-or-Electron comparison a fair one.

**Cost:** a socket and a second process, and a protocol to keep in step on both sides (see
[architecture.md](architecture.md)).

## Reuse Monaco, xterm.js, ripgrep and git

**Decision:** Monaco for the viewer and diffs, xterm.js for terminals, ripgrep's crates for search,
and the `git` CLI for Git, rather than writing any of them.

**Why:** they're battle-tested and already solve their problems; time spent rebuilding them is
time not spent on what's new. Monaco's diff editor already does side-by-side, word-level,
highlighted diffs, and it's the one VS Code users know. The `git` CLI behaves exactly as the user's
own `git` does, configuration, hooks and credential helpers included, which a library can't
promise.

**Cost:** Monaco is large for a read-only viewer, and running `git` is slower than a library
would be. If `git status` ever becomes the bottleneck, `gix` is the fallback.

## No UI framework

**Decision:** the frontend is plain TypeScript, with a small helper for building the DOM.

**Why:** a framework adds memory and a dependency to keep current, for an interface that's mostly
lists, tabs and two large components (Monaco and xterm.js) that manage their own DOM anyway.

**Cost:** more code by hand for updating the DOM.

## Agents run in terminals, not a chat interface

**Decision:** each agent runs in a terminal with its own interface. Gako doesn't drive agents
through the Agent Client Protocol (ACP) or offer a chat view of its own.

**Why:** the agents' own terminal interfaces are good, and they're what their users know. ACP would
make some supervision easier (which files an agent touched, when it waits), but supporting it means
building a whole chat interface: streaming conversation, tool calls, permission prompts. Several
agents also reach ACP only through third-party adapters. And many agents have no ACP mode at all,
so terminals would be needed anyway.

**Cost:** what an agent is doing has to be read from what it sends a terminal: titles, notifications
and output (see [terminals.md](terminals.md#how-gako-knows)), which works well for some agents and
little for others.

## No staging or committing

**Decision:** Gako has no commit box and no staging. Each repository offers fetch, pull
(fast-forward only), push, switching branch, and reverting a file's changes.

**Why:** the first builds had VS Code-style staging and a commit box per repository. In real use,
agents staged and committed, and the boxes were clutter. What's left is what keeps you in sync and
undoes mistakes.

**Cost:** committing by hand means a terminal or your editor.

## Navigation by name, not by language servers

**Decision:** go to definition uses a project-wide index of definitions, built with tree-sitter's
tag queries, not language servers.

**Why:** an index needs no per-language setup and works the same across every language in every
repository, which suits a read-only viewer spanning many services. It builds in under a second on a
100-repository layout, and a definition lookup takes under a millisecond.

**Cost:** it resolves by name, not by binding. A common name matches many definitions, which Gako
offers as a list, and "find references" is a whole-word search. Language servers would be the way
to binding-accurate navigation, through `monaco-languageclient`, with the core only starting them
and relaying messages; that's a large step and hasn't been needed.

## Backpressure for terminal output

**Decision:** a terminal's program is paused when the window falls behind, rather than its output
being buffered without limit or dropped.

**Why:** a fast program can write far more than a window can draw. Buffering grows memory without
bound; dropping loses output. Backpressure is what a real terminal does, and what VS Code does.
With scrollback capped at 1,000 rows (VS Code's default), a terminal's memory stays flat however
much is written.

**Cost:** a program writing faster than Gako can draw is slowed to Gako's pace. In practice Gako
draws large dumps faster than VS Code: four to eight times faster on macOS.

## Combining marks: bound the variety, not the length

**Decision:** a run of more than 4 combining marks on one character is dropped whole.

**Why:** measured: cutting runs short made memory worse, because the renderer caches every distinct
stack of marks. See [terminals.md](terminals.md#long-runs-of-combining-marks).

**Cost:** pathological text loses its marks. Real writing stays within 4 per character.

## "Open in editor" never uses the system's default app

**Decision:** Gako finds known editors on the `PATH` and in their install locations, or uses a
configured command, and never falls back to opening a file with the operating system's default app.

**Why:** an early build did fall back, and it opened images in a viewer, offered to run shell
scripts, and ignored the line. VS Code's `code` command often isn't on the `PATH`, which is why the
fallback kicked in, so Gako now looks inside installed apps too.

**Cost:** with no editor found, "Open in editor" says so instead of doing something.

## Settings only from your own file

**Decision:** Gako reads settings only from the user's settings file; folders it opens have no
settings of their own.

**Why:** settings include the commands Gako runs for agents and the editor. A per-folder settings
file would let a repository choose those commands, and nobody used per-folder settings anyway.

**Cost:** different layouts can't have different scan settings.

## Budgets measured against VS Code

**Decision:** performance budgets are set relative to VS Code on the same machine, chiefly memory:
at most half of VS Code's idle, and no more under load. They were set before the first measurement,
and the method is fixed.

**Why:** "lighter than VS Code" is part of why Gako exists, and it's only true if it's measured the
same way each time. See [performance.md](performance.md).

**Cost:** measuring needs VS Code installed, and a quiet machine for over an hour.
