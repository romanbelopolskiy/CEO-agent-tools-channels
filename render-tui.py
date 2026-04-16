#!/usr/bin/env python3
"""Render a script(1) capture of a TTY UI to plain text via VT100 emulation."""
import re
import sys

import pyte


HRULE_RE = re.compile(r"^─+$")
USER_MSG_RE = re.compile(r"←\s+ceo-agent-tools-channels:")
COUNTER_RE = re.compile(r"\(\d+m\s*\d*s\s*·[^)]*\)")


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
    return False


def render(path: str, max_lines: int = 25) -> str:
    with open(path, "rb") as f:
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
