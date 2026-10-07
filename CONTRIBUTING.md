# Contributing to Gako

Thanks for wanting to help. Bug reports, fixes and improvements are all welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Gako's About
  window (the ⓘ button in the status bar) has a Copy button for the version and system details.
- **Changes beyond a small fix:** open an issue first, so we can agree on the approach before you
  spend time on it.
- **Security problems:** don't open an issue; see [SECURITY.md](SECURITY.md).

### What Gako is, and isn't

Gako is for reviewing and supervising coding agents across many Git repositories: a multi-repo Git
view, read-only diffs and files, terminal tabs for agents, search and navigation. It deliberately
**never edits code**. Editing is handed to an external editor, and the file viewer and diffs stay
read-only. Changes that turn it into an editor or an IDE won't be accepted, however well made.
[docs/scope.md](docs/scope.md) explains the scope, and [docs/decisions.md](docs/decisions.md) the
reasons for it.

## Building and running

Building and running are in the [README](README.md#install). You need Rust (via rustup), Node.js
and git.

## Checks

Run these before you open a pull request:

```bash
npm run check
```

That runs, from the repository root:

- `cargo fmt --check`, `cargo clippy` (warnings are errors) and `cargo test` for the Rust core
- the TypeScript typecheck and the frontend's tests

The same command runs on macOS, Windows and Linux for every push and pull request, so a pull request
shows whether it passes on all three.

If you change something in the window, try it in the app (`npm run app -- /path/to/folder`) on
your platform, and say in the pull request what you tried and where.

## Code

- **Match the code around you:** its naming, its comments and the size of its functions. There's
  no UI framework; the frontend builds its DOM with a small helper (`frontend/src/app/dom.ts`).
- **Reuse, don't rebuild:** Monaco, xterm.js, ripgrep's crates and the `git` CLI do the heavy
  lifting.
- **Keep the shell thin.** Frontend code talks to the core through the `Transport` interface and
  never calls Electron's APIs directly; the Electron shell only manages windows and the core.
- **Cross-platform:** Gako runs on macOS, Windows and Linux. Don't use platform-specific paths,
  shells or tools without a fallback for the other two.
- **Licence notice:** every source file starts with the AGPL notice. For a new file, copy it from an
  existing file in the same language: above any doc comment or docstring, below a shebang or
  `<!doctype html>`. You may add your own copyright line under the existing one.

## Commits and pull requests

- **Sign off every commit** (`git commit -s`). The sign-off certifies the
  [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change,
  or otherwise have the right to submit it under Gako's licence.
- Write plain, descriptive commit messages: a short summary line, then a body if it needs one.
- Keep a pull request to one change. Formatting, refactoring and features go in separate pull
  requests.
- Coding agents are fine to use. You're responsible for what you submit, as if you'd written it
  yourself. [AGENTS.md](AGENTS.md) holds the rules for agents working in this repository.

## Licence

Gako is licensed under the [GNU Affero General Public License, version 3 or later](LICENSE). By
contributing, you agree that your contributions are licensed under the same terms. You keep the
copyright in your work.
