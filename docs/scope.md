# Scope

What Gako is for, what it deliberately leaves out, and the principles that keep it that way.

## What Gako is

Gako is a desktop app for reviewing and supervising coding agents across many Git repositories at
once. It's meant to sit beside an editor, not to replace one: agents do the editing in their own
terminal UIs, you review and steer them in Gako, and you open your editor for the edits you make by
hand.

It's built for one layout in particular: **a base folder holding several independent
repositories**, cloned side by side rather than as submodules. Microservice codebases, robotics
workspaces and teams that avoid monorepos all work this way. Editors handle it badly. VS Code, for
example, shows a full Source Control section for every repository, clean ones included, each with
its own commit box, and its maintainers have declined to hide repositories without changes
([microsoft/vscode#33334](https://github.com/microsoft/vscode/issues/33334)).

## What Gako does

- **Finds every repository** under a base folder and shows the ones with changes, each with its
  branch, its sync state with the upstream, and its changed files. Clean repositories collapse into
  one group. See [git.md](git.md).
- **Shows changes** as read-only diffs, with each repository's history and commit details.
- **Runs agents in terminals:** Claude Code, Codex, OpenCode, Pi or any other program, in the base
  folder or one of its repositories, and tells you which are working, which have finished and which
  are waiting for you. See [terminals.md](terminals.md).
- **Browses and searches files:** a file tree, a read-only viewer that marks uncommitted changes,
  project search scoped to all repositories, the base repository or a chosen few, go to file, and
  go to definition by name. See [navigation.md](navigation.md).
- **Hands editing to your editor:** "Open in editor" opens the file at the right line in VS Code,
  Zed, Cursor or any editor you configure.

## What Gako never does

- **Edit code.** No typing into files, no undo, multi-cursor, refactoring or code actions. The
  viewer and the diffs use Monaco, VS Code's editor component, but always read-only. This is a
  product decision, not a technical limit: it's what keeps Gako small, and editing is what your
  editor and your agents are for.
- **Stage or commit.** Agents and the terminal do that. Gako's actions on a repository are the ones
  that keep you in sync and undo mistakes: fetch, pull, push, switch branch, and revert a file's
  changes after asking you.
- **Debug, run notebooks, or host extensions or a marketplace.**
- **Replace the agents' own interfaces.** Agents run in real terminals with their own TUIs, which
  are good, and Gako leaves them as they are.
- **Take instructions from the folders it opens.** Settings come only from your own settings file.

## Principles

- **Reuse, don't rebuild.** Monaco for the viewer and diffs, xterm.js for terminals, ripgrep's
  crates for search, the `git` CLI for Git. Time goes into what nobody else has: the multi-repository
  view and agent supervision.
- **Stay light.** Gako holds itself to budgets measured against VS Code on the same machine: at
  most half its memory when idle, and no more under load. In practice it uses a fraction of that.
  See [performance.md](performance.md).
- **Cross-platform from the start.** macOS, Windows and Linux, with no platform-specific path,
  shell or tool without a fallback for the other two.
- **A thin shell.** Electron only manages windows and the core; the frontend never calls it
  directly. See [architecture.md](architecture.md).

The reasons behind each of these, and what they cost, are in [decisions.md](decisions.md).
