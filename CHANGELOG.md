# Changelog

All notable changes to Gako are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Agents resume their conversations. When Gako reopens an agent's terminal (a base folder's
  session, the terminals in other folders at launch, or Restart on an agent that exited), Claude
  Code, Codex, OpenCode and Pi come back on the conversation they had, in the same folder. One you
  never typed in comes back new, and one that can't resume is started again on a new conversation.
  Gako learns Codex's conversation through a `notify` program of its own, which runs yours after
  it, and follows a switch inside the agent (Claude Code's `/resume` or `/clear`) through a
  SessionStart hook. The `agentResume` setting turns this off.
- Other agents can say how they resume: `session` and `resume` in an entry of the `agents` setting,
  also on the settings screen, on a line beneath each agent.

### Changed

- The settings screen's **Add agent** button is set apart from the last agent.

### Fixed

- A terminal's automatic replies to a program's questions (its modes, its keyboard and colour
  scheme, its size) no longer count as typing, which could end an agent's "waiting for you" early.

## [0.24.0] — 2026-10-29

Agents and shells can run in folders outside the base folder, listed apart in the agent bar, and
Gako says when a newer release is out.

### Added

- Gako says in the status bar when a newer release is out, and clicking it opens the release page.
  It asks GitHub ten seconds after starting and every six hours; the `updates` setting turns this
  off. Nothing is downloaded or installed.
- Agents and shells can run in any folder: **Other folder…** in the + menu picks one, and the last
  five picked are offered again. They're reopened at launch whatever base folder is open.
- Terminals outside the base folder are listed apart, under **Other folders** at the bottom of the
  agent bar, each naming its folder. Terminals left running when another base folder is opened
  move there, and move back up when their base folder is opened again.

### Fixed

- Opening another base folder no longer saves the earlier folder's terminals into the new one's
  session, which reopened them with it the next time.
- Nor its open tabs: a folder's session keeps only the tabs of files and repositories in it (the
  settings tab goes with any).

## [0.23.0] — 2026-10-22

Markdown files show rendered, with their changes marked, and terminals speak the kitty keyboard
protocol.

### Added

- Markdown files show rendered in the viewer, with GitHub's tables, task lists and strikethrough,
  and code blocks coloured as the viewer colours code. **Show source** and **Show preview** switch
  between the two at the same place. Blocks changed since the last commit are tinted and marked in
  a gutter; clicking a mark shows the change in the source. Links to headings and to other files
  open in Gako and web links in the browser; images in the repository show, images from the web
  aren't loaded, and HTML in the file is cleaned of scripts, forms and styles. Find (⌘F, Ctrl+F)
  switches to the source.
- Search in files (⌘⇧F, Ctrl+Shift+F) starts with the text selected in a file, a diff, a
  terminal or anywhere else, if it's on one line.

### Changed

- Terminals support the kitty keyboard protocol, so agents that ask for it can tell Shift+Enter
  and Ctrl+Enter from Enter. On Windows they also support win32-input-mode, which replaces the
  Ctrl+J workaround for Codex. Both come from xterm.js's 6.1 betas, pinned to exact versions.
  ⌘ shortcuts on macOS stay with the app in every terminal, so ⌘C and ⌘V keep working in agents
  that use the protocol.
- "Clean repositories" starts open, and stays open or collapsed as you left it, across restarts.

### Fixed

- A new or untracked file's change markers showed every line as changed (blue) rather than added
  (green).

## [0.22.1] — 2026-10-15

A git command that hangs or a status scan that gets lost no longer leaves a repository showing an
error for good, and a timeout says what happened.

### Changed

- A git command that takes too long now says so in plain words ("Git didn't answer within 30
  seconds…", or that the remote didn't answer) instead of showing git's command line.
- A repository whose status scan failed is scanned again on its own, after 10, 20, 40, 80 and then
  every 160 seconds, instead of keeping the error until a file changes.

### Fixed

- A repository could keep showing a git timeout after git had recovered. Gako now stops waiting
  for git's output once git has exited, limits how long a status scan waits for git to five
  minutes, and starts a new scan for a repository whose scan was lost. It logs when any of these
  happens.

## [0.22.0] — 2026-10-14

Terminals survive a lost connection, opening a big folder says what it is waiting for, and the core
stays responsive while files change.

### Added

- While a folder opens, the sidebar says what Gako is waiting for: "Finding repositories…", then
  "Scanning repositories… 12 of 27" with a bar, and the status bar shows "Indexing symbols…" until
  the symbol index is ready. The line fades in after a moment, so a quick open doesn't flash it.
- A progress cursor while a repository's branch list loads, which takes a moment in a repository
  with many branches.

### Changed

- A terminal now belongs to the core: if the connection to the window is lost (macOS closes it
  when the screen sleeps), the terminals keep running, and the window connects again by itself,
  reopens the workspace and reattaches them with the output they missed. A message says while the
  connection is lost.
- `maxGitProcesses` limits the background status scans only; what you ask for (a file at a
  commit, the log, a branch switch) has a pool of its own, 2 to 4 more, so it is never queued
  behind a scan.
- Changes inside the folders `scanIgnore` names (`node_modules` by default) no longer trigger a
  status scan or a symbol update, under the extra folders as well.
- While files keep changing, a repository's scans are spaced: at least half a second apart and
  three times the duration of the `git status` itself, so a slow repository doesn't keep Git busy.

### Fixed

- The window no longer freezes every request at once when the disk, a lock or Git is slow: the
  symbol index swaps in its updates without blocking searches, repositories are found again off the
  async workers, and the core runs more worker threads.
- Ctrl+J reaches Codex on Windows as a newline (sent as Alt+Enter, which ConPTY lets through).
- A request whose reply couldn't be prepared now gets an error instead of waiting forever.

## [0.21.0] — 2026-10-10

Packages to download for macOS, Windows and Linux, starting with this release, and a disk image
for macOS.

### Added

- Packages to download from each GitHub release: a disk image for macOS on Apple silicon, a zip
  for Windows and a tarball for Linux. They're built by a release workflow when a version is
  tagged.
- `npm run dmg` puts a packaged Gako.app in a disk image whose window shows Gako, a link to
  Applications, and what to do when macOS says it can't verify Gako.

### Changed

- On macOS, packaging signs the whole app ad hoc, so a downloaded copy opens once you allow it in
  System Settings, instead of being reported as damaged.

## [0.20.0] — 2026-10-10

A new look closer to VS Code's, with an activity bar, file icons and VS Code-style tabs; a simpler
search form; and repositories out of step with their remote kept in sight.

### Added

- An activity bar at the window's left edge, as in VS Code, with Repositories, Files and Search.
  Repositories carries a count of changed files; clicking the view that's open hides the sidebar,
  and any of them shows it again.
- File icons by kind (code, data, text, images, shell scripts and more) in the Repositories view,
  the Files tree, search results, Go to file and the tabs. Repositories have a folder icon of their
  own in the Files tree.
- The line over the repositories counts those behind, ahead and diverged ("2 behind · 1 ahead ·
  1 diverged"), and shows only while there's something to say.

### Changed

- A new look, closer to VS Code's current one: darker bars beside the documents, quieter borders,
  rounded rows inset from the edges, rounded menus, dialogs and tooltips, and a status bar in the
  bars' colour rather than blue, a little taller. Monaco and the terminals share the documents'
  background.
- Tabs as in VS Code: no borders between them, and the one in front runs on into the document
  below it.
- Chevrons and close buttons are icons rather than text characters.
- **Fetch all** is an icon in the Repositories header.
- A repository with commits to pull or push stays in the list even without changed files, instead
  of folding into "Clean repositories" with its buttons out of sight.
- A diverged repository (commits both to pull and to push) shows the two counts and no buttons, and
  **Pull all** leaves it out, since a fast-forward can't bring it up to date.
- In the Files tree, a folder holding changes is marked up to the base folder, so a change shows on
  a collapsed folder above a repository, and the mark is a larger dot. The "repo" badge is gone.
- The search form: match case, whole word and regular expression sit inside the field, with
  tooltips; the include and exclude globs and "Include files Git ignores" fold under **Filters**,
  with a count while any are set; and **In** picks all repositories or any of them from a menu.
- The agent bar, with no agents running, says what goes there and has a **Start an agent** button.

### Removed

- The "Base repo only" search scope: the base folder's repository can be picked in the **In** menu
  like any other.

### Fixed

- **Pull all** no longer fails on a diverged repository.

## [0.11.0] — 2026-10-09

Copy and paste in terminals on Windows and Linux, keys to close a terminal's tab there, find in
the file or diff in front, and terminals that start in the base folder and keep more scrollback.

### Added

- Copy and paste in terminals on Windows and Linux: Ctrl+Shift+C and Ctrl+Shift+V, Ctrl+Insert and
  Shift+Insert, and on Windows Ctrl+C while text is selected. A right click on a terminal opens a
  menu with Copy, Paste and Select all, on every platform.
- Copy on select in terminals, off by default: `terminalCopyOnSelect`.
- Option-drag on macOS, as Shift-drag elsewhere, selects text in a program that takes the mouse.
- Ctrl+Shift+W and Ctrl+F4 close the tab in front on Windows and Linux, a terminal included, where
  Ctrl+W stays with the shell.
- Find in the file or diff in front (⌘F, Ctrl+F), with Monaco's find widget.

### Changed

- The **+** menu picks the base folder by default, rather than the repository of the file you're
  looking at, and shows the repositories indented beneath it.
- Terminals in a repository are named under the base folder (`projectX/A`) in the agent bar and
  when closing or quitting asks first, so one named like the base folder can't be mistaken for it.
- Terminals keep 10,000 rows of scrollback by default, up from 1,000 (`terminalScrollback`).

### Fixed

- Return now quits when quitting asks first about running agents, as Esc cancels. On macOS it
  did nothing, so quitting took a click.

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

[Unreleased]: https://github.com/gako-app/gako/compare/v0.24.0...HEAD
[0.24.0]: https://github.com/gako-app/gako/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/gako-app/gako/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/gako-app/gako/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/gako-app/gako/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/gako-app/gako/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/gako-app/gako/compare/v0.11.0...v0.20.0
[0.11.0]: https://github.com/gako-app/gako/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/gako-app/gako/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gako-app/gako/releases/tag/v0.9.0
