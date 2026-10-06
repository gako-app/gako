#!/usr/bin/env python3
"""What an agent tells its terminal, from a recording made with GAKO_RECORD_DIR.

Lists, with their times, the signals a terminal could read an agent's state from: title changes
(OSC 0/1/2), bells, desktop notifications (OSC 9, 99 and 777), prompt marks (OSC 133), progress
(OSC 9;4) and anything else in an OSC, next to what was typed (Enter, Escape, Ctrl+C).

    python3 bench/measure/agent_signals.py rec/1791320000-1-claude.jsonl [...]
"""

import json
import re
import sys

OSC = re.compile(r"\x1b\](\d+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)")

KIND = {"0": "title", "1": "icon title", "2": "title", "9": "notify (OSC 9)", "99": "notify (OSC 99)",
        "777": "notify (OSC 777)", "133": "prompt mark", "7": "cwd", "8": "link", "1337": "iTerm2",
        "10": "fg colour query", "11": "bg colour query", "4": "palette", "52": "clipboard"}


def describe_input(text: str) -> str | None:
    keys = {"\r": "Enter", "\x1b": "Escape", "\x03": "Ctrl+C", "\x04": "Ctrl+D"}
    if text in keys:
        return keys[text]
    if text.startswith("\x1b["):
        return None  # cursor keys, focus reports, terminal replies
    shown = text.replace("\r", "⏎")
    return f"typed {shown[:40]!r}" if shown.strip() else None


def signals(path: str):
    with open(path, encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            ms = rec["ms"]
            if "in" in rec:
                what = describe_input(rec["in"])
                if what:
                    yield ms, "input", what
                continue
            out = rec["out"]
            for m in OSC.finditer(out):
                code, arg = m.group(1), m.group(2) or ""
                if code in ("8", "4", "10", "11"):
                    continue  # links and colours say nothing about state
                if code == "9" and arg.startswith("4;"):
                    yield ms, "progress (OSC 9;4)", arg[2:]
                else:
                    yield ms, KIND.get(code, f"OSC {code}"), arg[:120]
            stripped = OSC.sub("", out)
            for _ in re.finditer("\x07", stripped):
                yield ms, "bell", ""


def main() -> None:
    for path in sys.argv[1:]:
        print(f"== {path}")
        last = None
        repeats = 0
        for ms, kind, arg in signals(path):
            # Spinners rewrite the title many times a second: collapse runs of the same kind.
            key = (kind, re.sub(r"^\S+\s", "", arg) if kind == "title" else arg)
            if key == last:
                repeats += 1
                continue
            if repeats:
                print(f"{'':>9}   (and {repeats} more like it)")
            repeats = 0
            last = key
            print(f"{ms / 1000:>8.1f}s  {kind:<20} {arg}")
        if repeats:
            print(f"{'':>9}   (and {repeats} more like it)")


if __name__ == "__main__":
    main()
