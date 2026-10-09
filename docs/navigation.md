# Files, search and navigation

Everything for reading code: the file tree, the viewer, search, go to file, and go to definition.
All of it is read-only; "Open in editor" hands a file to your editor when you want to change it.

## Files

The Files view shows the base folder as a tree, loaded folder by folder as you expand it:

- Repositories nested in it have a folder icon of their own. Files show their Git state in the same
  colours as the Repositories view, and every folder holding changed files has a dot, up to the base
  folder, so a change shows on a collapsed folder whatever repository it's in. Files that
  `.gitignore` excludes are dimmed rather than hidden (build output and logs are often what you want
  to look at), and `.git` folders aren't shown.
- A folder lists its first 5,000 entries, with a note when there are more.
- Expanded folders reload by themselves when their contents change, from the same file watching
  that keeps the Git view current.
- ↑ and ↓ move, → opens a folder and ← closes it, Enter opens a file.
- The context menu opens a file in any editor Gako found (the one you pick becomes the default) and
  copies its path, absolute or relative.

## The viewer

A file opens in Monaco, read-only, with syntax highlighting for every language Monaco knows.

- **Change markers:** lines added, changed or deleted since the last commit are marked in the
  gutter, in VS Code's colours, whether the changes are staged or not. Clicking a marker shows the
  old lines under the new ones, with steps to the previous and next change.
- **Images and PDFs** show as they are. An image (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) sits on a
  checkerboard, fitted to the view, with its dimensions and size; a click shows it at its actual
  size. A PDF opens in Chromium's own viewer, with its pages, zoom and search. The type comes from
  the file's extension, and the browser is told that type rather than left to guess, so a
  mislabelled file fails to show rather than being treated as something else. SVG files are text,
  and show as text.
- Other binary files show their size instead of their contents, and files over 50 MB are cut off
  there (images and PDFs over 50 MB aren't shown).
- **Open in editor** opens the file at the cursor's line, or at the top of the view.
- **Find** (⌘F, Ctrl+F) searches the file in front, or either side of a diff, with Monaco's find
  widget. Pressed outside the editor (in the sidebar, say), it opens on the file in front, or on a
  diff's side after the change (before it, for a deleted file). The widget has match case, whole
  word and regular expressions, with Enter and Shift+Enter (or F3 and Shift+F3) stepping through
  the matches. There's no replace, since the viewer is read-only.

Tabs work as VS Code's editor tabs do: a single click opens a preview tab (in italics) that the
next one replaces, and a double click keeps it. Dragging a tab moves it along the bar (a preview tab
moved is kept), and Escape during the drag puts it back. A middle click or the × closes a tab, ⌘W
(Ctrl+W, Ctrl+Shift+W or Ctrl+F4) closes the tab in front, and Ctrl+Tab and Ctrl+Shift+Tab step through the tabs. The tabs
open for a base folder come back when it's opened again.

## Opening files in your editor

Gako finds the editors it knows on the `PATH` or, failing that, where their installers put them:
VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf, Zed and Sublime Text. Looking beyond the
`PATH` matters: VS Code's `code` command, for one, isn't there on macOS until you install it from VS
Code's command palette.

The first editor found is used, unless the `editor` setting names another or a command line of your
own (see [settings.md](settings.md)), or you pick one from the Files view's context menu. Gako
never falls back to the operating system's default app: that ignores the line and sends each file
type somewhere different, so with no editor found, Gako says so.

## Search

The Search view (⌘⇧F, Ctrl+Shift+F off macOS) searches file contents in the core, with ripgrep's
own crates:

- Text or a regular expression, match case and whole word, toggled inside the search field.
- **Scope:** all repositories, or the ones ticked in the "In" menu (the base folder's own
  repository among them, when it is one). Each repository is searched with its own `.gitignore`,
  so a nested repository that the base repository ignores is still searched as itself, and the base
  repository's search never wanders into it.
- **Filters**, folded away until wanted (with a count while any are set): files to include and to
  exclude, by glob, and "Include files Git ignores" (ignored files are skipped otherwise). Binary
  files and files over 5 MB are always skipped.
- Results stream in as they're found, grouped by repository and file. A search stops at 20,000
  matches or 10,000 files with matches, and says so. A new search cancels the one before.

**Go to file** (⌘P, Ctrl+P) is a fuzzy search on file paths across all repositories. It favours
matches in the file name, consecutive characters and the start of words.

## Go to definition

The core builds a project-wide **symbol index** when a folder opens, in the background, with
tree-sitter's tag queries: the approach GitHub's code navigation uses. It holds the definitions of
functions, methods, classes, interfaces, types, modules and constants in Rust, TypeScript and TSX,
JavaScript, Python, Go, Java, C, C++, Ruby, C# and PHP, across every repository. Files over 1 MB and
ignored files are skipped, and changed files are parsed again as they change.

- **Go to definition** (F12, or ⌘-click or Ctrl-click) on a word in the viewer or a diff: one match
  opens directly; several show a list, with the current repository and file first.
- **Go to symbol** (⌘T, Ctrl+T): a fuzzy search over every symbol in the workspace.
- **Find references** (Shift+F12): a whole-word, case-sensitive search for the name, shown in the
  Search view.

**Its limit:** the index resolves by name, not by binding. `Handler` may match twenty definitions
across repositories, and "references" are every occurrence of the word. In exchange it needs no
per-language setup, no language servers to install and run, and works the same way in every
repository. Binding-accurate navigation would need language servers; see
[decisions.md](decisions.md#navigation-by-name-not-by-language-servers).

Off macOS, Ctrl+P, Ctrl+T and Ctrl+Shift+F stay with a terminal while you're typing in one, since
shells use them.
