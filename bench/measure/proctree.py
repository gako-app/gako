# Gako: a workspace app for reviewing and supervising coding agents across many repositories.
# Copyright (C) 2026 João Sena Ribeiro
#
# This program is free software: you can redistribute it and/or modify it under the terms of the
# GNU Affero General Public License as published by the Free Software Foundation, either version 3
# of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
# even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License along with this program.
# If not, see <https://www.gnu.org/licenses/>.

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
            if not psutil.pid_exists(p.pid):
                raise psutil.NoSuchProcess(p.pid)
            raise psutil.AccessDenied(p.pid)
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
    # Processes in the tree whose memory couldn't be read. Never dropped silently: on Linux,
    # Chromium's sandboxed processes (renderers, zygotes) are unreadable except by root.
    unreadable: list[dict]
    # User plus system CPU seconds used so far by the processes in the tree.
    cpu: float = 0.0

    def as_dict(self) -> dict:
        return {"t": self.t, "total": self.total, "byRole": self.by_role, "n": len(self.procs), "procs": self.procs,
                "unreadable": self.unreadable, "cpu": self.cpu}


def sample(root: int, t: float) -> Sample:
    procs, unreadable = [], []
    by_role: dict[str, int] = {}
    total = 0
    cpu = 0.0
    for p in tree(root):
        try:
            name = p.name()
            times = p.cpu_times()
            cpu += times.user + times.system
        except (psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
        except psutil.AccessDenied:
            pass
        try:
            mem = unique_memory(p)
        except (psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
        except psutil.AccessDenied:
            try:
                rss = p.memory_info().rss
            except psutil.Error:
                rss = None
            unreadable.append({"pid": p.pid, "name": name, "rss": rss})
            continue
        r = role(p, name)
        total += mem
        by_role[r] = by_role.get(r, 0) + mem
        procs.append({"pid": p.pid, "name": name, "role": r, "mem": mem})
    return Sample(t=t, total=total, by_role=by_role, procs=procs, unreadable=unreadable, cpu=cpu)


def serve() -> None:
    """`python proctree.py --serve`, run as root by the runner on Linux: reads a root pid and a
    timestamp per line from stdin, answers with one sample as a JSON line."""
    for line in sys.stdin:
        pid, t = line.split()
        print(json.dumps(sample(int(pid), float(t)).as_dict()), flush=True)


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


class Spawned:
    """The parts of subprocess.Popen the runner uses, for a process started by `spawn`."""

    def __init__(self, pid: int):
        self.pid = pid
        self.returncode: int | None = None

    def poll(self) -> int | None:
        if self.returncode is None:
            import os
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.returncode = os.waitstatus_to_exitcode(status)
        return self.returncode

    def send_signal(self, sig: int) -> None:
        import os
        if self.poll() is None:
            os.kill(self.pid, sig)

    def terminate(self) -> None:
        import signal
        self.send_signal(signal.SIGTERM)

    def kill(self) -> None:
        import signal
        self.send_signal(signal.SIGKILL)


def spawn(argv: list[str], env: dict[str, str], cwd: Path, output: Path):
    """Starts an app the way macOS starts apps: responsible for itself, not for whoever ran this
    script. Otherwise a terminal (or the tool running this script) stays the "responsible process"
    of the app and of its WebKit helpers, and the tree walk above can't find them. Elsewhere this
    is plain subprocess.Popen."""
    if not MACOS:
        return subprocess.Popen(argv, env=env, cwd=cwd, stdout=open(output, "w"), stderr=subprocess.STDOUT)
    import os
    vp = ctypes.c_void_p
    attr, actions, pid = vp(), vp(), ctypes.c_int()
    _lib.posix_spawnattr_init(ctypes.byref(attr))
    _lib.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1)
    _lib.posix_spawn_file_actions_init(ctypes.byref(actions))
    _lib.posix_spawn_file_actions_addchdir_np(ctypes.byref(actions), str(cwd).encode())
    _lib.posix_spawn_file_actions_addopen(ctypes.byref(actions), 1, str(output).encode(),
                                          os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    _lib.posix_spawn_file_actions_adddup2(ctypes.byref(actions), 1, 2)
    c_argv = (ctypes.c_char_p * (len(argv) + 1))(*[a.encode() for a in argv], None)
    env_list = [f"{k}={v}".encode() for k, v in env.items()]
    c_env = (ctypes.c_char_p * (len(env_list) + 1))(*env_list, None)
    err = _lib.posix_spawn(ctypes.byref(pid), argv[0].encode(), ctypes.byref(actions), ctypes.byref(attr), c_argv, c_env)
    _lib.posix_spawn_file_actions_destroy(ctypes.byref(actions))
    _lib.posix_spawnattr_destroy(ctypes.byref(attr))
    if err:
        raise OSError(err, f"posix_spawn {argv[0]}: {os.strerror(err)}")
    return Spawned(pid.value)


if __name__ == "__main__" and sys.argv[1:] == ["--serve"]:
    serve()
