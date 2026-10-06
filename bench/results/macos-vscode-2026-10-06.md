# Phase 0 baseline: VS Code on macos, 2026-10-06

The same scenarios in VS Code on the same machine, measured with the same script.

| Run | Settings | Result |
|---|---|---|
| coldstart | matched | to the first task starting: 3381, 3403, 3402, 3410, 3395 ms |
| dump | matched | normal: 23.5 s; memory 1,594 MB → 1,690 MB → 1,799 MB<br>long: 20.4 s; memory 1,434 MB → 1,638 MB → 2,264 MB<br>emoji: 36.8 s; memory 5,346 MB → 6,551 MB → 7,031 MB |
| idle | default | memory median 1,488 MB (min 1,484 MB, max 1,524 MB) |
| idle | matched | memory median 1,495 MB (min 1,487 MB, max 1,519 MB) |
| load | default | memory median 1,640 MB (min 1,579 MB, max 1,735 MB); 50 MB dump 4,570 ms; terminal size seen by the agents: 106x54, 112x54 |
| load | matched | memory median 1,388 MB (min 1,291 MB, max 1,500 MB); 50 MB dump 4,534 ms; terminal size seen by the agents: 106x54, 112x54 |

## Settings

Your own `settings.json`, plus these for automation (both runs):

```json
{
  "workbench.startupEditor": "none",
  "task.allowAutomaticTasks": "on",
  "security.workspace.trust.enabled": false,
  "window.restoreWindows": "none",
  "window.newWindowDimensions": "maximized",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "git.repositoryScanMaxDepth": 2,
  "terminal.integrated.defaultLocation": "editor"
}
```

Matched runs also pin:

```json
{
  "terminal.integrated.scrollback": 1000,
  "terminal.integrated.gpuAcceleration": "on",
  "terminal.integrated.fontSize": 12
}
```

Versions: {"os": "macOS-27.0.1-arm64-arm-64bit-Mach-O", "machine": "arm64", "python": "3.14.7", "psutil": "7.2.2", "metric": "phys_footprint", "macos": "27.0.1", "cpu": "Apple M5", "memGB": 16.0, "gakoCommit": "14e85d6", "vscode": "1.140.0"}
