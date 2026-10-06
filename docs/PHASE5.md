# Phase 5 brief

The working brief for phase 5: go to definition and find references, read-only. Read
[PLAN.md](PLAN.md) first (*Why a symbol index before language servers*, and *Its honest limit*).

**Status: built and measured on macOS (2026-10-06)**
([results](../bench/results/macos-phases3-5-2026-10-06.md)); Windows and Linux at the end.
Decisions were taken without a review round, at the user's request; they're listed at the end and
can be changed.

## What phase 5 delivers

- **A project-wide symbol index** in the core, built with tree-sitter's tag queries (the approach
  GitHub's code navigation uses): functions, methods, classes, interfaces, types, modules and
  constants, for Rust, TypeScript and TSX, JavaScript, Python, Go, Java, C, C++, Ruby, C# and PHP.
  It covers every repo in the workspace, is built in the background when the workspace opens, and
  stays current: files that change are parsed again.
- **Go to definition** (F12, or ⌘/Ctrl-click) on a word in the file viewer or a diff: one match
  opens directly; several (the same name in several places or repos) show a list to pick from,
  ranked with the current repo and file first.
- **Go to symbol** (⌘T or Ctrl+T outside a terminal): fuzzy search over every symbol in the
  workspace.
- **Find references** (Shift+F12): a whole-word, case-sensitive search for the name across the
  workspace, shown in the Search view, and labelled as name-based.

## Its honest limit, as PLAN.md says

The index resolves by **name**, not by binding: `Handler` may match twenty definitions across repos,
and "references" are every occurrence of the word. Binding-accurate definitions and references need
language servers through `monaco-languageclient`, which stays for later, for the languages where
it's missed (and for variables, which name-based indexing handles worst).

## Out of scope for phase 5

Language servers, hover information, type information, call hierarchies, rename.

## How we'll know it works

- Tests in the core: definitions extracted for each language from small samples; an index that
  follows file changes; ranking.
- On the stress layout (100 repos): the index builds in the background without slowing the UI,
  memory stays reasonable, and lookups answer in under 50 ms.

## Decisions (2026-10-06)

1. **Languages:** the eleven above, chosen for having maintained tree-sitter grammars with tag
   queries; more can be added the same way.
2. **What's indexed:** definitions only (references come from search); files over 1 MB and ignored
   files are skipped, like search.
3. **Updates:** the watcher's change events trigger re-parsing of changed files in those folders,
   debounced; a full rebuild happens when repos are added or removed.
