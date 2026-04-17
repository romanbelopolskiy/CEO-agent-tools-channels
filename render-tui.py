#!/usr/bin/env python3
"""Render a script(1) capture of a TTY UI to plain text via VT100 emulation."""
import os
import re
import sys

import pyte


HRULE_RE = re.compile(r"^─+$")
USER_MSG_RE = re.compile(r"←\s+ceo-agent-tools-channels:")
COUNTER_RE = re.compile(r"\(\d+m\s*\d*s\s*·[^)]*\)")
MODEL_BANNER_RE = re.compile(r"^(Opus|Sonnet|Haiku)\s+\d+\.\d+\s+(with|·)")
LOGO_CHARS = set("▐▛█▜▌▝▘ ")


def is_chrome(line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    if HRULE_RE.match(s):
        return True
    if s.startswith("❯"):
        return True
    if "bypass permissions" in s:
        return True
    # Startup banner: logo art (lines whose non-whitespace chars are only box-drawing)
    if s and set(s) - LOGO_CHARS == set():
        return True
    # Startup banner: version header
    if s.startswith("Claude Code v"):
        return True
    # Startup banner: welcome line
    if s.startswith("Welcome to "):
        return True
    # Startup banner: channel listener warning
    if "Listening for channel messages" in s:
        return True
    # Startup banner: dangerously-load-development-channels warning
    if "Experimental · inbound" in s:
        return True
    if "Restart Claude Code without" in s:
        return True
    # Startup banner: keyboard hint footer (standalone line starting with "(ctrl+")
    if s.startswith("(ctrl+"):
        return True
    # Tip hints — the ⎿ prefix is followed by a non-breaking space before "Tip:"
    # Match "⎿ …Tip:" in any spacing variant, or bare "Tip:" lines
    if s.startswith("⎿") and "Tip:" in s:
        return True
    if s.startswith("Tip:"):
        return True
    # Model/effort banner: "Opus 4.7 with max effort · Claude Max"
    if MODEL_BANNER_RE.match(s):
        return True
    return False


TAIL_WINDOW = 256 * 1024  # 256 KB — O(1) per tick regardless of log size


def render(path: str, max_lines: int = 25) -> str:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > TAIL_WINDOW:
            f.seek(size - TAIL_WINDOW)
        data = f.read()

    width = 200
    longest = 0
    for m in re.finditer(rb"(?:\xe2\x94\x80)+", data):
        n = (m.end() - m.start()) // 3
        if n > longest:
            longest = n
    if longest >= 60:
        width = longest

    screen = pyte.Screen(width, 100)
    stream = pyte.ByteStream(screen)
    stream.feed(data)

    lines = [line.rstrip() for line in screen.display]

    lines = [l for l in lines if not is_chrome(l)]
    lines = [COUNTER_RE.sub("(…)", l) for l in lines]

    last_msg = -1
    for i, line in enumerate(lines):
        if USER_MSG_RE.search(line):
            last_msg = i
    if last_msg >= 0:
        lines = lines[last_msg + 1 :]

    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()

    return "\n".join(lines[-max_lines:])


if __name__ == "__main__":
    path = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    sys.stdout.write(render(path, n))
