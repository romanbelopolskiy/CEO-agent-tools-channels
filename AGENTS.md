# CEO Agent Tools Channels

## Repository instructions

This repository is the shared Telegram/MCP/SSE bridge for Claude Code agents.

Hard boundaries:

- Claude agents connect to this bridge through MCP/SSE only.
- Claude agents must not connect to Telegram directly.
- Bot tokens and access lists live in local private config, never in git.
- Documentation must use placeholders for private deployment values.
- Do not commit secrets, API keys, bot tokens, user IDs, chat IDs, private hostnames, internal URLs, customer names, employee names, raw logs, raw chats, or local absolute paths.
- Cost-impacting or external-service changes require explicit owner approval before implementation.

Before changing behavior:

1. Read `README.md` and `ARCHITECTURE.md`.
2. Keep the bridge/agent isolation boundary intact.
3. Update docs when runtime behavior changes.
4. Run validation:

```bash
npm run build
python3 -m py_compile cleanup-agent-orphans.py
zsh -n claude-tg
bash -n status-watcher.sh
./cleanup-agent-orphans.py --json
```

Before every commit:

1. Stage only files related to the change.
2. Scan staged content for secrets and private identifiers.
3. Replace real values with placeholders like `<BOT_NAME>`, `<SSE_BASE_URL>`, `<AGENT_DIR>`, `<LOCAL_CONFIG_PATH>`, `<TELEGRAM_BOT_TOKEN>`.
4. Do not include generated caches, local registries, `.env`, runtime logs, auth/session folders, or temporary media.
