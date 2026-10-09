# Changelog

All notable changes to Gako are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Copy and paste in terminals on Windows and Linux: Ctrl+Shift+C and Ctrl+Shift+V, Ctrl+Insert and
  Shift+Insert, and on Windows Ctrl+C while text is selected. A right click on a terminal opens a
  menu with Copy, Paste and Select all, on every platform.
- Copy on select in terminals, off by default: `terminalCopyOnSelect`.
- Option-drag on macOS, as Shift-drag elsewhere, selects text in a program that takes the mouse.
- Ctrl+Shift+W and Ctrl+F4 close the tab in front on Windows and Linux, a terminal included, where
  Ctrl+W stays with the shell.

### Changed

- The **+** menu picks the base folder by default, rather than the repository of the file you're
  looking at, and shows the repositories indented beneath it.
- Terminals in a repository are named under the base folder (`projectX/A`) in the agent bar and
  when closing or quitting asks first, so one named like the base folder can't be mistaken for it.
- Terminals keep 10,000 rows of scrollback by default, up from 1,000 (`terminalScrollback`).

## [0.10.0] — 2026-10-08

Settings on a screen of their own and applied as they change, font settings, views that switch
without flashing, and tabs and agents that can be put in any order.

### Added

- Settings for the file viewer's and the diff view's font, apart from the terminals':
  `fileFontFamily`, `fileFontSize` and `fileFontLigatures`.
- Font ligatures in terminals, off by default: `terminalFontLigatures`.
- A settings screen (⌘, or Ctrl+,, or the gear in the status bar), saving each change to the
  settings file as it's made. The file keeps only what differs from the defaults, and keys Gako
  doesn't know.
- Changes to the settings file apply as soon as it's saved, without opening the folder again. A
  file that can't be read is reported in the status bar, and the last good settings stay in use.
- Tabs and agents can be dragged into a new order, which is kept with the session.
- A middle click closes an agent, as it already closed a tab.

### Changed

- Pressing and dragging on a tab or an agent no longer selects their text.
- Switching between files, diffs, histories, settings and terminals no longer shows in-between
  states: a view appears once it's ready (diff computed and folded, scroll position and change
  markers back), with what was on screen kept until then. Restoring a session no longer flashes
  through its terminals and tabs.
- An open file or diff no longer flashes while an agent works: it's left alone when other files
  change, and updated in place, keeping its scroll position and folds, when its own file does.

## [0.9.0] — 2026-10-08

The first public release. Gako is used every day on macOS; Windows and Linux have had less use.

### Repositories

- Finds every Git repository under a base folder, nested ones and worktrees included, to a
  configurable depth, plus extra folders you name.
- Lists the repositories with changes, each with its branch, its sync state with the upstream, and
  its conflicts, staged changes, changes and untracked files. Clean repositories fold into one
  group.
- Keeps current without polling, from file events, including commits and branch switches made in
  a terminal.
- Fetch, pull (fast-forward only) and push per repository, Fetch all and Pull all, switching
  branch (local or remote), and reverting a file's changes after a confirmation.
- Read-only diffs side by side, inline or automatic, and each repository's history with commit
  details. Images and PDFs are compared as they look, before and after.

### Terminals and agents

- Terminals for your shell or any agent: Claude Code, Codex, OpenCode and Pi by default, or any
  command you configure, in the base folder or any repository.
- An agent bar showing each agent's state (working, waiting for you, finished, exited) from the
  titles and notifications agents send, including Claude Code's approval prompts on macOS and
  Linux. A finished turn you haven't seen is marked until you look.
- A single-pane layout, or a dual-pane one with the agent beside your files.
- Terminals reopen with their folder, as new sessions, and quitting with agents running asks
  first.
- Output is never dropped or reordered, and memory stays flat however much a program writes.

### Files, search and navigation

- A file tree with Git states and ignored files dimmed, and a read-only viewer that marks
  uncommitted changes, and shows images (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) and PDFs as they
  are.
- Search in files, scoped to all repositories, the base repository or a chosen set; go to file;
  go to definition, go to symbol and find references by name, from a symbol index for eleven
  languages.
- "Open in editor" at the right line, in VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf,
  Zed, Sublime Text or a command you configure.

### App

- An About window with the version and build, where Gako keeps its files, the licence and the
  third-party notices.
- Settings in one JSON file of your own; see `docs/settings.md`.
- Free software under the GNU Affero General Public License, version 3 or later.

### Known limitations

- No prebuilt or signed packages yet: build Gako from source (see the README).
- On Windows, Claude Code's approval prompts aren't told apart from a finished turn, and closing
  a terminal doesn't end the programs its program started.
- Agents' conversations aren't resumed when Gako reopens their terminals.

[Unreleased]: https://github.com/gako-app/gako/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/gako-app/gako/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gako-app/gako/releases/tag/v0.9.0
