# Architecture and Operations Guide

This guide describes the bridge architecture without exposing any private deployment values. Use placeholders in committed examples. Real tokens, user IDs, chat IDs, hostnames, internal URLs, and absolute private paths belong only in local runtime config.

## Components

```text
Telegram Bot API
  <-> shared Node bridge process
      - polls configured bots
      - enforces access rules
      - exposes MCP/SSE endpoints
      - forwards messages into matching Claude sessions
      - sends replies/status back to Telegram
  <-> Claude Code agent sessions
      - one session per bot identity
      - launched by claude-tg
      - connected by MCP/SSE
```

## File layout

```text
src/index.ts             Bridge entrypoint: HTTP server, polling, routing, wake-on-message, media enrichment
src/telegram.ts          Telegram API client wrapper
src/tools.ts             MCP tools exposed to agents
src/status-messages.ts   Live Telegram status lifecycle
src/config.ts            Local bot registry loader
src/access.ts            Pairing and allowlist logic
src/permissions.ts       Permission forwarding
src/channel.ts           MCP channel emitters
src/logger.ts            Shared logging
src/constants.ts         Runtime constants
claude-tg                Agent launcher
cleanup-agent-orphans.py Duplicate/orphan process cleanup
status-watcher.sh        Live TUI renderer poster
render-tui.py            TUI-to-text renderer
```

## Configuration model

### Bot registry

Local private file, not committed:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

The bridge loads bot identities from this registry. Multiple names may share the same token when intentional; polling is deduplicated by token.

### Agent MCP config

Each agent has an MCP config like:

```json
{
  "mcpServers": {
    "ceo-agent-tools-channels": {
      "type": "sse",
      "url": "<SSE_BASE_URL>/sse?bot=<BOT_NAME>"
    }
  }
}
```

Agents only see bridge tools. They do not receive bot tokens and must not implement direct Telegram clients.

### Per-agent launcher defaults

Optional local file in the agent workspace:

```json
{
  "model": "<MODEL_ALIAS>",
  "effort": "<EFFORT_LEVEL>",
  "telegramTelemetry": "status"
}
```

## Message routing

1. Bridge receives Telegram update from a configured bot polling loop.
2. Access policy is checked for the sender/chat.
3. Media is downloaded by the bridge if present.
4. Voice/audio is transcribed by the bridge if a speech-to-text provider is configured.
5. Bridge resolves aliases for the bot name.
6. If a matching SSE session exists, the message is emitted into that session.
7. If no matching session exists, wake-on-message starts or replaces the matching tmux session, waits for SSE reconnect, then emits the message.
8. If wake fails, the bridge sends a short failure message and logs diagnostics.

## Reply routing

Agents reply through MCP tools exposed by the bridge. The bridge performs actual Telegram API calls. This preserves the isolation boundary:

- token handling stays in the bridge;
- agents do not store or read bot tokens;
- Telegram parse-mode fallback is centralized;
- live status messages are finalized when a user-facing reply is sent.

## Wake-on-message lifecycle

Wake-on-message exists so idle/stopped agent sessions can still receive the first Telegram message reliably.

Algorithm:

1. Check if any SSE session matches `<BOT_NAME>` or its aliases.
2. If absent, check for a stale tmux session with the same name.
3. Replace disconnected tmux if needed.
4. Call the local start-agent hook with `<BOT_NAME>`.
5. Verify that tmux session exists.
6. Poll for SSE reconnect until timeout.
7. Deliver the original Telegram message only after reconnect.
8. Fail loudly in logs if the session cannot be started.

## Duplicate-session protection

`claude-tg` uses a per-bot lock. A second launcher for the same bot refuses to create another live Claude session.

Before launch, `cleanup-agent-orphans.py` removes stale bridge-backed Claude processes only when they match safe criteria:

- orphaned wrapper adopted by PID 1; or
- same exact agent directory during prestart cleanup.

Do not broaden cleanup patterns without deterministic checks. Avoid killing by loose bot-name substring alone.

## Media and transcription boundary

The bridge may download Telegram media and may call an externally configured speech-to-text provider. The resulting agent message contains either:

```text
[voice transcript; audio saved to <LOCAL_TEMP_FILE>]
<transcript text>
```

or:

```text
[voice saved to <LOCAL_TEMP_FILE>; transcript unavailable]
```

Agents should treat the transcript as user input. Agents should not call Telegram media APIs directly.

## Live status boundary

`status-watcher.sh` follows a local Claude TUI log, renders it through `render-tui.py`, and posts compact text to the bridge status endpoint.

Operational rules:

- Use system Python by default for renderer dependencies.
- Restart the affected agent session after changing watcher or renderer scripts.
- Do not expose raw logs to Telegram; status output should stay compact and user-safe.

## Restart matrix

| Change | Build | Restart bridge | Restart agent session |
|---|---:|---:|---:|
| `src/**/*.ts` | yes | yes | no |
| local bot registry | no | yes | only new/changed agents |
| `claude-tg` | no | no | yes |
| `cleanup-agent-orphans.py` | no | no | yes before next launch |
| `status-watcher.sh` / `render-tui.py` | no | no | yes |
| one agent instruction/config | no | no | that agent only |

## Validation commands

```bash
npm run build
python3 -m py_compile cleanup-agent-orphans.py
zsh -n claude-tg
bash -n status-watcher.sh
./cleanup-agent-orphans.py --json
```

After deployment, verify privately in the target environment:

```bash
curl -sf <SSE_BASE_URL>/health
```

## Documentation sanitization rules

Committed docs must not contain:

- real bot tokens or API keys;
- token variable names tied to a private deployment;
- real Telegram user IDs or chat IDs;
- emails, phone numbers, private handles;
- private hostnames, internal IPs, or deployment URLs;
- private absolute paths;
- private customer, employee, or company names;
- raw logs, raw message history, or transcripts.

Use placeholders such as `<BOT_NAME>`, `<SSE_BASE_URL>`, `<AGENT_DIR>`, `<LOCAL_CONFIG_PATH>`, and `<TELEGRAM_BOT_TOKEN>`.
