# Phase 0 baseline: VS Code on linux, 2026-10-06

The same scenarios in VS Code on the same machine, measured with the same script.

| Run | Settings | Result |
|---|---|---|
| coldstart | matched | to the first task starting: 5145, 5168, 5111, 5120, 5181 ms |
| dump | matched | normal: 45.0 s; memory 1,234 MB → 1,281 MB → 1,956 MB<br>long: 40.6 s; memory 1,028 MB → 1,467 MB → 1,502 MB<br>emoji: 81.2 s; memory 1,153 MB → 1,512 MB → 1,993 MB |
| idle | default | memory median 1,236 MB (min 1,234 MB, max 1,239 MB) |
| idle | matched | memory median 1,244 MB (min 1,241 MB, max 1,247 MB) |
| load | default | memory median 1,200 MB (min 1,153 MB, max 1,234 MB); 50 MB dump 10,166 ms; terminal size seen by the agents: 138x55, 146x55 |
| load | matched | memory median 1,022 MB (min 997 MB, max 1,075 MB); 50 MB dump 9,425 ms; terminal size seen by the agents: 161x63, 167x63 |

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

Versions: {"os": "Linux-7.0.0-34-generic-x86_64-with-glibc2.39", "machine": "x86_64", "python": "3.12.3", "psutil": "7.2.2", "metric": "uss", "gakoCommit": "9b34b7e", "vscode": "1.140.0"}
