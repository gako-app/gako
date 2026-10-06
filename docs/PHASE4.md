# Phase 4 brief

The working brief for phase 4: project search, scoped by repo. Read [PLAN.md](PLAN.md) first
(*Beyond VS Code: scoped search*; the stack uses ripgrep's own crates inside the core).

**Status: built and measured on macOS (2026-10-06)**
([results](../bench/results/macos-phases3-5-2026-10-06.md)); Windows and Linux at the end.
Decisions were taken without a review round, at the user's request; they're listed at the end and
can be changed.

## What phase 4 delivers

- **Search in files**, from a Search view in the sidebar: text or regular expression, match case,
  whole word, and include and exclude globs. Results stream in as they're found, grouped by repo and
  file, each with its matching lines; clicking one opens the file at that line with the match
  highlighted.
- **Scope, the part VS Code lacks:** all repos, the base repo only, or a chosen set of repos. Each
  repo is searched with its own `.gitignore`, so a nested repo the base repo ignores is still
  searched as itself, and the base repo's search never wanders into it.
- **Go to file** (⌘P on macOS, Ctrl+P elsewhere): fuzzy file-name search across the same scope.
- **The search runs in the core**, with ripgrep's crates (`ignore`, `grep-searcher`,
  `grep-regex`), in parallel, off the frontend's thread. A new search cancels the previous one.

## Out of scope for phase 4

Replace (Gako doesn't edit), searching Git history, saved searches.

## How we'll know it works

- Tests in the core: scopes (all, base only, a subset) with nested repos ignored by the base repo;
  `.gitignore` respected; regex, case and whole-word options; globs; cancellation; result limits.
- Timing on the stress layout (100 repos): the first results within 100 ms, a full search well under
  a second; go-to-file answering as you type.

## Decisions (2026-10-06)

1. **Limits:** 20,000 matches and 10,000 files with matches per search; files over 5 MB and binary
   files are skipped, as ripgrep does by default for binaries. The results say when a limit was hit.
2. **Ignored files aren't searched** (as ripgrep and VS Code do by default); a toggle can include
   them.
3. **Go to file** ranks by a subsequence match on the path, favouring matches in the file name,
   consecutive characters and the start of words.
