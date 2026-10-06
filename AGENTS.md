# Gako — agent guide

Gako is a lean, cross-platform desktop app for reviewing and supervising coding agents across many
Git repositories at once: a multi-repo Git view, read-only diffs and files, terminal tabs for agents,
search and navigation. It never edits code; editing is handed off to an external editor.

## Read first

1. [docs/PLAN.md](docs/PLAN.md): goal, scope, stack, build order, known traps and decision rules.
   It's the single source of truth.
2. The brief for the current phase. **Phase 0 is done** (see [docs/PHASE0.md](docs/PHASE0.md)): the
   app shell is Electron. **Next: phase 1**, whose brief isn't written yet.

## Rules

- **Change PLAN.md only on the basis of results** (measurements, the trial week), not from more
  drafting. When results change something, update the plan in the same change and link the
  results.
- **Stay in scope.** The app never owns editing: Monaco stays `readOnly` everywhere. Don't add
  anything from PLAN.md's "never owns" list or "Ideas for later" without being asked.
- **Reuse, don't rebuild:** Monaco, xterm.js, ripgrep's crates, the `git` CLI.
- **Frontend code never calls shell APIs** (Electron's, or Tauri's) directly. It goes through the
  transport layer described in PHASE0.md, so the shell stays replaceable.
- **Cross-platform from the start:** macOS (primary), Windows (required at work), Linux. Don't use
  platform-specific paths, shells or tools without a fallback for the other two.
- **Ask before** installing system-wide tools or toolchains, downloading anything outside the
  normal package managers' lockfile-driven installs, pushing, or opening pull requests.

## Commits

- Sign off every commit with the DCO line: `git commit -s`.
- **No `Co-Authored-By` trailers and no other AI or tool attribution** in commit messages or PR
  descriptions. The message ends with the `Signed-off-by` line and nothing after it.
- Plain, descriptive messages: a short summary line, then a body if needed.

## Repository layout

See PHASE0.md for the full layout. In short: `core/` (Rust), `frontend/` (TypeScript + Vite),
`shells/electron/` (the app shell), `shells/tauri/` (phase 0's other shell, kept unmaintained for
re-measuring), `bench/` (fixtures, measurement scripts, committed results),
`docs/`.
