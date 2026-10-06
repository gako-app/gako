# Phase 1 brief

The working brief for phase 1: the multi-repo Git panel. Read [PLAN.md](PLAN.md) first, especially
*The key feature: multi-repo git view* and the Git items under *Known traps*. This file says what to
build, how it sits on phase 0's foundations, and how we'll know it works.

**Status: agreed 2026-10-06.** The decisions taken are listed at the end.

## What phase 1 delivers

The Source Control sidebar's replacement, for a base folder holding several independent repos:

- **Repos found automatically:** nested repos under a base folder up to a configurable depth, plus
  extra folders to scan.
- **Only repos with changes shown.** Each shows its branch, ahead/behind, and its staged, unstaged,
  untracked and conflicted files. Clean repos collapse to one line each in a "clean" group at the
  bottom, so they stay findable for their history.
- **One review queue:** every changed file across all repos in one list, grouped by repo, for
  reviewing an agent's edits that span components.
- **Diffs:** clicking a file opens Monaco's read-only diff (working tree against the index or HEAD,
  or staged against HEAD), with the full file a click away.
- **History:** each repo's commit log, and a commit's details and diff.
- **Stage and commit:** stage and unstage whole files, and a commit box per changed repo (with
  amend). Fetch, pull, push and branches stay with the terminal and the agents. *Reversed after the
  user's trial; see decision 1.*

PLAN.md's test for this phase: on the real work layout, on the Windows work machine, it must beat
VS Code's Source Control view. If it doesn't, that shows up here, before anything else is built.

## Architecture

Phase 0's pieces stay: the Electron shell, `gako-core` in Rust, the one WebSocket and the frontend's
`Transport` interface. Phase 1 adds a Git side to the core and a real UI to the frontend.

```text
┌──────────────── Electron shell (window + core lifetime) ────────────────┐
│ frontend: repo tree · review queue · Monaco diff · history  (no shell APIs) │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ WebSocket: requests + pushed events
                     ┌──────────┴──────────┐
                     │      gako-core       │
                     │ discovery · watcher  │
                     │ git CLI runner · PTYs│
                     └─────────────────────┘
```

**In the core:**

- **Discovery:** walks the base folder with the `ignore` crate up to the configured depth. A
  directory is a repo if it has `.git` as a folder *or a file* (worktrees and submodules). Stops
  descending into a repo's own working tree except to find nested repos, and reports nested repos
  separately, so the base repo's untracked list never shows them as folders.
- **Status:** `git status --porcelain=v2 -z --branch` per repo, parsed in Rust (including unborn
  branches, detached HEAD, upstream gone, renames, conflicts, and rebase, merge, cherry-pick and
  bisect states from `.git`). Untracked files listed individually but capped per repo, with the
  overflow reported as a count.
- **Watching:** `notify` with debouncing. Events map to the repo they fall in, and the repo is
  rescanned; on macOS events only name folders, so they're treated as "something under here
  changed". Each repo's `.git/HEAD`, `.git/index` and refs are watched too. Rescans run in
  parallel with a concurrency limit (start with 4) and a debounce per repo.
- **Running git:** the `git` CLI through `tokio::process`, with a timeout, no terminal prompts
  (`GIT_TERMINAL_PROMPT=0`), respecting the repo's own config (`core.fsmonitor`, hooks, signing).
- **Protocol:** requests for repos, status, file contents at a revision (`git show <rev>:<path>`
  and the working tree), log, commit details, stage, unstage and commit (since replaced by fetch,
  pull and push: see decision 1); pushed events when a repo's status changes. Same framing as
  phase 0: JSON text frames, a `t` field, request ids.
- **Settings:** a JSON file in the platform's config folder (`~/Library/Application Support/Gako`,
  `%APPDATA%\Gako`, `~/.config/gako`), with a per-workspace override in the base folder
  (`.gako/settings.json`). Defaults suit a work layout of 10–30 repos, 1–2 levels deep: scan depth 2,
  4 git processes at once, a 150 ms debounce per repo, 2,000 untracked files listed per repo. All of
  them are settings, for larger layouts. No settings UI yet.
- **Choosing the base folder:** from the command line, the settings file, or a path typed into the
  app. A native folder picker needs a shell API, so it waits for a small shell bridge that keeps
  the frontend free of shell calls.

**In the frontend:**

- A real UI in place of the phase 0 harness: a sidebar with two views (repos, review queue) and a
  main area for diffs and history. Plain TypeScript, no UI framework, as in phase 0.
- The phase 0 harness moves to its own page (`bench.html`), so `bench/` keeps working for future
  measurements.
- Terminal tabs stay out of the UI until phase 2; their code stays as it is.

## How we'll know it works

**Correctness**, as automated tests in the core against generated repos:

- Status parsing for every case in VS Code's Git extension's test suite that applies: renames,
  copies, conflicts of each kind, submodules, unborn branch, detached HEAD, upstream gone,
  merge and rebase in progress.
- Discovery: nested repos at several depths, `.git` files (a worktree and a submodule), a base repo
  that ignores its nested repos and one that doesn't.

**Responsiveness**, measured with `bench/` on the sample workspace, on a generated work-sized
layout (25 repos, 1–2 levels deep, a few with large untracked folders), and on a stress layout
(100 repos, up to 4 levels deep) for setups larger than the work one:

| Measure | Pass |
|---|---|
| First full scan, 25 repos | Under 2 s |
| First full scan, 100 repos (stress layout, depth setting raised) | Under 8 s, UI responsive meanwhile |
| A file saved in a repo → its status updated in the UI | Under 500 ms |
| A commit or branch switch from a terminal → shown | Under 1 s |
| CPU when nothing changes | Idle (no polling) |
| Memory, idle with the panel open | Still at most half of VS Code's (phase 0's rule) |

**Real use:** a day of reviewing real agent work in the real work layout, on macOS and on the
Windows work machine, compared with VS Code's Source Control view (or the multi-repo extension, if
you try it). This is the "proves or kills the idea" test.

## Out of scope for phase 1

Terminal tabs (phase 2), the file explorer and "open in editor" from the tree (phase 3), project
search (phase 4), navigation (phase 5), the combined history timeline (later), installers and
auto-update. Editing files stays out, always.

## Decisions (2026-10-06)

1. **Git actions:** stage and unstage whole files, and commit with amend. No hunk staging, fetch,
   pull, push or branch actions in phase 1.
   *Changed after the user's first trial (2026-10-06):* staging and committing are the agents' job,
   so the commit boxes and stage buttons are gone. Each repo, clean ones included, instead offers
   its history, a fetch (refresh), and pull (fast-forward only) and push buttons with counts when
   its branch is behind or ahead of its upstream. The review queue went too: the repos view already
   lists every change in every repo. Each changed file also opens whole, not only as a diff.
2. **Layout defaults:** sized for the work layout (10–30 repos, 1–2 levels deep), every limit
   configurable, and a 100-repo stress layout in the tests so larger setups for other people are
   covered.
3. **Clean repos:** collapsed, one line each, in a "clean" group at the bottom.
4. **Open in editor:** comes with the phase 3 file explorer, not now.
