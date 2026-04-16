#!/bin/bash
# Background watcher: tails a script(1) log file, renders the TUI via pyte
# (VT100 emulator), and POSTs the last ~25 visible lines to the SSE server's
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

PREV_HASH=""

while true; do
  sleep 1

  [ -f "$LOGFILE" ] || continue
  [ -s "$LOGFILE" ] || continue

  RAW=$(python3 "$RENDER" "$LOGFILE" 25 2>/dev/null)
  [ -z "$RAW" ] && continue

  HASH=$(echo "$RAW" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$RAW" | md5 2>/dev/null)
  [ "$HASH" = "$PREV_HASH" ] && continue
  PREV_HASH="$HASH"

  JSON_TEXT=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$RAW")

  curl -sS -X POST "$SSE_HOST/status-feed" \
    -H 'Content-Type: application/json' \
    -d "{\"botName\":\"$BOT_NAME\",\"chatId\":$CHAT_ID,\"text\":$JSON_TEXT}" \
    -o /dev/null --max-time 3 2>/dev/null || true
done
