# The Git view

The Repositories view is Gako's reason to exist: every repository under the base folder in one
list, showing only what has changed.

## Finding repositories

When a base folder opens, the core walks it for repositories:

- A folder is a repository when it holds `.git`, either a folder or, in worktrees and submodules, a
  file pointing elsewhere.
- The walk goes `scanDepth` levels below the base folder (2 by default), skips the folder names in
  `scanIgnore` (`node_modules` by default), and doesn't apply `.gitignore`: nested repositories are
  usually ignored by the base repository, and finding them is the point.
- Folders in `extraFolders` are walked the same way, for repositories that live outside the base
  folder.
- The base folder may be a repository itself. Its status never lists the repositories nested in it
  as untracked folders, whether its `.gitignore` excludes them or not.

## Status

Each repository's status comes from `git status --porcelain=v2 -z --branch --untracked-files=all`,
parsed in the core:

- The branch, or a detached HEAD, or a branch with no commits yet; its upstream, how far ahead and
  behind it is, and whether the upstream is gone from the remote.
- A rebase, merge, cherry-pick, revert or bisect in progress, read from the repository's Git folder
  as VS Code's Git extension does.
- Every changed file, in four groups: **merge conflicts**, **staged changes**, **changes** (not
  staged) and **untracked**. Renames and copies keep their original path.
- Untracked files are listed one by one, up to `untrackedLimit` per repository (2,000 by default);
  beyond that, they're counted.

Repositories with changes are listed first, each with its groups. Clean repositories collapse into
a "Clean repositories" group at the bottom, one line each, so their history stays a click away.

### Running git

Gako runs the `git` CLI, so a repository's own configuration applies: hooks, `core.fsmonitor`,
signing, credential helpers. Every `git` runs with:

- a limit on how many run at once (`maxGitProcesses`, 4 by default), so a large layout doesn't
  thrash;
- a timeout (`gitTimeoutSecs`, 30 by default);
- `GIT_TERMINAL_PROMPT=0`, so a missing credential fails instead of waiting for input nobody can
  give, and `GIT_OPTIONAL_LOCKS=0`, so a status refresh never holds the index lock an agent's
  `git` needs.

## Watching

Gako doesn't poll. One recursive file watch per root (the base folder and the extra folders),
debounced, tells the core which repositories something changed in, and each of those gets a full
status refresh once it has been quiet for `debounceMs` (150 ms by default):

- Changes in a repository's Git folder count too: a commit, a branch switch or a fetch from a
  terminal shows up like a file edit. A worktree's Git folder, which lives inside its main
  repository, is watched as well.
- On macOS, file events name only the folder that changed, so nothing relies on per-file detail.
- **The first change after a quiet spell can show up late on macOS:** FSEvents itself delivers it
  0.4–0.6 s after the change, where later changes take about 0.25 s end to end. Set
  `GAKO_DEBUG_WATCH=1` to see events as they arrive.

The same events tell the Files view which folders to reload and the symbol index which files to
parse again.

## Changed files

Each changed file has buttons, shown when the pointer is over it:

- **Show diff:** a single click opens the diff in a preview tab, which the next one replaces; a
  double click keeps it. ↑ and ↓ move between changed files.
- **Open file:** the whole file in the read-only viewer, with its changes marked.
- **Open in your editor.**
- **Revert changes**, after a confirmation, as VS Code's "Discard Changes" does:
  - changes not staged: the file goes back to its staged version;
  - an untracked file: deleted;
  - staged changes: the file goes back to the last commit, in the index and the working tree. A
    file the last commit doesn't have is unstaged and deleted, and a renamed file's old path comes
    back.
  - Conflicted files can't be reverted from Gako.

### Diffs

A diff compares the two sides of the group the file is in: the staged version against the working
tree for changes, the last commit against the staged version for staged changes, the last commit
against the working tree for a conflict. Diffs are Monaco's, read-only, with syntax highlighting,
and side by side, inline, or automatic (side by side unless the diff is narrow), remembered.

Images and PDFs are compared as they look: before and after side by side, each with where it
comes from, its dimensions and its size. A new or deleted file shows one side empty. See
[navigation.md](navigation.md#the-viewer).

## History

Each repository's history button opens its commit log, loading more as it scrolls. Picking a
commit shows its message, author, date and changed files, each opening the commit's diff for that
file.

## Keeping in sync

- **Fetch** (`git fetch --prune`) refreshes a repository's view of its remote. **Fetch all** does
  every repository, four at a time.
- **Pull** (`git pull --ff-only`) and **push** (`git push`) appear on a repository when its branch
  is behind or ahead of its upstream, with the count. Pulls only fast-forward: anything that would
  need a merge or a rebase is left to you and your terminal. **Pull all** pulls every repository
  that's behind, four at a time, greying out the ones still waiting.
- **Switching branch:** a repository's branch name opens a menu of its branches, local and remote.
  Picking a remote branch creates a local branch tracking it.

Gako doesn't stage, commit, merge, rebase or resolve conflicts. Agents and the terminal do that,
and Gako shows the result.
