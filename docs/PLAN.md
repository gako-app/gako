# Gako — Plan

A lean, cross-platform workspace app for reviewing and supervising coding agents across many
repositories at once.

---

## The recommendation

**Build a new, focused cross-platform app. Do not fork VS Code, VSCodium, or Zed.**

The app owns **multi-repository review and agent supervision**. It deliberately does not own editing.

---

## Goal and alternatives considered

**The goal:** stop using VS Code for daily review and agent work, because of its bloat and
Microsoft's constant churn of unwanted features, while keeping the one thing no other tool does well:
VS Code-style Source Control across several independent repos cloned under one base folder.

**What success means:** on a normal working day, review, search, history and agent terminals all
happen in Gako. An editor opens only for hand edits, and if that editor is VS Code, it's open for
minutes, not all day.

Both halves matter. If the only problem were the Git panel, the cheapest fix would stay inside VS Code.

| Option | Multi-repo view | Bloat | Churn | Cost |
|---|---|---|---|---|
| Stay on VS Code, pin the version, trim extensions | No | No | Paused, at the cost of falling behind on fixes | Minutes |
| **Stay on VS Code, disable the built-in Git extension, use a multi-repo extension view** | Yes | No | No | An afternoon |
| Fork VS Code and strip it | Yes | No (see *Why not fork*) | Traded for a permanent rebase burden | Permanent |
| **Build a focused app (this plan)** | Yes | Yes | Yes | Months |

**The extension route is rejected as the end state but adopted as interim relief.** It fixes the Git
panel but leaves you inside the product you want to leave. It's also the fallback if this project
stalls, and the trial week in the build order uses it to learn exactly what's still painful.

**When staying on VS Code is the right answer:** if the extension view makes multi-repo review
comfortable *and* VS Code's weight and churn are tolerable day to day, stay. Install the extension,
pin the version, and stop. That's a good outcome, not a failure.

**Only half of that is measured.** The trial week tests whether the Git pain goes away. Whether the
bloat is tolerable is a judgment, not a measurement. To keep it honest, the trial week includes a
log of both frictions and sessions where VS Code was fine (see *Trial week* in the build order), and
phase 0 measures VS Code's memory against the alternatives on the same machine.

---

## Why not fork

### A VS Code fork inherits the problem instead of escaping it

- **Release churn never stops, and it has sped up.** VS Code released monthly through 1.110 (March 4,
  2026). Since 1.111 (March 9) it ships a new feature release every week, plus patches: 42 stable
  releases from 1.111.0 to 1.140.0 (September 30), about 1.4 a week, with 8 in September alone.
  *(Checked 2026-10-05: GitHub releases API for `microsoft/vscode`, non-prerelease `1.x` tags from
  1.111.0 on.)* You either
  rebase on every release forever, or freeze and fall behind on Electron and Chromium security
  updates. There is no third option.
- **A fork is the only way to change the built-in Source Control panel itself.** The author of a
  multi-repo extension states that *"Extensions cannot modify the native SCM panel because VSCode's
  renderer DOM is not part of the extension API surface"*
  ([meta-repo-source-control](https://github.com/mattgle/meta-repo-source-control); the quote is
  accurate, the assertion is the extension author's and hasn't been checked against VS Code's
  source). An extension *can* replace the panel with its own view; that cheaper option is weighed
  under *Goal and alternatives considered* above.
- **The bloat doesn't come out.** It lives in the tightly wired core, not in the features you can
  switch off. No published measurement supports large lightness wins from workbench-level stripping;
  the Electron/Chromium memory floor stays. You'd get less telemetry, fewer built-in extensions, and
  control over updates — but the same footprint, plus a permanent rebase burden.
- **The Microsoft Marketplace is closed to forks.** *"alternative products including those built on
  a fork of the Code - OSS Repository, are not permitted to access the Visual Studio Marketplace"*
  ([VS Code FAQ](https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/supporting/faq.md)),
  and it is enforced — the C/C++ extension stopped working in VSCodium and Cursor in April 2025
  ([The Register](https://www.theregister.com/software/2025/04/24/microsoft-subtracts-c/c-extension-from-vs-code-forks/721912)).
  Even funded forks reportedly lag badly: Cursor was said to sit roughly nine months behind upstream
  (*unverified*; [Cursor forum](https://forum.cursor.com/t/any-plans-to-keep-up-with-vscode/155147)).

### A Zed fork doesn't help either

Zed keeps git state **per project** — *"Each project has its own file tree, git state, and search
scope"* ([Zed docs](https://zed.dev/docs/windows-and-projects)). The multi-repo aggregator is the
one thing you actually need, so you'd rebuild it anyway, in a harder stack (Rust and GPUI, where
GPUI is itself a fork-pinned dependency), under copyleft: the editor is GPL-3.0-or-later, with some
components under Apache-2.0 ([Zed README](https://github.com/zed-industries/zed#licensing);
*checked 2026-10-05*), so a distributed fork must itself be GPL-3.0. That matters for anything you might ship.

### Fully native is three times the work

macOS, Windows, and Linux would mean writing the editor, diff view, and terminal three times. The
parts you need already exist as standalone libraries.

---

## The wedge

**VS Code renders one full Source Control section per repository — including a commit box and Commit
button for every repo, even clean ones.** Twenty sibling repos means twenty commit boxes. You can
pick which repos are shown, but as far as we know nothing hides clean ones automatically. And that
isn't an oversight waiting to be fixed. The 2017 request for it
([microsoft/vscode#33334](https://github.com/microsoft/vscode/issues/33334), "SCM: hide views for
repositories without changes") was declined in discussion by the maintainer ("this will make things
very jumpy"), who pointed to manual repo selection instead, and the issue was auto-closed a week
later. It is not open, despite what earlier drafts and the extension's README say. That's a design
position, so don't expect VS Code to change it. *(Checked 2026-10-05: GitHub issue and API.)*

Your layout — a base repository holding independent sibling checkouts, not submodules — is served by
exactly one editor, by accident, badly. Microservice shops, ROS workspaces, and teams that avoid
monorepos all have the same gap.

---

## Core design principle

**Reuse the primitives; do not rebuild them.** Monaco, xterm.js, ripgrep, and the `git` CLI are
battle-tested and already solve their problems. Keep the Rust core for the system-facing work: git,
search, file watching, process and PTY management. Every hour spent re-implementing a diff renderer
or a terminal emulator is an hour not spent on the multi-repo view, which is the only thing here
that nobody else has.

---

## Scope

**The app owns:**

- Finding repos and combining their status
- One review queue for changes across all repos
- Diff viewing with syntax highlighting
- Commit history and commit details
- Terminal tabs for agents
- File explorer
- Project search
- Read-only code navigation

**The app never owns:** editing, undo/redo, multi-cursor, workspace edits, debugging, notebooks,
extensions, a marketplace.

Editing is handed off with an "open in editor" action (`code -g file:line`, `zed file:line`, or a
configured command). The agents do most of the editing anyway, and this boundary is what keeps the
project to months rather than years.

> Using a read-only Monaco viewer does **not** violate this. Monaco is VS Code's editor, but the
> no-editing rule is a *product decision, not a technical limitation*. Keep Monaco strictly
> `readOnly` in every surface so the line never blurs.

---

## Stack

| Piece | Choice |
|---|---|
| App shell | Electron, with the core in Rust as a separate process (decided after phase 0; see *Host decision*) |
| Terminal | xterm.js + `portable-pty` (ConPTY on Windows) |
| Viewer and diff | Monaco (VS Code's own editor and diff viewer), read-only |
| Highlighting | Monaco's built-in highlighting with TextMate grammars |
| Search | ripgrep's Rust crates (`grep`, `ignore`), run inside the app |
| File tree and watching | `ignore` to walk folders, `notify` with debouncing to watch for changes |
| Git | The `git` CLI (`gix` later if something needs to be faster) |
| Go to definition | A project-wide symbol index built with tree-sitter or ctags first; language servers via `monaco-languageclient` later, for precision |
| Agents | PTY terminal tabs (always). ACP is a deliberate later phase, not a toggle — see below |

**Why Monaco rather than a custom renderer:** its diff editor already does side-by-side, word-level,
syntax-highlighted diffs, and it's the interface you already have muscle memory for. A custom diff
renderer would be risk with no differentiation. Switch to the `similar` diff library with your own
renderer **only if** Monaco struggles on very large diffs — don't pay that cost up front.

**Why a symbol index before language servers:** tree-sitter parses one file at a time, but a
*project-wide index* built from it (the approach ctags and GitHub's code navigation use) can jump
across files, needs no per-language setup, and works uniformly across every language in every repo.
That suits a mostly read-only viewer spanning many services.

**Its honest limit:** an index resolves by *name*, not by *binding*. `Handler` may match twenty
things across repos, and it cannot do reliable find-references. Add language servers through
`monaco-languageclient` for the languages where you need binding-accurate definition and references.
In that setup, Rust only starts the servers and relays messages — do not write an LSP client from
scratch.

---

## Host decision and the hedge

**Electron, decided on 2026-10-06 after phase 0.** The plan started as "Tauri 2 first, Electron as
a documented fallback"; the measurements changed that.

**What the plan assumed:** pages that work in WebKit-based web views almost always work in Chromium,
so falling back from Tauri to Electron is cheap, while building on Electron first risks shipping on
"Electron's much larger memory baseline". The known risk was WebKitGTK on Linux.

**What phase 0 measured** on macOS and Linux
([results](../bench/results/), summarized under *Phase 0: pass/fail criteria*):

- **The memory premise didn't hold.** The same frontend in Electron used less memory than in Tauri
  on both platforms when idle (204 vs 345 MB on macOS, 147 vs 240 MB on Linux), and both used 12–29%
  of VS Code's. The bloat this project escapes is VS Code's workbench and extensions, not Chromium.
- **WebKitGTK was the risk the plan named, and it showed:** Tauri on Linux failed both scroll rows
  (about 28 and 49 fps against 50), its agent-TUI echo (p95 33 ms against 30) and the emoji dump's
  time against VS Code. Electron passed all of them.
- Every row Electron failed, Tauri failed too (the combining-and-emoji dump's memory; see the
  very-long-lines trap). That's frontend work in either shell.

**The written choice.** The pre-registered rule gives the Windows work machine the deciding vote
and treats a Tauri failure only on Linux as "still Tauri". Windows wasn't measured: running the
suite there wasn't practical at the time. Weighting macOS and Linux equally instead, the rule's
own main clause applies (Tauri fails a non-memory measure that Electron passes, and Electron passes
memory), so the choice is **Electron**. This departs from the rule as written, deliberately, for
those two reasons.

**What Windows leaves open.** Electron is the lower-risk choice there, since VS Code runs the same
stack (Electron, xterm.js, ConPTY) on Windows every day. But the terminal under load through
ConPTY, and memory and speed on the work machine itself, are unmeasured. Phase 1 must be tried on
the Windows work machine early, and `bench/` can still run there if anything looks wrong.

**The costs accepted with Electron:**

- **Chromium updates are ours to ship.** Electron releases a new major version every 8 weeks and
  supports the latest three, so each version gets about 24 weeks. Budget an upgrade every couple of
  months, and plan auto-update into the first release. *(Checked 2026-10-06: Electron's release
  timelines page.)*
- **Install size:** roughly 100 MB to download and about 250 MB installed, against about 10 MB for
  Tauri. Disk, not memory.
- **Linux packaging:** Ubuntu 24.04 restricts the user namespaces Chromium's sandbox uses, so
  Electron's `chrome-sandbox` helper must be root-owned and setuid (or covered by an AppArmor
  profile) in every Linux package.
- **An extra Node process and a permanent loopback socket.** Electron's main process is Node.js,
  doing nothing but manage the window and the core. Electron can't call Rust directly, so the
  WebSocket to the core (loopback only, one-time token) stays.

**The hedge, kept:** the frontend stays shell-independent. UI code never calls Electron APIs; it
goes through the `Transport` interface, and the shell only manages the window and the core.

**Shape that interface for streams, not only request and response.** It has to carry two-way,
long-lived message streams: terminal output needs that from phase 0, and language servers would
need it in phase 5. Designing it that way now means phase 5 doesn't rework the boundary built to
avoid rework.

**The Rust core runs as its own process, and the frontend talks to it over a local WebSocket.**
The shell starts the `gako-core` binary and hands the frontend its address and a one-time token;
it only manages windows and the core's lifetime. In phase 0 this was what let the Tauri and
Electron builds differ in nothing but the web view. With Electron it's also the only option that
keeps the core in Rust: Electron can't call Rust directly, and a native Node add-on would tie the
core to Node's ABI. Details are in [PHASE0.md](PHASE0.md).

---

## The key feature: multi-repo git view

This is what makes the work setup usable, and no other tool tested handles it well.

**Parity with VS Code:**

- Find nested repos up to a configurable depth, plus any extra folders you configure to scan.
- Run `git status --porcelain=v2 -z --branch` for each repo and refresh it when files change.
- Show each repo with branch, ahead/behind, staged and unstaged files. *No commit box: after the
  first trial (2026-10-06), staging and committing are left to the agents, and each repo offers
  fetch, pull and push instead ([PHASE1.md](PHASE1.md), decision 1).*
- Clicking a file opens a Monaco diff, and the full file can be opened from there.
- Show commit history (`git log`) and commit details (`git show`) for each repo.
- VS Code's built-in git extension (`extensions/git`, MIT licensed) is the reference for edge cases:
  status parsing, rebase and merge states, conflicts, worktrees, unborn branches, detached HEAD.

**Beyond VS Code — this is why the app exists:**

- **Show only repos with changes.** Clean repos collapse or hide, so there isn't a commit box for
  every repo.
- **One review queue:** a combined change list across all repos, grouped by repo. This is the feature
  for reviewing an agent's edits across components. *The repos view became this list once commit
  boxes went, so it has no separate tab (2026-10-06).*
- **Scoped search:** a toggle for all repos, the base repo, or a chosen subset.
- Later: a combined history timeline across repos.

---

## Agents: terminal now, ACP later

**Phase 2 is plain terminal tabs**, one per agent, plus a status strip. This matches how you actually
work — you interact with harnesses through their own TUIs, and those TUIs are good. Don't replace
them.

**ACP (Agent Client Protocol) is a later, deliberate phase, not a toggle.** The reason it matters is
architectural: ACP is bidirectional, and the *client* owns the machine-facing surface — it
implements `fs/read_text_file`, `fs/write_text_file`, and `terminal/create`, `terminal/output`,
`terminal/wait_for_exit`. The terminal and viewer are not adjacent to agent integration; they *are*
the agent's I/O surface. ACP is also what makes supervision features cheap: knowing which files an
agent touched, and when it is waiting for input, comes free from structured events instead of
scraping terminal output.

**The reason to defer it:** ACP *replaces* the harness's own terminal UI. Supporting it means
building a chat-style interface — streaming conversation, tool-call rendering, permission prompts,
diff presentation. That's a large feature, and it's the one Zed built an entire Agent Panel for.

**Two things to check before investing:** which of your harnesses support ACP *natively* versus
through third-party adapters — Claude Code, Codex, and Pi appear to run through separate adapter
projects, so the path carries adapter-maintenance risk — and whether you actually want a structured
chat UI in place of the harness TUIs you already like.

**Guardrail:** ACP would sit alongside terminal tabs, never replace them. Plenty of harnesses have no
ACP mode, and more will appear without one.

---

## Build order

Each phase should be useful on its own.

| Phase | Deliverable | Replaces |
|---|---|---|
| **Trial** | One week of real work in the real work layout, including reviewing agent edits that span several repos: two days with VS Code's own panel limited to the repos in use, then five with the built-in Git extension disabled and a multi-repo extension view. Log frictions and fine sessions as they happen. Runs alongside phase 0, not before it | Nothing (tests the premise) |
| **0** | **Done 2026-10-06 (macOS and Linux; Windows not run): chose Electron.** **Feasibility test, on macOS, the real Windows work machine and Linux:** Monaco diff and viewer inside Tauri, **plus** xterm.js + `portable-pty` (ConPTY on Windows) running several real agent TUIs at once: throughput, redraw, resize, clean shutdown | Nothing (decides Tauri vs. Electron, and whether the terminal plan holds) |
| **1** | Multi-repo git panel, changed-repos-only tree, one review queue, Monaco diff, commit history and `git show` | The Source Control sidebar |
| **2** | Terminal tabs, one per agent, with a status strip | The terminal window |
| **3** | File explorer and read-only file viewer, with "open in editor" | The Explorer |
| **4** | Project search, scoped by repo | Project search |
| **5** | Go to definition and references: project-wide symbol index first (functions, classes, types), `monaco-languageclient` later for precision, and earlier for **variables**, which name-based indexing handles worst | Navigation |

**The trial week tests the premise; phase 0 tests the implementation.** Run them in parallel. The
trial isn't a gate, because the goal includes leaving VS Code's bloat, which an extension can't fix.
But whatever still hurts after a week of it is the clearest spec phase 1 will get.

### Trial week: decision rule (written before it starts)

The trial must cover the real use case: at least a few sessions where agents edit several repos and
you review all of their changes, not just occasional browsing.

**Two setups, in order:**

1. **Days 1–2: VS Code's own panel, curated.** Keep the built-in Git extension, and use the Source
   Control Repositories view to show only the repos you're working in. This is the workaround the VS
   Code maintainer pointed to, and it costs nothing to test.
2. **Days 3–7: the extension view**, with the built-in Git extension disabled.

If the curated built-in panel is already comfortable, the Git wedge is weaker still: treat it like
the first row of the table below.

**The log.** Write entries at the time, not from memory at the end of the week:

- **Every friction:** timestamp, what you were doing, what it cost (seconds waited, a context switch,
  a lost train of thought). "20-second wait while chasing a bug" is data; "it felt heavy" isn't.
- **Every session where VS Code was simply fine**, in one line. Without these, the log can only ever
  say "build it."
- **Every time you hit the top of a terminal's scrollback** in an agent session (VS Code's default
  is 1,000 lines). This decides whether Gako's scrollback default needs to be higher.

| After the week… | Then… |
|---|---|
| The extension view handles multi-repo review comfortably | The Git wedge is weak: an extension already covers it. Build only if the bloat log says VS Code's weight and churn still justify it. If you do build, **swap phases 1 and 2**: the terminal and agent cockpit is now the differentiator, so it comes first, and the Git panel can start as a simpler port of what the extension does. |
| It helps but specific things still hurt | Keep the order. Those specific things are phase 1's acceptance criteria. |
| It doesn't help, or you miss VS Code's own panel | Keep the order. The Git wedge is confirmed as the differentiator. |

Either way, the bloat log decides whether to build at all (see *When staying on VS Code is the right
answer*).

### Phase 0: pass/fail criteria (written before it runs)

Phase 0 builds one small frontend (Monaco diff and viewer, plus terminal tabs) and runs it in **both**
Tauri and a bare Electron shell on the same machines. That's cheap, because the frontend is
shell-independent by design, and it turns the decision into a comparison instead of a judgment.

Starting thresholds, to be checked against VS Code on the same machine before the test runs and
adjusted only then, never after:

| Measure | Pass |
|---|---|
| Open a 5,000-line diff (warm) | Under 300 ms |
| Scroll that diff | No visible stalls; at least 50 fps in the web view's performance tools |
| Open and scroll a 5 MB file | Opens in under 1 s, scrolls without stalls |
| Keystroke to echo in a terminal tab | Under 30 ms |
| Four agent TUIs running at once, plus dumping a 50 MB log in a fifth tab | Nothing lost or garbled between the PTY and the screen, the other tabs stay responsive, and the dump is no slower than in VS Code's terminal |
| Dump 250 MB (5× the log) into the same tab, three times: normal line-oriented output, then output with very few newlines and very long lines, then long runs of combining characters mixed with emoji sequences (ZWJ families, flags, skin-tone modifiers) | **Memory:** once scrollback is full, it stays flat in every run and doesn't grow with the amount dumped (see the flow-control trap). **Time:** each dump finishes no slower than the same dump in VS Code's terminal. Backpressure means a slow renderer never loses output; it stalls the agent instead, so dump time is the cost to watch |
| Hide and show terminal tabs repeatedly during the four-TUI load (switch tabs, minimize and restore the window) | No blank or garbled terminals after showing again, and memory doesn't creep up with each cycle. This exercises the WebGL release-and-recreate path (see the WebGL trap) |
| Resize, close tab, quit | Child processes always exit; no orphaned shells (check Task Manager / `ps`) |
| Cold start to usable window | Under 1.5 s |
| **Memory, idle:** the multi-repo work layout open, one diff showing (in phase 0, which has no Git panel: the sample workspace's 5,000-line diff showing plus one idle terminal tab; see [PHASE0.md](PHASE0.md)) | **At most half** of VS Code's, with the same workspace and the extensions you actually use |
| **Memory, under load:** the four-TUI test above | No more than VS Code running the same four agents in its own terminals |

**Run both memory rows twice, because they answer different questions:**

- **Matched settings** (same scrollback in both apps): is the shell leaner? This one drives the
  Tauri-vs-Electron decision.
- **Out of the box** (each app at its own defaults): will this machine actually use less memory than
  today? This is the one the project's goal rests on. If Gako loses it, revisit Gako's defaults
  (scrollback first), not the shell.

There is no typing-latency check for Monaco, because the viewer is read-only.

**Memory is the mission, not a side metric.** A build can pass every latency check and still fail
the point of the project.

**How to measure it** (keep this method fixed so the numbers can be repeated in six months):

- **Walk each app's process tree from its own root process.** Tauri's web view runs in separate
  processes (`msedgewebview2.exe` on Windows, WebKit helpers on macOS), and VS Code is many processes
  too, so the main process alone undercounts both. Never collect processes by name: on Windows,
  `msedgewebview2.exe` also belongs to Teams, Outlook and other apps. On macOS, WebKit's web
  content, GPU and networking processes are XPC services whose parent is launchd, not the app; the
  walk follows macOS's "responsible process" link to them, and the app must be launched as
  responsible for itself (a script's or terminal's child isn't, so its WebKit processes would be
  attributed elsewhere). *(Found in phase 0, 2026-10-06: without this, Tauri measured 41 MB instead
  of 345 MB.)*
- **Close other WebView2 and Electron apps first**, so nothing else shares the count.
- **Let each app settle before sampling:** two minutes after the workspace finishes loading for the
  idle row, and two minutes into the load for the load row. Both runtimes clean up memory at
  different times, so cold-start readings mislead.
- **Same tool and metric for both apps:** unique memory per process (USS, via the `psutil` script
  in `bench/`), summed over the process tree. On Windows that matches private working set. On
  macOS USS can't be read: psutil needs root for it, and not even root may read Apple's WebKit
  processes. There the metric is each process's physical footprint (what Activity Monitor shows),
  cross-checked against `footprint`. *(Found in phase 0, 2026-10-06.)* Record the tool and version
  with the results.
- **Pin the terminal settings that change memory, in both apps, and record them:** scrollback
  (VS Code's `terminal.integrated.scrollback`) and the terminal renderer (VS Code's
  `terminal.integrated.gpuAcceleration`, and the matching xterm.js renderer in Gako: WebGL or DOM).
  Left on "auto," the renderer can differ between machines and runs.
- **Pin the terminal size** (for example 200 columns × 50 rows) in both apps, for every row of the
  table. Terminal width multiplies scrollback memory, and it's the one input that changes without
  touching a setting: a maximized window in one run and a smaller one in the next aren't
  comparable. VS Code's terminal size can't be set, and on a small screen it can't reach 200 × 50
  (about 112 × 54 on a 1,280-point-wide MacBook screen), so pin Gako to the size VS Code's terminals
  actually get on that machine, and record it. *(Phase 0, 2026-10-06.)*

**Decision rule:**

- **A shell that fails a memory row is out**, whatever else it passes.
- Tauri passes everything on macOS and the Windows work machine → **Tauri**.
- Tauri fails a non-memory measure on macOS or Windows that Electron passes → **Electron**, provided
  Electron passes memory. No re-tuning first, and no "it'll get better later."
- **Tauri fails a non-memory measure and Electron fails memory → start from Tauri**, because its
  failure is more likely to be fixable. Electron's memory cost is structural: no amount of work
  lowers Chromium's baseline. Tauri's latency problems are usually in the frontend or the IPC. But
  the fix is bounded:
  1. **Profile first.** Attribute the cost to Monaco or xterm.js, to your own IPC, or to the web view
     engine. That's usually clear within a day.
  2. **Time-box the fix to a few days.** If it isn't moving, treat the cost as built into the engine.
  3. **If it's built in, make an explicit, written choice:** accept Electron's memory and record why,
     or accept the latency as a known limitation. Neither is free, and "stay on Tauri" must not win
     by default.
- Both fail the same measure on every platform → it's a frontend problem, not a shell problem. Fix
  it in the frontend, then re-run.
- **Both fail only on the Windows work machine**, while passing on macOS and Linux → it's the
  machine, not the frontend (likely a constrained or virtual desktop). Don't spend weeks optimizing
  against a hardware ceiling. Replace that machine's thresholds with "no worse than VS Code on the
  same machine," and pick whichever shell does better there.
- Tauri fails only on Linux → **still Tauri**. Linux is the least-used platform; note the issue and
  revisit if Linux use grows.

**Results** *(2026-10-06; the Windows work machine wasn't run)*:
macOS ([Tauri](../bench/results/macos-tauri-2026-10-06.md),
[Electron](../bench/results/macos-electron-2026-10-06.md),
[VS Code](../bench/results/macos-vscode-2026-10-06.md)) and Linux, Ubuntu 24.04 on a ThinkPad with
Intel graphics ([Tauri](../bench/results/linux-tauri-2026-10-06.md),
[Electron](../bench/results/linux-electron-2026-10-06.md),
[VS Code](../bench/results/linux-vscode-2026-10-06.md)).

- **Memory is far below VS Code's in both shells, on both platforms**, idle and under load (12–29%
  of VS Code's). No shell fails a memory row.
- **Combining-and-emoji dump:** memory isn't flat in either shell on either platform, and not in
  VS Code. A measure both shells fail everywhere is a frontend problem under the rule above (see
  the very-long-lines trap). On Linux, Tauri's emoji dump is also slower than VS Code's (89 s vs
  81 s).
- **Tauri on Linux (WebKitGTK) fails both scroll rows:** about 28 fps on the diff and 49 fps on
  the 5 MB file, against 50. Electron holds 60 fps there. Tauri failing only on Linux is "still
  Tauri" under the rule.
- **Tab cycling** showed memory trends of 4–5.5 MB/min in 4-minute runs on Linux (both shells) and
  for Electron on macOS. On macOS a 15-minute Electron run showed it was garbage-collection swing,
  not creep (0.83 MB/min); the Linux runs haven't been repeated at that length.
- Electron's normal-dump memory on Linux moved 14.7 MB in the dump's second half, just over the
  10 MB "flat" line, while ending where it plateaued (242 → 243 MB): borderline, not a trend.
- **Outcome:** Windows wasn't run. With macOS and Linux weighted equally, the decision is
  **Electron**, recorded with its reasons and costs under *Host decision and the hedge*.

**Phase 0 is cheap insurance:** about a week to find out whether Tauri renders the diff view smoothly
and whether the terminal holds up under several live agents on Windows, before anything is built on
those assumptions. The terminal is where you spend most of your day, so it's the bigger risk.
Language-server process handling isn't tested here; it belongs to phase 5, which may not need it.

**The first product phase proves or kills the idea.** That's phase 1 in the default order, or the
terminal and agent cockpit if the trial week swaps phases 1 and 2. Test it on the real Windows work
setup. If it doesn't beat what you have today (VS Code's Source Control view, or your current
terminal), that shows up before anything else is built.

**After phase 2 the app is usable every day alongside VS Code.**

---

## Known traps

- In worktrees and submodules, `.git` is a **file**, not a folder. Detect both.
- Nested repos need an explicit rule: stop descending, or report both. The base repo's status must
  not list the nested repos as untracked folders.
- macOS file events only say *which folder* changed, and they arrive batched. Refresh by rescanning
  the changed part of the tree, not by relying on per-file events.
- Watch each repo's `.git/HEAD` and `.git/index` as well as its working tree.
- Scan repos in parallel **with a limit on how many run at once**, and debounce per repo. Unlimited
  parallel scans thrash once there are 20 or more repos.
- On large repos, `git status` itself becomes the bottleneck. Respect `core.fsmonitor` and
  `git maintenance`.
- Be careful with `-uall` when there are large untracked folders: it lists every untracked file
  individually. Listing untracked files is the point, but cap it and degrade gracefully.
- **Terminal flow control must be decided, not left to chance.** A fast PTY dump through IPC into
  xterm.js will either block, buffer without limit (memory blows up), or drop bytes. Policy:
  **backpressure**. The frontend acknowledges bytes as xterm.js finishes rendering them (its write
  callback), and the Rust PTY reader pauses when unacknowledged bytes pass a high-water mark and
  resumes below a low-water mark. VS Code's terminal does the same. The producing program then simply
  waits, as it would in any real terminal. Separately, **cap scrollback per tab**. The oldest lines
  fall off, which is normal terminal behavior, not lost output, so no "lines dropped" marker. The
  testable claim is that memory doesn't grow with the amount of output once scrollback is full;
  phase 0's 250 MB rows check it.
- **Scrollback default: 1,000 rows, the same as VS Code**, configurable. Scrollback is the main
  memory cost per terminal tab:

  ```text
  per-tab memory ≈ scrollback rows × columns × bytes per cell
  ```

  xterm.js allocates each row at the full terminal width, at roughly 12 bytes per cell in current
  versions (verify in phase 0). At 10,000 rows and 200 columns that's about 24 MB per tab before any
  agent runs, and the load row has five tabs open. At 1,000 rows it's about 2.4 MB. So the lower
  default is what keeps the load row passable on its own terms, not just a match with VS Code. A
  larger default would also be a memory decision made for the user that quietly undercuts the app's
  own case against bloat. **This formula is a floor for the scrollback buffer only, not the
  terminal's total cost:** it leaves out per-row object overhead, combining-character storage and the
  renderer (WebGL's glyph textures, or the DOM renderer's nodes). The measured load row is the
  authority; don't budget against the formula. Raise the default only with evidence: the
  trial week runs in VS Code at 1,000 lines, so log each time you hit the top of the scrollback in an
  agent session. Any new default must still pass the out-of-the-box memory comparison.
- **Very long lines are bounded by design, but only if the pipeline keeps them that way.** xterm.js
  wraps long lines into screen-width rows, and its scrollback cap counts those rows, so a 100 MB line
  with no newline takes many rows, not one slot. Memory is therefore capped at about scrollback ×
  width. The risk is in our own code: the Rust PTY reader must pass bytes through in fixed-size
  chunks and never buffer until a newline. Phase 0's long-line dump checks this.
  - **Chunking costs nothing; don't "optimize" it away.** xterm.js's `write()` accepts partial data
    and internally holds incomplete escape sequences and split multi-byte UTF-8 characters until the
    rest arrives. Splitting at arbitrary byte boundaries is the supported path, not a risk.
  - **If the long-line dump does show memory growing, treat it as a design input, not a shell
    failure.** It would mean the bound has to be a byte budget per tab (or a maximum line length),
    not a row count. One known way it could happen: long runs of combining characters, which xterm.js
    stores as growing strings attached to a single cell. The same storage almost certainly covers
    emoji sequences joined with zero-width joiners, flags and skin-tone modifiers. Phase 0's third
    dump covers both.
  - **Confirmed on macOS (phase 0, 2026-10-06):** the combining-and-emoji dump grows memory in
    every app tested: Tauri from about 760 MB to 1.25 GB during the dump (still about 490 MB above
    its earlier level afterwards), Electron to about 1.45 GB, and VS Code's own terminal to about
    7 GB. The line-oriented and long-line dumps stay flat in both Gako shells. So the row cap holds
    for ordinary output, and the combining-character case needs a byte bound
    ([results](../bench/results/)).
  - **Resolved in phase 2 (2026-10-06):** the bound that works isn't on bytes or length but on
    variety. Each distinct stack of marks becomes a WebGL glyph in the GPU process, so cutting runs
    to 8 marks made it worse (8 GB). Dropping any run of more than 4 marks whole keeps the dump flat
    at about 400 MB, and 8× faster than VS Code. Measurements and reasoning in
    [PHASE2.md](PHASE2.md); results in
    [macos-electron-phase2-2026-10-06.md](../bench/results/macos-electron-phase2-2026-10-06.md).
- **WebGL terminals have a ceiling on tab count.** Browsers limit live WebGL contexts (reportedly
  about 16 in Chromium, and WebKit has its own limit; verify the current numbers), and xterm.js's
  WebGL renderer uses one per terminal. Past the limit, the oldest contexts are dropped and those
  terminals go blank. Phase 0's five tabs are well under it, but "how many agent tabs can I have
  open?" will be asked. Plan for it: use WebGL only for visible terminals and release it when a tab
  is hidden, or fall back to the DOM renderer past a set number of tabs. Releasing and recreating
  WebGL contexts is the less-tested path, where WebGL terminal bugs have historically lived, so
  phase 0 cycles tab visibility under load rather than leaving five tabs open.

---

## Ideas for later

Add these only if they prove useful; they are on-thesis, but they are not v1.

- One git worktree per agent tab.
- "What changed since this agent's turn started."
- An alert when an agent is waiting for input, building on the phase 2 status strip.
- A combined history timeline across repos.
- An ACP mode with a structured chat interface (see *Agents* above).
- Optionally write each terminal tab's full output to a log file on disk, if the scrollback cap
  turns out to lose things you needed.

---

## Relief in the meantime

- Set `"update.mode": "none"` to keep VS Code on a good version while building.
- A third-party extension, `mattgle.metarepo-sc`, reportedly combines repos with changes into one
  view today; with VS Code's built-in Git extension disabled, it's the setup for the trial week.
  **Read its source before installing it.** It is an unvetted third-party extension that would run
  with full access to your work repositories, so check your employer's policy on extensions too. It
  may also be useful as a working reference for phase 1.

---

## Honest caveat

If the bloat is merely annoying rather than blocking, staying on VS Code and turning off features is
the cheapest option. The case for building rests on the multi-repo workflow being the thing you
can't get elsewhere, and on owning it outright. Then Microsoft's roadmap stops mattering to you.

**This is a companion to an editor, not a replacement for one.** Some editor stays installed for hand
edits. It doesn't have to be VS Code: any editor that opens `file:line` from the command line works
(Zed, Sublime Text, Neovim, and so on). If you hand-edit often and that editor is VS Code, you'll
still have it open much of the time: you'll have a better Git panel, but you won't have escaped the
bloat. Phase 1 and 2 use will show which case you're in.

---

## Open questions before coding

1. **Is the work Windows machine a physical desktop, or a remote or virtual one (VDI/RDP)?** It no
   longer gates the host choice (Electron was chosen without it), but it decides how phase 1 will
   feel at work. Running `dxdiag` is a one-minute check of its graphics and hardware acceleration.
2. **Do phases 1 and 2 replace enough to drop VS Code day to day**, or will the app run alongside it
   until phase 3 or 4?
3. **How should nested repos be handled** in the work layout? Are they all listed in the base repo's
   `.gitignore`?

---

## Check before relying on

Verify these before quoting or acting on them:

- How far any given VS Code fork sits behind upstream today (the Cursor figure is a single forum
  thread).
- Whether extensions really can't change the built-in Source Control panel (the extension author's
  assertion; the quote itself is accurate).
- Which harnesses support ACP natively, and which need adapters. A reviewer reports that Claude Code,
  Codex and Pi all go through separate adapter projects; not yet checked here.
- The ACP methods the client must implement (`fs/*`, `terminal/*`) and the current state of the
  official Rust SDK.
- Specific crate and SDK versions, which move quickly.
- The `mattgle.metarepo-sc` extension's source and behavior, before installing it anywhere near work
  repositories.

**Checked on 2026-10-05** (re-check after about six months; each claim in the body carries its own
date and method):

- VS Code's release cadence: GitHub releases API (numbers in *Why not fork*).
- `microsoft/vscode#33334`: GitHub issue and API. Closed in September 2017. The API's `state_reason`
  is `completed`; "declined" comes from the discussion thread.
- Zed's license text: Zed README.
- The meta-repo-source-control quote, as a quote: the extension's README.
- The Marketplace terms and the Zed per-project git quote: verified by a reviewer against the VS Code
  FAQ and Zed docs.

**How this plan changes from here:** `PLAN.md` is the single source. Further edits should come from
results (the trial week, the bloat log, phase 1 on the Windows work machine), not from more
drafting. Phase 0's brief and what came of it are in [PHASE0.md](PHASE0.md).
