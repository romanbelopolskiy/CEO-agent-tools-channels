# CEO Agent Tools Channels

This repository contains the MCP/SSE bridge between Claude Code agents and Telegram.

## Required agent/MCP contract

- Agents connect to this bridge only through MCP/SSE.
- Agents do not connect to Telegram directly.
- Agents do not read, store, print, request, or commit bot tokens.
- Agents send Telegram replies only through bridge MCP tools.
- The bridge owns Telegram polling, access control, delivery, media handling, transcription handoff, permission forwarding, and live status messages.
- Documentation must describe the bridge contract only; do not include private deployment procedure or personal operating habits.

## Privacy rule

Committed content must not contain real secrets, bot tokens, API keys, user IDs, chat IDs, private hostnames, internal URLs, personal contacts, customer/company names, raw chats, logs, transcripts, or private absolute paths.

Use placeholders such as `<BOT_NAME>`, `<SSE_BASE_URL>`, `<USER_ID>`, `<CHAT_ID>`, `<LOCAL_CONFIG_PATH>`, and `<TELEGRAM_BOT_TOKEN>`.

## Validation before commit

```bash
npm run build
python3 -m py_compile cleanup-agent-orphans.py
zsh -n claude-tg
bash -n status-watcher.sh
./cleanup-agent-orphans.py --json
```
