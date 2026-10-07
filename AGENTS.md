# Gako — agent guide

Gako is a lean, cross-platform desktop app for reviewing and supervising coding agents across many
Git repositories at once: a multi-repo Git view, read-only diffs and files, terminals for agents,
search and navigation. It never edits code; editing is handed off to an external editor.

## Read first

1. [docs/scope.md](docs/scope.md): what Gako does, what it never does, and its principles.
2. [docs/architecture.md](docs/architecture.md): the shell, the core and the frontend, and the
   connection between them.
3. [docs/decisions.md](docs/decisions.md): why things are the way they are. Read the relevant entry
   before changing one of them.

Then the document for the area you're working in: [git.md](docs/git.md),
[terminals.md](docs/terminals.md), [navigation.md](docs/navigation.md),
[settings.md](docs/settings.md) or [performance.md](docs/performance.md).

## Rules

- **Stay in scope.** Gako never edits code: Monaco stays `readOnly` everywhere. Don't add anything
  from scope.md's "What Gako never does" without being asked.
- **Reuse, don't rebuild:** Monaco, xterm.js, ripgrep's crates, the `git` CLI.
- **Frontend code never calls shell APIs** (Electron's) directly. It goes through the `Transport`
  interface, apart from `boot.ts` (see architecture.md), so the shell stays replaceable.
- **Cross-platform from the start:** macOS, Windows and Linux. Don't use platform-specific paths,
  shells or tools without a fallback for the other two.
- **Keep the docs true.** A change in behaviour updates the document that describes it, in the same
  commit: a new setting goes into settings.md, a changed decision into decisions.md with its
  reasons and costs. Performance numbers come only from measurements (`bench/`), with the results
  committed and linked.
- **Every source file starts with the licence notice** (AGPL-3.0-or-later): copy it from an
  existing file in the same language, above any doc comment or docstring, below a shebang or
  `<!doctype html>`.
- **Ask before** installing system-wide tools or toolchains, downloading anything outside the
  normal package managers' lockfile-driven installs, pushing, or opening pull requests.

## Commits

- Run `npm run check` (formatting, clippy, tests, typecheck) before committing; it must pass.
- Sign off every commit with the DCO line: `git commit -s`.
- **No `Co-Authored-By` trailers and no other AI or tool attribution** in commit messages or PR
  descriptions. The message ends with the `Signed-off-by` line and nothing after it.
- Plain, descriptive messages: a short summary line, then a body if needed.

## Repository layout

`core/` (Rust: the core and `tui-load`), `frontend/` (TypeScript + Vite), `shells/electron/` (the
app shell and packaging), `bench/` (measurement suites and committed results), `docs/`. The full
layout is in architecture.md.
