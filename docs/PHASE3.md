# Phase 3 brief

The working brief for phase 3: the file explorer, a read-only file viewer, and "open in editor".
Read [PLAN.md](PLAN.md) first: Gako never edits files; editing is handed to an external editor.

**Status: built and measured on macOS (2026-10-06)**
([results](../bench/results/macos-phases3-5-2026-10-06.md)); Windows and Linux at the end.
Decisions were taken without a review round, at the user's request; they're listed at the end and
can be changed.

## What phase 3 delivers

- **A Files view** in the sidebar, next to Repositories and Review queue: the base folder as a tree,
  loaded folder by folder as it's expanded. Nested repos are marked as repos. Files show their Git
  state (modified, added, untracked, conflicted) in the same colours as the repos view; files that
  `.gitignore` excludes are dimmed, and `.git` folders aren't shown.
- **A read-only viewer**: clicking a file opens it in Monaco with syntax highlighting, never
  editable. Binary files and files over 50 MB get a message instead.
- **Open in editor**: from the viewer, the diff view and the tree, the file opens in the configured
  editor at the current line. With nothing configured, Gako uses VS Code (`code -g`) or Zed if
  either is on the PATH, and otherwise the operating system's default app for the file.
- **The tree stays current**: the workspace watcher already sees every change; expanded folders that
  changed reload by themselves.

## Out of scope for phase 3

Editing, renaming, moving or deleting files from the tree (editing belongs to the editor; file
operations can come later if missed); finding files by name and searching contents (phase 4);
image previews.

## How we'll know it works

- Tests in the core for listing folders (ignored entries, nested repos, `.git` hidden, symlinks not
  followed out of the workspace) and for building editor commands.
- In the app: expanding a folder of 3,000 files stays responsive; a file created, changed or deleted
  by an agent shows up in an expanded folder within a second; open in editor lands on the right line.

## Decisions (2026-10-06)

1. **Ignored files are shown, dimmed**, as VS Code does, since build output and logs are often what
   you want to look at; `.git` folders are hidden.
2. **Editor setting:** `editor` is a command line with `{file}`, `{line}` and `{column}` placeholders,
   for example `["code", "-g", "{file}:{line}:{column}"]` or `["zed", "{file}:{line}"]`. Unset, Gako
   picks VS Code, then Zed, then the system's default app.
3. **Large folders** list their first 5,000 entries, with a note that more exist.
