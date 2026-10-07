# Gako's documentation

How Gako works and why it's built the way it is. To install and run it, start with the
[README](../README.md).

## Using Gako

- [Settings](settings.md): every setting, with its default.
- [The Git view](git.md): finding repositories, status, diffs, history, and keeping in sync.
- [Terminals and agents](terminals.md): starting agents, the agent bar and how it knows what an
  agent is doing, closing and reopening.
- [Files, search and navigation](navigation.md): the file tree, the viewer, search, go to file and
  go to definition.

## Understanding and changing Gako

- [Scope](scope.md): what Gako is for, what it never does, and its principles. Read this first.
- [Architecture](architecture.md): the shell, the core and the frontend, the connection between
  them, the security boundary, and where things are kept.
- [Decisions](decisions.md): the choices that shape Gako, why they were made, and what they cost.
- [Performance](performance.md): the budgets Gako holds itself to, how they're measured, and the
  latest results. Running the measurements is in [bench/README.md](../bench/README.md).

For contributing, see [CONTRIBUTING.md](../CONTRIBUTING.md); for reporting a security problem,
[SECURITY.md](../SECURITY.md).
