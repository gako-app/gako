# Phases 3–5 results: explorer, search and navigation on macos, 2026-10-06

Measured against `gako-core` alone with `node bench/measure/core.mjs <layout>` (Apple M5, macOS 27.0.1),
on fresh copies of the generated layouts: work (25 repos, three with 3,000 untracked files) and stress
(100 repos, up to 4 levels deep). Thresholds are in [PHASE3.md](../../docs/PHASE3.md),
[PHASE4.md](../../docs/PHASE4.md) and [PHASE5.md](../../docs/PHASE5.md). Phase 1's UI thresholds re-run with
this code: [macos-phase1-rerun-phase5-2026-10-06.md](macos-phase1-rerun-phase5-2026-10-06.md).

| Measure | Target | Work layout | Stress layout | |
|---|---|---|---|---|
| List a folder of 3,000 files | responsive (< 100 ms) | 7.5 ms | 8.0 ms | **pass** |
| Search: first results | < 100 ms | 75 ms | 100 ms | **pass** |
| Search: whole workspace | well under 1 s | 190 ms (9,490 files) | 477 ms (11,030 files) | **pass** |
| Go to file, per keystroke | as you type (< 50 ms) | 4.5 ms | 8.5 ms | **pass** |
| Symbol index build | in the background | 234 ms (464 files, 2,300 symbols) | 558 ms (1,928 files, 9,206 symbols) | **pass** |
| Go to definition | < 50 ms | 0.1 ms | 0.2 ms | **pass** |
| Go to symbol | < 50 ms | 0.8 ms | 2.2 ms | **pass** |
| A saved function becomes findable | about a second (< 1 s) | 210 ms | 264 ms | **pass** |
| Core memory, everything loaded | reasonable | 41 MB | 49 MB | **pass** |

Searches, in order: a function name, a common fragment (`timeout: 1`), and text that appears nowhere.
Search counts every file it reads, including the 9,000 untracked JSON files in the layouts.

Not yet measured: the stress layout's UI re-run of phase 1's table (the window kept being covered by
other apps, which stops it drawing; it runs in the final pass with the Mac left alone).
