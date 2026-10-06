"""Turns raw runs into bench/results/<platform>-<shell>-<date>.md, one row per line of PLAN.md's table.

    uv run measure/report.py [--date YYYY-MM-DD] [--platform macos]

Uses the latest run of each (app, scenario, settings) on that date. Thresholds are PLAN.md's; the
memory rows compare against the VS Code baseline run on the same machine.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from run import BENCH, OUT, PLATFORM, VSCODE_AUTOMATION, VSCODE_MATCHED  # noqa: E402

RESULTS = BENCH / "results"

# A dump's memory counts as flat when the second half of the dump moves less than this.
FLAT_MB = 10.0
FLAT_FRACTION = 0.03


def load_runs(platform: str, date: str) -> dict[tuple[str, str, str], dict]:
    runs: dict[tuple[str, str, str], dict] = {}
    for f in sorted((OUT / "runs").glob(f"{platform}-*/result.json")):
        r = json.loads(f.read_text())
        if r.get("date") != date:
            continue
        runs[(r["app"], r["scenario"], r["settings"])] = r  # sorted by time: the latest wins
        if r["scenario"] == "lifecycle":
            runs[(r["app"], f"lifecycle-{r['quit']}", r["settings"])] = r
    return runs


def events(run: dict | None, ev: str) -> list[dict]:
    return [e for e in (run or {}).get("events", []) if e.get("ev") == ev]


def fmt(v, unit: str = "", digits: int = 0) -> str:
    if v is None:
        return "–"
    return f"{v:,.{digits}f}{unit}"


def verdict(ok: bool | None) -> str:
    return {True: "**pass**", False: "**FAIL**", None: "not run"}[ok]


class Report:
    def __init__(self, app: str, runs: dict, platform: str, date: str):
        self.app, self.runs, self.platform, self.date = app, runs, platform, date
        self.rows: list[tuple[str, str, str, str]] = []
        self.notes: list[str] = []

    def get(self, scenario: str, settings: str = "default", app: str | None = None) -> dict | None:
        return self.runs.get((app or self.app, scenario, settings))

    def row(self, measure: str, threshold: str, result: str, ok: bool | None) -> None:
        self.rows.append((measure, threshold, result, verdict(ok)))

    def build(self) -> None:
        ui = self.get("ui")
        # Diff open
        warm = [e["ms"] for e in events(ui, "diffOpen") if not e.get("cold")]
        cold = [e["ms"] for e in events(ui, "diffOpen") if e.get("cold")]
        self.row("Open a 5,000-line diff (warm)", "< 300 ms",
                 f"median {fmt(statistics.median(warm) if warm else None, ' ms')}, max {fmt(max(warm) if warm else None, ' ms')} "
                 f"(cold {fmt(cold[0] if cold else None, ' ms')})",
                 (max(warm) < 300) if warm else None)
        # Scrolling
        for kind, label in (("diffScroll", "Scroll that diff"), ("fileScroll", "Scroll the 5 MB file")):
            runs = events(ui, kind)
            last = runs[-1] if runs else None
            self.row(label, "≥ 50 fps, no stalls (frames > 50 ms)",
                     " · ".join(f"run {e['run'] + 1}: {e['fps']:.0f} fps, {e['stalls']} stalls, max frame {e['maxFrameMs']:.0f} ms"
                                for e in runs) or "–",
                     (last["fps"] >= 50 and last["stalls"] == 0) if last else None)
        if events(ui, "diffScroll") and events(ui, "diffScroll")[0]["stalls"]:
            self.notes.append("Scroll verdicts use the second run; the first includes Monaco's first rendering of each region.")
        files = [e["ms"] for e in events(ui, "fileOpen") if not e.get("cold")]
        self.row("Open the 5 MB file (warm)", "< 1 s",
                 f"median {fmt(statistics.median(files) if files else None, ' ms')}, max {fmt(max(files) if files else None, ' ms')}",
                 (max(files) < 1000) if files else None)
        # Echo
        echo = {e["label"]: e for e in events(ui, "echo")}
        idle = echo.get("idle shell")
        self.row("Keystroke to echo in a terminal tab", "< 30 ms",
                 f"idle shell: median {fmt(idle and idle['median'], ' ms', 1)}, p95 {fmt(idle and idle['p95'], ' ms', 1)}"
                 + (f"; tui-load: median {fmt(echo['one tui-load']['median'], ' ms', 1)}, p95 {fmt(echo['one tui-load']['p95'], ' ms', 1)}"
                    if "one tui-load" in echo else ""),
                 all(e["p95"] < 30 and e["timeouts"] == 0 for e in (idle, echo.get("one tui-load")) if e) if idle else None)
        self.load_row()
        self.dump_row()
        self.cycle_row()
        self.lifecycle_row()
        self.coldstart_row()
        self.memory_rows()

    def load_row(self) -> None:
        load = self.get("load")
        vs = self.get("load", "matched", "vscode")
        if not load:
            self.row("Four agent TUIs + 50 MB dump", "intact, responsive, dump ≤ VS Code", "–", None)
            return
        integ = events(load, "integrity")
        intact = bool(integ) and all(e["ok"] for e in integ)
        echo = {e["label"]: e for e in events(load, "echo")}
        under = echo.get("agent tab under load")
        hidden = echo.get("hidden agent tab during dump")
        ours = (load.get("dump") or {}).get("elapsedMs")
        theirs = (vs or {}).get("dump", {}) and vs["dump"].get("elapsedMs")
        responsive = under is not None and under["p95"] < 30 and under["timeouts"] == 0
        no_slower = (ours <= theirs * 1.05) if ours and theirs else None
        # Can't pass without the VS Code comparison, but can fail without it.
        ok = False if not (intact and responsive) else no_slower
        self.row("Four agent TUIs + 50 MB dump in a fifth tab",
                 "nothing lost or garbled, other tabs responsive, dump no slower than VS Code",
                 f"{len(integ)} checks {'all intact' if intact else 'NOT ALL INTACT'}; echo in an agent tab: median "
                 f"{fmt(under and under['median'], ' ms', 1)}, p95 {fmt(under and under['p95'], ' ms', 1)}; hidden tab during dump: "
                 f"median {fmt(hidden and hidden.get('median'), ' ms', 1)}; dump {fmt(ours, ' ms')} vs VS Code {fmt(theirs, ' ms')}",
                 ok)
        if not vs:
            self.notes.append("No VS Code load run yet: the 50 MB dump time isn't compared.")

    def dump_row(self) -> None:
        d = self.get("dump")
        vs = self.get("dump", "matched", "vscode")
        if not d:
            self.row("Dump 250 MB ×3 into one tab", "memory flat; each dump no slower than VS Code", "–", None)
            return
        parts, ok = [], True
        integ = {e["what"]: e["ok"] for e in events(d, "integrity")}
        for kind, a in d.get("dumps", {}).items():
            base = a.get("MBat50") or 0
            flat = a["growthSecondHalfMB"] is not None and a["growthSecondHalfMB"] <= max(FLAT_MB, FLAT_FRACTION * base)
            theirs = ((vs or {}).get("dumps") or {}).get(kind, {}).get("elapsedMs")
            faster = (a["elapsedMs"] <= theirs * 1.05) if theirs else None
            intact = integ.get(f"dump-{kind}")
            ok = ok and flat and (faster is not False) and intact is not False
            parts.append(f"{kind}: {a['elapsedMs'] / 1000:.1f} s vs VS Code {fmt(theirs and theirs / 1000, ' s', 1)}; memory "
                         f"{fmt(a['MBat10'], ' MB')} → {fmt(a['MBat50'], ' MB')} → {fmt(a['MBend'], ' MB')} "
                         f"(second half moves {fmt(a['growthSecondHalfMB'], ' MB', 1)}, {'flat' if flat else 'NOT FLAT'}); "
                         f"{'intact' if intact else 'NOT INTACT' if intact is False else 'unchecked'}")
        self.row("Dump 250 MB ×3 into one tab (lines, long lines, combining + emoji)",
                 "memory flat once scrollback is full; each dump no slower than VS Code", "<br>".join(parts),
                 ok if vs else None)
        self.notes.append(f"\"Flat\" means the dump's second half moves less than {FLAT_MB:.0f} MB or {FLAT_FRACTION:.0%} "
                          "of the app's memory, whichever is larger. Judge the curves in the raw results too.")

    def cycle_row(self) -> None:
        c = self.get("cycle")
        if not c:
            self.row("Hide and show tabs under the four-TUI load", "no blank or garbled tabs, no memory creep", "–", None)
            return
        done = (events(c, "cycleDone") or [{}])[0]
        integ = events(c, "integrity")
        intact = bool(integ) and all(e["ok"] for e in integ)
        slope = c.get("memorySlopeMBPerMin")
        losses = done.get("contextLosses")
        ok = intact and losses == 0 and slope is not None and slope < 1.0
        self.row("Hide and show terminal tabs repeatedly during the four-TUI load",
                 "no blank or garbled terminals; memory doesn't creep",
                 f"{done.get('n', '–')} tab switches, {losses} WebGL context losses, TUIs {'intact' if intact else 'NOT INTACT'}, "
                 f"memory trend {fmt(slope, ' MB/min', 2)}", ok)
        self.notes.append("Window minimize and restore isn't scripted yet; check it by hand during the cycle run. "
                          "\"No creep\" is a memory trend under 1 MB/min after the first minute.")

    def lifecycle_row(self) -> None:
        results, lefts = [], []
        for q in ("term", "kill"):
            r = self.get(f"lifecycle-{q}")
            if r:
                lefts.append(len(r["closedTab"]["aliveAfterClose"]) + len(r["aliveAfterQuit"]))
                results.append(f"{'quit' if q == 'term' else 'killed (crash)'}: {lefts[-1]} processes left")
        self.row("Resize, close tab, quit (and crash)", "child processes always exit", "; ".join(results) or "–",
                 all(n == 0 for n in lefts) if lefts else None)

    def coldstart_row(self) -> None:
        c = self.get("coldstart")
        vs = self.get("coldstart", "matched", "vscode")
        cs = (c or {}).get("coldStart", {})
        self.row("Cold start to usable window", "< 1.5 s",
                 f"first {fmt(cs.get('first'), ' ms')}, then median {fmt(cs.get('medianRest'), ' ms')}"
                 + (f" (VS Code: first {fmt(vs['coldStart']['first'], ' ms')}, then {fmt(vs['coldStart']['medianRest'], ' ms')})"
                    if vs else ""),
                 (cs["medianRest"] < 1500 and cs["first"] < 1500) if cs.get("medianRest") else None)

    def memory_rows(self) -> None:
        for scenario, label, factor, rule in (("idle", "Memory, idle", 0.5, "≤ half of VS Code's"),
                                             ("load", "Memory, under load", 1.0, "≤ VS Code's")):
            ours = (self.get(scenario) or {}).get("memory", {})
            for settings in ("matched", "default"):
                vs = (self.get(scenario, settings, "vscode") or {}).get("memory", {})
                a, b = ours.get("medianMB"), vs.get("medianMB")
                ok = (a <= factor * b) if a and b else None
                self.row(f"{label} ({'matched settings' if settings == 'matched' else 'out of the box'})", rule,
                         f"{fmt(a, ' MB')} vs VS Code {fmt(b, ' MB')}" + (f" ({a / b:.0%})" if a and b else ""), ok)

    def method_notes(self) -> None:
        for (app, scenario, settings), r in sorted(self.runs.items()):
            if app not in (self.app, "vscode"):
                continue
            names = sorted({u["name"] for smp in r.get("samples", []) for u in smp.get("unreadable", [])})
            if names:
                self.notes.append(f"**Memory incomplete** in {app} {scenario} ({settings}): couldn't read "
                                  f"{', '.join(names)}, so that run undercounts.")
        pinned = next((r.get("pinned", {}) for (app, _, _), r in self.runs.items() if app == self.app), {})
        if pinned.get("sizeSource"):
            self.notes.append(f"Terminal size {pinned['cols']}×{pinned['rows']} in both apps: VS Code's terminal size can't be "
                              f"set, so Gako is pinned to what VS Code's terminals get on this machine ({pinned['sizeSource']}).")
        self.notes.append("Keystroke to echo runs from xterm.js's input to the render showing the echo; it leaves out the "
                          "browser's key dispatch and the last compositor frame. VS Code has no equivalent timing.")
        self.notes.append("VS Code's cold start is measured to its first task starting, which waits for the extension host; "
                          "it's an upper bound for its usable window, not the same moment as Gako's.")
        if self.platform == "macos" and self.app == "tauri":
            self.notes.append("WebKit rounds `performance.now()` to whole milliseconds.")

    def markdown(self) -> str:
        self.method_notes()
        meta = next((r for (app, _, _), r in self.runs.items() if app == self.app), {})
        v = meta.get("versions", {})
        lines = [
            f"# Phase 0 results: {self.app} on {self.platform}, {self.date}",
            "",
            "Generated by `bench/measure/report.py` from the raw runs in `bench/out/runs/`. Thresholds and the",
            "decision rule are in [PLAN.md](../../docs/PLAN.md).",
            "",
            "| Measure | Pass | Result | |",
            "|---|---|---|---|",
            *[f"| {m} | {t} | {r} | {o} |" for m, t, r, o in self.rows],
            "",
        ]
        if self.notes:
            lines += ["## Notes", "", *[f"- {n}" for n in self.notes], ""]
        lines += ["## Settings and versions", "",
                  f"- Pinned: {json.dumps(meta.get('pinned', {}))}",
                  f"- Memory metric: `{v.get('metric')}` per process, summed over the app's process tree "
                  "(see `bench/measure/proctree.py`)",
                  f"- Settle {meta.get('settle')} s, then {meta.get('window')} s of samples (median reported)"]
        flow = next((e.get("hello", {}).get("flow") for r in self.runs.values() if r["app"] == self.app
                     for e in r.get("events", []) if e.get("ev") == "connected"), None)
        if flow:
            lines.append(f"- Flow control: high-water {flow['high'] // 1024} KB, low-water {flow['low'] // 1024} KB, "
                         f"PTY read chunk {flow['chunk'] // 1024} KB")
        ua = next((e.get("ua") for r in self.runs.values() if r["app"] == self.app
                   for e in r.get("events", []) if e.get("ev") == "connected"), None)
        if ua:
            lines.append(f"- Web view: `{ua}`")
        for k, val in sorted(v.items()):
            if k != "metric":
                lines.append(f"- {k}: {val}")
        vs = next((r for (app, s, _), r in self.runs.items() if app == "vscode"), None)
        if vs and self.app != "vscode":
            lines += [f"- VS Code {vs['versions'].get('vscode')}; settings per run in its `result.json`"]
        lines += ["", "## Runs", "", *[f"- `{r['runId']}`" for (app, _, _), r in sorted(self.runs.items()) if app == self.app], ""]
        return "\n".join(lines)


def vscode_markdown(runs: dict, platform: str, date: str) -> str:
    lines = [f"# Phase 0 baseline: VS Code on {platform}, {date}", "",
             "The same scenarios in VS Code on the same machine, measured with the same script.", "",
             "| Run | Settings | Result |", "|---|---|---|"]
    for (app, scenario, settings), r in sorted(runs.items()):
        if app != "vscode":
            continue
        if scenario in ("idle", "load"):
            m = r.get("memory", {})
            res = f"memory median {fmt(m.get('medianMB'), ' MB')} (min {fmt(m.get('minMB'), ' MB')}, max {fmt(m.get('maxMB'), ' MB')})"
            if scenario == "load":
                res += f"; 50 MB dump {fmt((r.get('dump') or {}).get('elapsedMs'), ' ms')}"
                sizes = {f"{t['cols']}x{t['rows']}" for t in r.get("tui") or [] if t}
                res += f"; terminal size seen by the agents: {', '.join(sorted(sizes)) or '–'}"
        elif scenario == "dump":
            res = "<br>".join(f"{k}: {a['elapsedMs'] / 1000:.1f} s; memory {fmt(a['MBat10'], ' MB')} → {fmt(a['MBat50'], ' MB')} → "
                              f"{fmt(a['MBend'], ' MB')}" for k, a in r.get("dumps", {}).items())
        elif scenario == "coldstart":
            res = f"to the first task starting: {', '.join(f'{x:.0f}' for x in r.get('coldStartMs', []))} ms"
        else:
            continue
        lines.append(f"| {scenario} | {settings} | {res} |")
    any_run = next((r for (app, _, _), r in runs.items() if app == "vscode"), None)
    if any_run:
        lines += ["", "## Settings", "", "Your own `settings.json`, plus these for automation (both runs):", "",
                  "```json", json.dumps({k: v for k, v in any_run.get("vscodeSettings", {}).items()
                                         if k in VSCODE_AUTOMATION}, indent=2), "```", "",
                  "Matched runs also pin:", "", "```json", json.dumps(VSCODE_MATCHED, indent=2), "```", "",
                  f"Versions: {json.dumps(any_run['versions'])}"]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--platform", default=PLATFORM)
    args = ap.parse_args()
    runs = load_runs(args.platform, args.date)
    if not runs:
        raise SystemExit(f"no runs for {args.platform} on {args.date}")
    RESULTS.mkdir(exist_ok=True)
    for app in sorted({a for a, _, _ in runs}):
        path = RESULTS / f"{args.platform}-{app}-{args.date}.md"
        if app == "vscode":
            path.write_text(vscode_markdown(runs, args.platform, args.date))
        else:
            rep = Report(app, runs, args.platform, args.date)
            rep.build()
            path.write_text(rep.markdown())
        print(path)


if __name__ == "__main__":
    main()
