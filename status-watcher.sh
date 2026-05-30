#!/bin/bash
# Background watcher: tails a script(1) log file, renders the TUI via pyte
# (VT100 emulator), and POSTs the last ~80 lines (including scrollback) to the SSE server's
# /status-feed endpoint roughly every second. Launched by claude-tg, killed
# on exit.
#
# Usage: status-watcher.sh <logfile> <bot_name> <chat_id> [sse_host]

set -u
LOGFILE="$1"
BOT_NAME="$2"
CHAT_ID="$3"
SSE_HOST="${4:-http://127.0.0.1:3200}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RENDER="$SCRIPT_DIR/render-tui.py"
# Use system Python by default so agent-local virtualenvs do not shadow renderer deps.
PYTHON_BIN="${STATUS_WATCHER_PYTHON:-/usr/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi
WATCHER_LOG="${STATUS_WATCHER_LOG:-/tmp/status-watcher-${BOT_NAME}.log}"
RENDER_ERROR_SENT=0
# Change-detection state: signature (size:mtime) of the logfile at the last
# successful render+POST. While the log is unchanged (agent idle at prompt) we
# skip BOTH the python render and the curl POST, eliminating the idle-time
# fork/exec storm that was pinning %system CPU on the 4-vCPU VM. Render+POST
# resume the instant the log advances, so verbose live status keeps no lag.
LAST_SIG=""
# Self-terminate guard: claude-tg rm's the per-PID logfile when the agent exits.
# Exit cleanly after the log has been missing for several ticks so a
# watcher-only relaunch (or a normal agent restart) never leaves orphan watchers
# spinning on a deleted logfile.
MISSING=0

post_status() {
  local text="$1"
  local json_text
  json_text=$("$PYTHON_BIN" -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$text")
  curl -sS -X POST "$SSE_HOST/status-feed" \
    -H 'Content-Type: application/json' \
    -d "{\"botName\":\"$BOT_NAME\",\"chatId\":$CHAT_ID,\"text\":$json_text}" \
    -o /dev/null --max-time 3 2>/dev/null || true
}

while true; do
  sleep 3

  if [ ! -f "$LOGFILE" ]; then
    MISSING=$((MISSING + 1))
    if [ "$MISSING" -ge 5 ]; then
      printf '%s logfile gone for %s ticks, exiting watcher\n' "$(date -Is)" "$MISSING" >> "$WATCHER_LOG"
      exit 0
    fi
    continue
  fi
  MISSING=0
  [ -s "$LOGFILE" ] || continue

  # Skip render+POST when the log has not advanced since the last successful
  # render. size:mtime catches both appends (size) and in-place rewrites (mtime).
  SIG="$(stat -c '%s:%Y' "$LOGFILE" 2>/dev/null || echo "")"
  if [ -n "$SIG" ] && [ "$SIG" = "$LAST_SIG" ]; then
    continue
  fi

  ERRFILE=$(mktemp "/tmp/status-render-${BOT_NAME}.XXXXXX")
  RAW=$("$PYTHON_BIN" "$RENDER" "$LOGFILE" 80 2>"$ERRFILE")
  RC=$?
  if [[ $RC -ne 0 ]]; then
    ERR=$(tail -20 "$ERRFILE" | tr -d '\r')
    printf '%s render failed rc=%s: %s\n' "$(date -Is)" "$RC" "$ERR" >> "$WATCHER_LOG"
    if [[ "$RENDER_ERROR_SENT" -eq 0 ]]; then
      post_status "⚠️ Live status renderer failed for $BOT_NAME. Install/check python dependency: python3-pyte.\n$ERR"
      RENDER_ERROR_SENT=1
    fi
    rm -f "$ERRFILE"
    continue
  fi
  rm -f "$ERRFILE"
  RENDER_ERROR_SENT=0
  [ -z "$RAW" ] && continue

  post_status "$RAW"
  # Mark this log signature as rendered only after a successful render+POST, so
  # a transient render failure or empty frame retries on the next tick.
  LAST_SIG="$SIG"
done
