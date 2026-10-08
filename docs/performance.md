# Performance

Gako exists partly to be lighter than the editor it sits beside, so it holds itself to budgets
measured against VS Code on the same machine, with a fixed method. The suites that measure them are
in [bench/](../bench/README.md); every run's results are committed in
[bench/results/](../bench/results/).

## Budgets

### Terminals and the viewer

| Measure | Budget |
|---|---|
| Open a 5,000-line diff (warm) | under 300 ms |
| Scroll that diff, and a 5 MB file | at least 50 fps, no frame over 50 ms |
| Open a 5 MB file (warm) | under 1 s |
| Keystroke to echo in a terminal | under 30 ms |
| Four agent TUIs at once, plus a 50 MB dump in a fifth terminal | nothing lost or garbled, the other terminals responsive, the dump no slower than in VS Code |
| 250 MB dumped into one terminal, three times: line-oriented output, very long lines, combining marks mixed with emoji | memory flat once scrollback is full, and each dump no slower than in VS Code |
| Hide and show terminals repeatedly under the four-agent load | no blank or garbled terminals, memory doesn't creep |
| Resize, close a terminal, quit, crash | every child process exits |
| Cold start to a usable window | under 1.5 s |
| **Memory, idle** | **at most half of VS Code's** |
| **Memory, under the four-agent load** | **no more than VS Code's** |

### The Git view

On a generated layout of 25 repositories (three with 3,000 untracked files each), and a stress
layout of 100 repositories up to four levels deep:

| Measure | Budget |
|---|---|
| First full scan | under 2 s (25 repositories), under 8 s (100) |
| A file saved or reverted → shown | under 500 ms |
| A commit from a terminal → shown | under 1 s |
| CPU when nothing changes | under 1% of a core (no polling) |
| Memory, idle with the view open | at most half of VS Code's on the same layout |

### Files, search and navigation

| Measure | Budget |
|---|---|
| List a folder of 3,000 files | under 100 ms |
| Search: first results | under 100 ms |
| Search: the whole workspace | well under 1 s |
| Go to file, per keystroke | under 50 ms |
| Go to definition, go to symbol | under 50 ms |
| A saved function becomes findable | under 1 s |
| Symbol index | built in the background, without slowing the window |

**Memory is the budget that matters most.** A build can pass every latency check and still fail the
point of the project.

## Method

The method stays fixed, so numbers taken months apart can be compared:

- **The whole process tree.** Memory is summed over the app's process tree, walked from its own
  root process and never by process name: Electron and VS Code are both many processes, and other
  apps run processes with the same names. On macOS, some helper processes belong to launchd, not
  the app; the walk follows macOS's "responsible process" link to them, which is how Activity
  Monitor groups them.
- **The same metric for every app:** unique memory (USS) on Linux and Windows, where Windows calls
  it the private working set, and the physical footprint on macOS, where USS can't be read. On
  Linux, memory is read as root, since Chromium makes its sandboxed processes unreadable to their
  own user.
- **Settled:** two minutes after the workspace finishes loading, or into the load, then a minute of
  samples; the median counts.
- **Pinned settings:** the same scrollback (1,000 rows), renderer (WebGL) and font size in both
  apps, and the same terminal size: Gako's terminals are pinned to the size VS Code's get on that
  machine, since VS Code's can't be set and width multiplies scrollback memory.
- **VS Code twice:** with those settings matched ("is Gako leaner?") and out of the box ("will
  this machine use less memory?"), with the extensions actually in use, in a profile of its own.
- **Nothing lost:** every byte the frontend receives is hashed and compared with the core's hash of
  what it read from the PTY, and the test programs' output carries sequence numbers and checksums
  that are checked in xterm.js's buffer afterwards.

## Latest results

All budgets pass on macOS (a MacBook Air M5 with 16 GB), with one known exception. The headline numbers:

| | Gako | VS Code |
|---|---|---|
| Memory, idle | 204 MB | 1,495 MB |
| Memory, four agents and a dump | 348 MB | 1,388 MB |
| Memory, idle with 25 repositories open | 266 MB | 917 MB |
| Cold start | 339 ms | 3,402 ms |
| 250 MB of combining marks and emoji | 4.6 s, flat at 404 MB | 36.8 s, up to about 7 GB |

The full tables:
[terminals and viewer](../bench/results/macos-electron-phase2-2026-10-06.md) (with
[cold start and idle memory](../bench/results/macos-electron-2026-10-06.md)),
[Git view](../bench/results/macos-phase1-rerun-phase5-2026-10-06.md),
[files, search and navigation](../bench/results/macos-phases3-5-2026-10-06.md), and
[VS Code](../bench/results/macos-vscode-2026-10-06.md).

On Linux (Ubuntu 24.04, Intel graphics), the terminal and viewer suite ran once, before the
combining-marks limit was added: [Gako](../bench/results/linux-electron-2026-10-06.md),
[VS Code](../bench/results/linux-vscode-2026-10-06.md). Gako used 147 MB idle against VS Code's
1,244 MB, and 236 MB under load against 1,022 MB. It failed the combining-marks dump, which the
limit has since fixed on macOS; the line-oriented dump, by a borderline 14.7 MB move that ended
where it had levelled off; and the memory trend while hiding and showing terminals (below).

**Not measured yet:** Windows, and the Git view and navigation suites on Linux.

### Known exceptions

- **The first change after a quiet spell, on macOS.** A file saved after two or more quiet minutes
  can take 0.4–0.6 s to show, against a 500 ms budget, because FSEvents delivers that first event
  late; later changes show in about 0.25 s. It's in the operating system's event delivery, not in
  Gako's debouncing, which already asks for no added latency.
- **Hiding and showing terminals on Linux** showed memory trends of 4–5.5 MB a minute in four-minute
  runs. On macOS, a fifteen-minute run showed the same pattern was garbage collection swinging, not
  a leak (0.83 MB a minute); the Linux runs haven't been repeated at that length.
