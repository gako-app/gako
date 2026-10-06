# Gako

Work in progress: a lean, cross-platform workspace app for reviewing and supervising coding agents
across many repositories at once.

- [docs/PLAN.md](docs/PLAN.md): the plan
- [docs/](docs/): the phase briefs; [AGENTS.md](AGENTS.md#read-first) says where each phase stands
- [AGENTS.md](AGENTS.md): guide for coding agents working in this repo

## Run it

Needs Rust (via rustup), Node.js and git. From the repository root:

```bash
npm install
npm run app -- /path/to/your/base/folder
```

This builds the frontend and the core, then opens the folder in Gako. Without a folder, Gako
reopens the last one, or asks.

## Package it

```bash
npm run package
```

This builds the frontend and the core and packages them with the Electron shell for this platform
into `dist/`: `Gako.app` on macOS (copy it to `/Applications`), a `Gako` folder with `Gako.exe` on
Windows, and a `gako` folder on Linux. A packaged Gako opens the folder given on its command line
(`open -a Gako --args /path/to/folder` on macOS), or the last one it had open. It isn't signed, so
it's for the machine it was built on.

The icon's source is `shells/electron/build/icon.svg`; `npm run icons -w shells/electron` renders
the files packaging uses from it.

Packaging also regenerates [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt): the npm packages and
Rust crates Gako includes, with their licences. The app carries it, with Electron's and Chromium's
own notices, and opens it from the Gako menu (Third-Party Notices…).
