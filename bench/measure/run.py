"""Runs phase 0's measurements and writes the raw results.

    uv run measure/run.py APP SCENARIO [options]
    uv run measure/run.py suite [--apps tauri,electron,vscode]

APP is tauri, electron or vscode. SCENARIOS:

  coldstart  launch to usable window, repeated (--repeat, default 5)
  idle       memory, idle: the 5,000-line diff showing plus one idle terminal
  ui         diff and file open and scroll timings, keystroke to echo (Gako only)
  load       four tui-load agents plus a 50 MB dump in a fifth tab: memory, dump time, integrity
  dump       three 250 MB dumps into one tab: memory over time, dump times, integrity
  cycle      hide and show terminal tabs under the four-agent load (Gako only)
  lifecycle  resize, close a tab, quit: no orphaned processes (Gako only)

Each run writes bench/out/runs/<run id>/result.json; measure/report.py turns those into
bench/results/<platform>-<app>-<date>.md. See bench/RUNNING.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).parent))
import proctree  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "bench"
OUT = BENCH / "out"
FIXTURES = OUT / "fixtures"
PLATFORM = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")
EXE = ".exe" if PLATFORM == "windows" else ""
TUI_LOAD = ROOT / "core" / "target" / "release" / f"tui-load{EXE}"
MB = 1024 * 1024

# Pinned settings, recorded with every result.
PINNED = {"cols": 200, "rows": 50, "scrollback": 1000, "renderer": "webgl", "fontSize": 12}


# --- small helpers ------------------------------------------------------------------------------

def now_ms() -> float:
    return time.time() * 1000


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def wait_for(cond, timeout: float, what: str, proc: subprocess.Popen | None = None, poll: float = 0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = cond()
        if v:
            return v
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"app exited ({proc.returncode}) while waiting for {what}")
        time.sleep(poll)
    raise TimeoutError(f"timed out after {timeout:.0f} s waiting for {what}")


def kill_tree(root: int, pids: set[int] | None = None, grace: float = 10) -> list[dict]:
    """Terminates the app and returns any process from its tree still alive afterwards."""
    procs = {p.pid: p for p in proctree.tree(root)}
    for pid in pids or ():
        try:
            procs.setdefault(pid, psutil.Process(pid))
        except psutil.NoSuchProcess:
            pass
    try:
        psutil.Process(root).terminate()
    except psutil.NoSuchProcess:
        pass
    _, alive = psutil.wait_procs(list(procs.values()), timeout=grace)
    left = []
    for p in alive:
        try:
            left.append({"pid": p.pid, "name": p.name()})
            p.kill()
        except psutil.NoSuchProcess:
            pass
    return left


class Sampler(threading.Thread):
    """Samples the app's memory every `interval` seconds until stopped."""

    def __init__(self, root: int, interval: float):
        super().__init__(daemon=True)
        self.root, self.interval = root, interval
        self.samples: list[dict] = []
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            s = proctree.sample(self.root, now_ms())
            if s.procs:
                self.samples.append({"t": s.t, "total": s.total, "byRole": s.by_role, "n": len(s.procs),
                                     "procs": s.procs})
            self._stop.wait(self.interval)

    def stop(self) -> list[dict]:
        self._stop.set()
        self.join()
        return self.samples


def window(samples: list[dict], start_ms: float, end_ms: float) -> list[dict]:
    return [s for s in samples if start_ms <= s["t"] <= end_ms]


def mem_summary(samples: list[dict]) -> dict | None:
    if not samples:
        return None
    totals = [s["total"] for s in samples]
    roles: dict[str, list[int]] = {}
    for s in samples:
        for r, v in s["byRole"].items():
            roles.setdefault(r, []).append(v)
    last = samples[-1]
    return {
        "n": len(samples),
        "medianMB": statistics.median(totals) / MB,
        "minMB": min(totals) / MB,
        "maxMB": max(totals) / MB,
        "byRoleMedianMB": {r: statistics.median(v) / MB for r, v in roles.items()},
        "processes": sorted(({"name": p["name"], "role": p["role"], "MB": p["mem"] / MB} for p in last["procs"]),
                            key=lambda p: -p["MB"]),
    }


# --- versions -----------------------------------------------------------------------------------

def pkg_version(name: str) -> str | None:
    p = ROOT / "node_modules" / name / "package.json"
    return json.loads(p.read_text())["version"] if p.exists() else None


def cargo_lock_version(lock: Path, name: str) -> str | None:
    if not lock.exists():
        return None
    m = re.search(rf'name = "{re.escape(name)}"\nversion = "([^"]+)"', lock.read_text())
    return m.group(1) if m else None


def versions(app: str) -> dict:
    v = {
        "os": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "psutil": psutil.__version__,
        "metric": proctree.METRIC,
    }
    if PLATFORM == "macos":
        v["macos"] = platform.mac_ver()[0]
        v["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
        v["memGB"] = psutil.virtual_memory().total / 1024**3
    try:
        v["gakoCommit"] = subprocess.run(["git", "describe", "--always", "--dirty"], cwd=ROOT, capture_output=True,
                                         text=True).stdout.strip()
    except OSError:
        pass
    if app in ("tauri", "electron"):
        v["xterm"] = pkg_version("@xterm/xterm")
        v["xtermWebgl"] = pkg_version("@xterm/addon-webgl")
        v["monaco"] = pkg_version("monaco-editor")
        v["portablePty"] = cargo_lock_version(ROOT / "core" / "Cargo.lock", "portable-pty")
    if app == "tauri":
        v["tauri"] = cargo_lock_version(ROOT / "shells" / "tauri" / "src-tauri" / "Cargo.lock", "tauri")
        v["wry"] = cargo_lock_version(ROOT / "shells" / "tauri" / "src-tauri" / "Cargo.lock", "wry")
    if app == "electron":
        v["electron"] = pkg_version("electron")
    if app == "vscode":
        v["vscode"] = vscode_version()
    return v


# --- launching ----------------------------------------------------------------------------------

def gako_command(app: str) -> list[str]:
    if app == "tauri":
        return [str(ROOT / "shells" / "tauri" / "src-tauri" / "target" / "release" / f"gako-tauri{EXE}")]
    dist = ROOT / "node_modules" / "electron" / "dist"
    exe = {"macos": dist / "Electron.app" / "Contents" / "MacOS" / "Electron",
           "windows": dist / "electron.exe", "linux": dist / "electron"}[PLATFORM]
    return [str(exe), str(ROOT / "shells" / "electron")]


def vscode_paths() -> tuple[Path, Path]:
    """The VS Code executable and its command-line script."""
    if os.environ.get("VSCODE_EXE"):
        exe = Path(os.environ["VSCODE_EXE"])
        cli = Path(os.environ.get("VSCODE_CLI", ""))
        return exe, cli
    if PLATFORM == "macos":
        app = Path("/Applications/Visual Studio Code.app/Contents")
        return app / "MacOS" / "Code", app / "Resources" / "app" / "bin" / "code"
    if PLATFORM == "windows":
        base = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Microsoft VS Code"
        return base / "Code.exe", base / "bin" / "code.cmd"
    return Path("/usr/share/code/code"), Path("/usr/share/code/bin/code")


def vscode_resources() -> Path:
    exe, _ = vscode_paths()
    if PLATFORM == "macos":
        return exe.parents[1] / "Resources" / "app"
    return exe.parent / "resources" / "app"


def vscode_version() -> str | None:
    p = vscode_resources() / "package.json"
    return json.loads(p.read_text())["version"] if p.exists() else None


def vscode_user_settings() -> dict:
    path = {"macos": Path.home() / "Library" / "Application Support" / "Code" / "User" / "settings.json",
            "windows": Path(os.environ.get("APPDATA", "")) / "Code" / "User" / "settings.json",
            "linux": Path.home() / ".config" / "Code" / "User" / "settings.json"}[PLATFORM]
    return parse_jsonc(path.read_text()) if path.exists() else {}


def parse_jsonc(text: str) -> dict:
    """JSON with comments and trailing commas, as VS Code's settings files allow."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            i = text.find("\n", i)
            i = n if i < 0 else i
        elif text.startswith("/*", i):
            i = text.find("*/", i) + 2
        else:
            out.append(c)
            i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


# Needed to automate the runs; recorded with the results.
VSCODE_AUTOMATION = {
    "task.allowAutomaticTasks": "on",
    "security.workspace.trust.enabled": False,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
    "window.newWindowDimensions": "maximized",
    "update.mode": "none",
    "extensions.autoUpdate": False,
    "extensions.autoCheckUpdates": False,
    "telemetry.telemetryLevel": "off",
    # Without this the nested repos (two levels down) aren't found: the multi-repo layout.
    "git.repositoryScanMaxDepth": 2,
    # Each terminal fills the window as an editor tab, as in Gako, so it's close to 200x50.
    "terminal.integrated.defaultLocation": "editor",
}
VSCODE_MATCHED = {
    "terminal.integrated.scrollback": PINNED["scrollback"],
    "terminal.integrated.gpuAcceleration": "on",
    "terminal.integrated.fontSize": PINNED["fontSize"],
}


def vscode_settings(mode: str) -> dict:
    s = vscode_user_settings()
    s.update(VSCODE_AUTOMATION)
    if mode == "matched":
        s.update(VSCODE_MATCHED)
    return s


# --- a run --------------------------------------------------------------------------------------

class Run:
    def __init__(self, app: str, scenario: str, settings: str, args: argparse.Namespace):
        self.app, self.scenario, self.settings, self.args = app, scenario, settings, args
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        self.id = f"{PLATFORM}-{app}-{scenario}-{settings}-{stamp}"
        self.dir = OUT / "runs" / self.id
        self.dir.mkdir(parents=True)
        self.logfile = self.dir / "log.jsonl"
        self.result: dict = {
            "runId": self.id, "platform": PLATFORM, "app": app, "scenario": scenario, "settings": settings,
            "date": dt.date.today().isoformat(), "pinned": PINNED, "versions": versions(app),
            "settle": args.settle, "window": args.window,
        }
        self.proc: subprocess.Popen | None = None

    # gako ---------------------------------------------------------------------------------------

    def events(self, ev: str | None = None) -> list[dict]:
        recs = read_jsonl(self.logfile)
        return recs if ev is None else [r for r in recs if r.get("ev") == ev]

    def wait_event(self, ev: str, timeout: float) -> dict:
        return wait_for(lambda: (self.events(ev) or [None])[0], timeout, f"'{ev}'", self.proc)

    def launch_gako(self, extra_env: dict | None = None) -> float:
        env = {**os.environ, "GAKO_SCENARIO": self.scenario, "GAKO_RUN_ID": self.id, "GAKO_LOG": str(self.logfile),
               "GAKO_OUT_DIR": str(self.dir), "GAKO_SCROLLBACK": str(PINNED["scrollback"]),
               "GAKO_RENDERER": PINNED["renderer"], "GAKO_COLS": str(PINNED["cols"]), "GAKO_ROWS": str(PINNED["rows"]),
               **(extra_env or {})}
        t0 = now_ms()
        self.proc = subprocess.Popen(gako_command(self.app), env=env, cwd=ROOT,
                                     stdout=open(self.dir / "app.stdout", "w"), stderr=subprocess.STDOUT)
        return t0

    # vscode -------------------------------------------------------------------------------------

    def vscode_workspace(self, tasks: list[dict]) -> Path:
        ws = self.dir / "bench.code-workspace"
        ws.write_text(json.dumps({
            "folders": [{"path": str(FIXTURES / "workspace" / "platform")}],
            "tasks": {"version": "2.0.0", "tasks": tasks},
        }, indent=2))
        return ws

    def launch_vscode(self, tasks: list[dict]) -> float:
        # A short path: VS Code's IPC socket lives in here, and socket paths are limited to ~100 bytes.
        user_data = Path(tempfile.mkdtemp(prefix="gako-vscode-"))
        (user_data / "User").mkdir(parents=True)
        settings = vscode_settings(self.settings)
        (user_data / "User" / "settings.json").write_text(json.dumps(settings, indent=2))
        self.result["vscodeSettings"] = settings
        self.user_data = user_data
        ws = self.vscode_workspace(tasks)
        exe, _ = vscode_paths()
        t0 = now_ms()
        self.proc = subprocess.Popen([str(exe), "--user-data-dir", str(user_data), "--new-window", str(ws)],
                                     stdout=open(self.dir / "app.stdout", "w"), stderr=subprocess.STDOUT)
        return t0

    def vscode_cli(self, *args: str) -> None:
        _, cli = vscode_paths()
        subprocess.run([str(cli), "--user-data-dir", str(self.user_data), *args], capture_output=True, timeout=60)

    def task(self, label: str, args: list[str], reveal: str = "always", close: bool = False) -> dict:
        return {"label": label, "type": "process", "command": str(TUI_LOAD), "args": args,
                "runOptions": {"runOn": "folderOpen"}, "problemMatcher": [],
                "presentation": {"reveal": reveal, "panel": "dedicated", "focus": False, "close": close}}

    def stamp_task(self) -> dict:
        return self.task("stamp", ["stamp", str(self.dir / "stamp.json")], reveal="never", close=True)

    def report(self, name: str) -> dict | None:
        p = self.dir / name
        try:
            return json.loads(p.read_text()) if p.exists() else None
        except json.JSONDecodeError:
            return None

    # sampling -----------------------------------------------------------------------------------

    def measure_window(self, start_ms: float, sampler: Sampler) -> dict:
        """Settle, then sample for the window, as PLAN.md requires."""
        settle_end = start_ms + self.args.settle * 1000
        end = settle_end + self.args.window * 1000
        log(f"settling {self.args.settle} s, then sampling {self.args.window} s")
        wait_for(lambda: now_ms() >= end, self.args.settle + self.args.window + 60, "the sampling window", self.proc,
                 poll=1)
        pids = [p["pid"] for p in (sampler.samples[-1]["procs"] if sampler.samples else [])]
        summary = mem_summary(window(sampler.samples, settle_end, end))
        if summary is not None:
            summary["footprint"] = proctree.footprint(pids)
        return summary or {}

    def finish(self, sampler: Sampler | None = None, extra_pids: set[int] | None = None) -> None:
        samples = sampler.stop() if sampler else []
        left = kill_tree(self.proc.pid, extra_pids) if self.proc else []
        self.result["leftAfterQuit"] = left
        if getattr(self, "user_data", None):
            shutil.rmtree(self.user_data, ignore_errors=True)
        # Keep the per-process detail of one sample in ten, so the file stays small.
        self.result["samples"] = [{k: v for k, v in s.items() if k != "procs" or i % 10 == 0}
                                  for i, s in enumerate(samples)]
        self.result["events"] = [r for r in self.events() if r.get("ev") not in ("termSpawn",)]
        (self.dir / "result.json").write_text(json.dumps(self.result, indent=1, default=str))
        log(f"wrote {self.dir / 'result.json'}")


# --- scenarios ----------------------------------------------------------------------------------

def manifest() -> dict:
    return json.loads((FIXTURES / "manifest.json").read_text())


def run_coldstart(run: Run) -> None:
    times = []
    for i in range(run.args.repeat):
        if run.app == "vscode":
            stamp = run.dir / "stamp.json"
            stamp.unlink(missing_ok=True)
            if i:
                shutil.rmtree(run.user_data, ignore_errors=True)
            t0 = run.launch_vscode([run.stamp_task()])
            wait_for(lambda: run.report("stamp.json"), 120, "the stamp task", run.proc)
            ms = run.report("stamp.json")["epochMs"] - t0
        else:
            before = len(run.events("usable"))
            t0 = run.launch_gako()
            rec = wait_for(lambda: (run.events("usable")[before:] or [None])[0], 60, "'usable'", run.proc)
            ms = rec["epochMs"] - t0
        times.append(ms)
        log(f"cold start {i + 1}: {ms:.0f} ms")
        kill_tree(run.proc.pid)
        time.sleep(3)
    run.result["coldStartMs"] = times
    run.result["coldStart"] = {"first": times[0], "medianRest": statistics.median(times[1:]) if len(times) > 1 else None}
    run.proc = None
    run.finish()


def run_idle(run: Run) -> None:
    m = manifest()
    if run.app == "vscode":
        shell = os.environ.get("SHELL", "/bin/bash") if PLATFORM != "windows" else "powershell.exe"
        idle_shell = {"label": "Shell", "type": "process", "command": shell, "args": [] if PLATFORM == "windows" else ["-l"],
                      "runOptions": {"runOn": "folderOpen"}, "problemMatcher": [],
                      "presentation": {"reveal": "never", "panel": "dedicated", "focus": False}}
        run.launch_vscode([run.stamp_task(), idle_shell])
        sampler = Sampler(run.proc.pid, 5)
        sampler.start()
        wait_for(lambda: run.report("stamp.json"), 120, "the stamp task", run.proc)
        time.sleep(5)
        run.vscode_cli("--reuse-window", "--diff", str(FIXTURES / m["diff"]["old"]), str(FIXTURES / m["diff"]["new"]))
        start = now_ms()
    else:
        run.launch_gako()
        sampler = Sampler(run.proc.pid, 5)
        sampler.start()
        start = run.wait_event("scenarioReady", 120)["epochMs"]
    run.result["memory"] = run.measure_window(start, sampler)
    run.finish(sampler)


def run_ui(run: Run) -> None:
    run.launch_gako()
    run.wait_event("scenarioDone", 600)
    run.finish()


def run_load(run: Run) -> None:
    m = manifest()
    seconds, dump_at = run.args.load_seconds, 20
    if run.app == "vscode":
        tasks = [run.stamp_task()]
        tasks += [run.task(f"Agent {i}", ["run", "--seconds", str(seconds), "--seed", str(i), "--report",
                                          str(run.dir / f"tui-{i}.json")]) for i in range(1, 5)]
        tasks.append(run.task("Dump", ["dump", str(FIXTURES / m["load"]["path"]), "--delay", str(dump_at),
                                       "--report-dir", str(run.dir)]))
        run.launch_vscode(tasks)
        sampler = Sampler(run.proc.pid, 5)
        sampler.start()
        start = wait_for(lambda: run.report("stamp.json"), 120, "the stamp task", run.proc)["epochMs"]
    else:
        run.launch_gako({"GAKO_LOAD_SECONDS": str(seconds), "GAKO_LOAD_DUMP_AT": str(dump_at)})
        sampler = Sampler(run.proc.pid, 5)
        sampler.start()
        start = run.wait_event("loadStarted", 120)["epochMs"]
    run.result["memory"] = run.measure_window(start, sampler)
    if run.app == "vscode":
        wait_for(lambda: all(run.report(f"tui-{i}.json") for i in range(1, 5)), seconds + 120, "the agents", run.proc, 1)
        run.result["dump"] = run.report("dump-load.json")
        run.result["tui"] = [run.report(f"tui-{i}.json") for i in range(1, 5)]
    else:
        run.wait_event("scenarioDone", seconds + 300)
        run.result["dump"] = run.report("dump-load.json")
        run.result["tui"] = [run.report(f"tui-{i}.json") for i in range(1, 5)]
    run.finish(sampler)


def run_dump(run: Run) -> None:
    m = manifest()
    pause = run.args.dump_pause
    kinds = ["normal", "long", "emoji"]
    files = [str(FIXTURES / m[k]["path"]) for k in kinds]
    if run.app == "vscode":
        run.launch_vscode([run.stamp_task(),
                           run.task("Dumps", ["dump", *files, "--delay", str(pause), "--pause", str(pause),
                                              "--report-dir", str(run.dir)])])
    else:
        run.launch_gako({"GAKO_DUMP_PAUSE": str(pause)})
    sampler = Sampler(run.proc.pid, 2)
    sampler.start()
    timeout = 3 * 3600
    wait_for(lambda: run.report("dump-emoji.json"), timeout, "the three dumps", run.proc, 2)
    time.sleep(pause)
    if run.app != "vscode":
        run.wait_event("scenarioDone", pause + 120)
    samples = list(sampler.samples)
    analysis = {}
    for k in kinds:
        r = run.report(f"dump-{k}.json")
        if not r:
            continue
        s, e = r["startEpochMs"], r["endEpochMs"]
        during = window(samples, s, e)
        at = lambda q: during[min(len(during) - 1, int(q * len(during)))]["total"] / MB if during else None  # noqa: E731
        second_half = [x["total"] for x in during[len(during) // 2:]]
        analysis[k] = {
            "elapsedMs": r["elapsedMs"], "bytes": r["bytes"], "samples": len(during),
            "MBat10": at(0.1), "MBat50": at(0.5), "MBat90": at(0.9), "MBend": at(0.999),
            "peakMB": max((x["total"] for x in during), default=0) / MB,
            "growthSecondHalfMB": (max(second_half) - min(second_half)) / MB if second_half else None,
            "after": mem_summary(window(samples, e + 5000, e + pause * 1000 - 1000)),
        }
    run.result["dumps"] = analysis
    run.finish(sampler)


def run_cycle(run: Run) -> None:
    run.launch_gako({"GAKO_CYCLE_SECONDS": str(run.args.cycle_seconds)})
    sampler = Sampler(run.proc.pid, 5)
    sampler.start()
    start = run.wait_event("cycleStarted", 120)["epochMs"]
    run.wait_event("scenarioDone", run.args.cycle_seconds + 300)
    samples = window(sampler.samples, start + 60_000, now_ms())
    if len(samples) >= 3:
        xs = [(s["t"] - samples[0]["t"]) / 60000 for s in samples]
        ys = [s["total"] / MB for s in samples]
        slope = statistics.linear_regression(xs, ys).slope
        run.result["memorySlopeMBPerMin"] = slope
        run.result["memory"] = mem_summary(samples)
    run.finish(sampler)


def descendants(pid: int) -> list[dict]:
    try:
        return [{"pid": c.pid, "name": c.name()} for c in psutil.Process(pid).children(recursive=True)]
    except psutil.NoSuchProcess:
        return []


def alive(pids: list[int]) -> list[int]:
    return [p for p in pids if psutil.pid_exists(p) and psutil.Process(p).status() != psutil.STATUS_ZOMBIE]


def run_lifecycle(run: Run) -> None:
    run.launch_gako()
    spawned = run.wait_event("lifecycleSpawned", 120)
    tabs = {pid: [pid] + [d["pid"] for d in descendants(pid)] for pid in spawned["pids"] if pid}
    run.result["tabs"] = {str(k): v for k, v in tabs.items()}
    closing = run.wait_event("tabClosing", 120)
    run.wait_event("readyToQuit", 120)
    closed = tabs.get(closing["pid"], [])
    run.result["closedTab"] = {"pids": closed, "aliveAfterClose": alive(closed)}
    everything = {p.pid for p in proctree.tree(run.proc.pid)} | {p for v in tabs.values() for p in v}
    everything.discard(run.proc.pid)
    if run.args.quit == "kill":
        run.proc.kill()
    else:
        run.proc.terminate()
    time.sleep(5)
    run.result["quit"] = run.args.quit
    run.result["aliveAfterQuit"] = [{"pid": p, "name": psutil.Process(p).name()} for p in alive(list(everything))]
    log(f"closed tab left {len(run.result['closedTab']['aliveAfterClose'])} processes; "
        f"quit ({run.args.quit}) left {len(run.result['aliveAfterQuit'])}")
    run.finish(extra_pids=everything)


SCENARIOS = {"coldstart": run_coldstart, "idle": run_idle, "ui": run_ui, "load": run_load, "dump": run_dump,
             "cycle": run_cycle, "lifecycle": run_lifecycle}
GAKO_ONLY = {"ui", "cycle", "lifecycle"}


def run_one(app: str, scenario: str, settings: str, args: argparse.Namespace) -> Path:
    if app == "vscode" and scenario in GAKO_ONLY:
        raise SystemExit(f"{scenario} is a Gako-only scenario")
    run = Run(app, scenario, settings, args)
    log(f"run {run.id}")
    try:
        SCENARIOS[scenario](run)
    except BaseException:
        if run.proc is not None:
            kill_tree(run.proc.pid)
        raise
    return run.dir


def suite(args: argparse.Namespace) -> None:
    apps = args.apps.split(",")
    plan = []
    for app in apps:
        modes = ["matched", "default"] if app == "vscode" else ["default"]
        for scenario in ["coldstart", "idle", "ui", "load", "dump", "cycle", "lifecycle"]:
            if app == "vscode" and scenario in GAKO_ONLY:
                continue
            for mode in modes if scenario in ("idle", "load") else modes[:1]:
                plan.append((app, scenario, mode))
    for app, scenario, mode in plan:
        run_one(app, scenario, mode, args)
        if scenario == "lifecycle":
            run_one(app, scenario, mode, argparse.Namespace(**{**vars(args), "quit": "kill"}))
        time.sleep(10)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("app", choices=["tauri", "electron", "vscode", "suite"])
    ap.add_argument("scenario", nargs="?", choices=list(SCENARIOS))
    ap.add_argument("--settings", choices=["matched", "default"], default=None,
                    help="VS Code: matched pins the terminal settings to Gako's; default keeps your own settings")
    ap.add_argument("--apps", default="tauri,electron,vscode", help="for suite")
    ap.add_argument("--settle", type=float, default=120, help="seconds to settle before sampling (PLAN.md: 120)")
    ap.add_argument("--window", type=float, default=60, help="seconds of samples after settling")
    ap.add_argument("--repeat", type=int, default=5, help="coldstart launches")
    ap.add_argument("--load-seconds", type=int, default=240)
    ap.add_argument("--dump-pause", type=int, default=30)
    ap.add_argument("--cycle-seconds", type=int, default=240)
    ap.add_argument("--quit", choices=["term", "kill"], default="term", help="lifecycle: how to quit the app")
    args = ap.parse_args()
    if args.app == "suite":
        suite(args)
        return
    if not args.scenario:
        ap.error("scenario is required")
    settings = args.settings or ("matched" if args.app == "vscode" else "default")
    print(run_one(args.app, args.scenario, settings, args))


if __name__ == "__main__":
    main()
