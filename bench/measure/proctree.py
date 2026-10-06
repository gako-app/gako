"""Memory of an app's whole process tree, following PLAN.md's "How to measure it".

- Processes are collected by walking the tree from the app's own root process, never by name.
- On macOS, WebKit's web content, GPU and networking processes are XPC services: their parent is
  launchd, not the app, so a plain tree walk misses them. macOS records the app as their
  "responsible process" (what Activity Monitor uses to group them), so the walk also follows that
  link. Names are only used afterwards, to label processes in the breakdown.
- The metric is unique memory (USS) per process via psutil, summed, on Windows and Linux. On macOS
  psutil can't read USS without root (it needs task_for_pid), and not even root may read it for
  Apple's own WebKit processes. There the metric is each process's physical footprint
  (`proc_pid_rusage`, what Activity Monitor's Memory column and `footprint` report), and
  `footprint` itself is run for the same processes as a cross-check.
"""

from __future__ import annotations

import ctypes
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import psutil

MACOS = sys.platform == "darwin"

_responsible = None
if MACOS:
    _lib = ctypes.CDLL(None)
    _responsible = getattr(_lib, "responsibility_get_pid_responsible_for_pid", None)
    if _responsible is not None:
        _responsible.restype = ctypes.c_int
        _responsible.argtypes = [ctypes.c_int]


class _RusageInfoV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size "
        "phys_footprint proc_start_abstime proc_exit_abstime child_user_time child_system_time "
        "child_pkg_idle_wkups child_interrupt_wkups child_pageins child_elapsed_abstime "
        "diskio_bytesread diskio_byteswritten").split()]


_rusage = None
if MACOS:
    _rusage = _lib.proc_pid_rusage
    _rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(_RusageInfoV2)]
    _rusage.restype = ctypes.c_int

METRIC = "phys_footprint" if MACOS else "uss"


def unique_memory(p: psutil.Process) -> int:
    """USS, or the physical footprint on macOS (see the module docstring)."""
    if _rusage is not None:
        info = _RusageInfoV2()
        if _rusage(p.pid, 2, ctypes.byref(info)) != 0:
            raise psutil.NoSuchProcess(p.pid)
        return info.phys_footprint
    return p.memory_full_info().uss


def responsible_pid(pid: int) -> int | None:
    if _responsible is None:
        return None
    r = _responsible(pid)
    return r if r > 0 else None


def tree(root: int) -> list[psutil.Process]:
    """The root, its descendants and (on macOS) every process it is responsible for, recursively."""
    try:
        root_proc = psutil.Process(root)
    except psutil.NoSuchProcess:
        return []
    found: dict[int, psutil.Process] = {root: root_proc}

    def add_with_children(p: psutil.Process) -> None:
        found[p.pid] = p
        try:
            for c in p.children(recursive=True):
                found[c.pid] = c
        except psutil.NoSuchProcess:
            pass

    add_with_children(root_proc)
    if _responsible is not None:
        changed = True
        while changed:
            changed = False
            for p in psutil.process_iter():
                if p.pid in found:
                    continue
                r = responsible_pid(p.pid)
                if r is not None and r in found and r != p.pid:
                    add_with_children(p)
                    changed = True
    return list(found.values())


TERMINAL_CHILDREN = {"zsh", "bash", "sh", "fish", "pwsh", "powershell", "cmd", "tui-load", "conhost",
                     "openconsole", "login"}


def role(p: psutil.Process, name: str) -> str:
    """A label for the breakdown only. Terminal child processes cost the same in every app."""
    base = name.lower().removesuffix(".exe").lstrip("-")
    if base in TERMINAL_CHILDREN:
        return "terminal-children"
    if base.startswith("gako-core"):
        return "gako-core"
    return "app"


@dataclass
class Sample:
    t: float
    total: int
    by_role: dict[str, int]
    procs: list[dict]


def sample(root: int, t: float) -> Sample:
    procs = []
    by_role: dict[str, int] = {}
    total = 0
    for p in tree(root):
        try:
            name = p.name()
            mem = unique_memory(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        r = role(p, name)
        total += mem
        by_role[r] = by_role.get(r, 0) + mem
        procs.append({"pid": p.pid, "name": name, "role": r, "mem": mem})
    return Sample(t=t, total=total, by_role=by_role, procs=procs)


def footprint(pids: list[int]) -> dict | None:
    """macOS only: `footprint` for the same processes, as a cross-check of the USS sum."""
    if not MACOS or not pids:
        return None
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "fp.json"
        args = ["footprint", "--noCategories", "-f", "bytes", "-j", str(out)]
        for pid in pids:
            args += ["-p", str(pid)]
        subprocess.run(args, capture_output=True, timeout=120)
        if not out.exists():
            return None
        data = json.loads(out.read_text())
    return {
        "total": data.get("total footprint"),
        "processes": [{"pid": p["pid"], "name": p["name"], "footprint": p["footprint"]} for p in data.get("processes", [])],
    }
