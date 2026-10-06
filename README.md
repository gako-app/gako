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
