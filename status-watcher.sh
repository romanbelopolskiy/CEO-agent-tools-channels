#!/bin/bash
# Background watcher: tails a script(1) log file, strips ANSI codes,
# takes the last 15 lines, and POSTs to the SSE server's /status-feed
# endpoint every 2 seconds. Launched by claude-tg, killed on exit.
#
# Usage: status-watcher.sh <logfile> <bot_name> <chat_id> [sse_host]

set -u
LOGFILE="$1"
BOT_NAME="$2"
CHAT_ID="$3"
SSE_HOST="${4:-http://127.0.0.1:3200}"

PREV_HASH=""

while true; do
  sleep 2

  [ -f "$LOGFILE" ] || continue

  # Read last 15 lines, strip ANSI escape sequences and carriage returns
  RAW=$(tail -15 "$LOGFILE" 2>/dev/null | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | tr -d '\r' | sed 's/[[:cntrl:]]//g')

  # Skip if empty or unchanged
  HASH=$(echo "$RAW" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$RAW" | md5 2>/dev/null)
  [ "$HASH" = "$PREV_HASH" ] && continue
  PREV_HASH="$HASH"

  # Escape for JSON
  JSON_TEXT=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$RAW")

  curl -sS -X POST "$SSE_HOST/status-feed" \
    -H 'Content-Type: application/json' \
    -d "{\"botName\":\"$BOT_NAME\",\"chatId\":$CHAT_ID,\"text\":$JSON_TEXT}" \
    -o /dev/null --max-time 3 2>/dev/null || true
done
