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

  [ -f "$LOGFILE" ] || continue
  [ -s "$LOGFILE" ] || continue

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
done
