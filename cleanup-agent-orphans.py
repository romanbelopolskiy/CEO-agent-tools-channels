#!/usr/bin/env python3
"""Detect/clean duplicate Claude Telegram agent processes.

Safety model:
- A tmux-backed current agent has a shell parent (claude-tg) inside its tmux pane.
- Stale duplicates seen on agents-central are `script -q -c claude ... server:ceo-agent-tools-channels`
  wrappers whose PPID is 1 after the old tmux/shell died, with a child Claude still
  running in `/srv/agents/claude-agents/<agent>`.
- This script only kills confirmed orphan wrappers (PPID=1) by default.
- With --agent-dir --prestart, it also kills any already-running Telegram-bridge Claude
  for that exact agent directory before a new launcher starts, preventing two live
  instances of the same bot.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

BRIDGE_MARKER = "server:ceo-agent-tools-channels"
AGENTS_ROOT = Path("/srv/agents/claude-agents").resolve()


def _read_text(path: str) -> str:
    try:
        return Path(path).read_text(errors="ignore")
    except Exception:
        return ""


def _cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "ignore").strip()
    except Exception:
        return ""


def _ppid(pid: int) -> int | None:
    data = _read_text(f"/proc/{pid}/status")
    for line in data.splitlines():
        if line.startswith("PPid:"):
            try:
                return int(line.split()[1])
            except Exception:
                return None
    return None


def _cwd(pid: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except Exception:
        return None


def _children(pid: int) -> list[int]:
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True, check=False).stdout
    return [int(x) for x in out.split() if x.isdigit()]


def _is_script_wrapper(pid: int) -> bool:
    cmd = _cmdline(pid)
    return cmd.startswith("script -q -c claude ") and BRIDGE_MARKER in cmd


def _is_bridge_claude(pid: int) -> bool:
    cmd = _cmdline(pid)
    return cmd.startswith("claude ") and BRIDGE_MARKER in cmd


def _agent_from_cwd(cwd: str | None) -> str | None:
    if not cwd:
        return None
    try:
        p = Path(cwd).resolve()
    except Exception:
        return None
    try:
        rel = p.relative_to(AGENTS_ROOT)
    except Exception:
        return None
    return rel.parts[0] if rel.parts else None


def iter_wrappers() -> list[dict]:
    out = subprocess.run(["pgrep", "-f", f"^script -q -c claude .*{BRIDGE_MARKER}"], capture_output=True, text=True, check=False).stdout
    rows = []
    for raw in out.split():
        if not raw.isdigit():
            continue
        pid = int(raw)
        if not _is_script_wrapper(pid):
            continue
        child_claudes = [c for c in _children(pid) if _is_bridge_claude(c)]
        child = child_claudes[0] if child_claudes else None
        cwd = _cwd(child) if child else None
        rows.append({
            "wrapper_pid": pid,
            "wrapper_ppid": _ppid(pid),
            "child_pid": child,
            "cwd": cwd,
            "agent": _agent_from_cwd(cwd),
            "cmd": _cmdline(pid),
        })
    return rows


def terminate_pids(pids: list[int], dry_run: bool = False) -> None:
    pids = [p for p in dict.fromkeys(pids) if p and Path(f"/proc/{p}").exists()]
    if not pids:
        return
    if dry_run:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
            except PermissionError:
                pass
        time.sleep(1.0 if sig == signal.SIGTERM else 0.2)
        if not any(Path(f"/proc/{pid}").exists() for pid in pids):
            break


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent-dir", help="Exact agent directory to protect/clean")
    ap.add_argument("--prestart", action="store_true", help="Before launching a new agent, kill any existing bridge Claude for --agent-dir")
    ap.add_argument("--kill", action="store_true", help="Actually terminate matches; otherwise only report")
    ap.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = ap.parse_args()

    target_dir = str(Path(args.agent_dir).resolve()) if args.agent_dir else None
    matches = []
    for row in iter_wrappers():
        reason = None
        if args.prestart and target_dir and row.get("cwd") and str(Path(row["cwd"]).resolve()) == target_dir:
            reason = "prestart_same_agent_dir"
        elif row.get("wrapper_ppid") == 1:
            reason = "orphan_wrapper_ppid_1"
        if reason:
            row["reason"] = reason
            matches.append(row)

    killed = []
    for row in matches:
        pids = [row.get("child_pid"), row.get("wrapper_pid")]
        killed.extend([p for p in pids if p])
        terminate_pids([p for p in pids if p], dry_run=not args.kill)

    result = {"ok": True, "matched": matches, "killed_pids": sorted(set(killed)) if args.kill else []}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        for row in matches:
            action = "killed" if args.kill else "would_kill"
            print(f"{action}: agent={row.get('agent')} wrapper={row.get('wrapper_pid')} child={row.get('child_pid')} reason={row.get('reason')} cwd={row.get('cwd')}")
        if not matches:
            print("no duplicate/orphan Claude Telegram agent processes found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
