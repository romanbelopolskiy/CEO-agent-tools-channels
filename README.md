# CEO Agent Tools Channels

Shared MCP/SSE bridge for connecting isolated Claude Code agent sessions to Telegram chats.

This repository intentionally keeps documentation generic. Do not commit real bot tokens, API keys, user IDs, chat IDs, private hostnames, local absolute paths, customer names, or personal contact details.

## Current runtime model

```text
Telegram user
  -> Telegram Bot API
  -> one shared bridge process
  -> MCP/SSE channel for the matching bot name
  -> one Claude Code session per agent
  -> responses go back through bridge tools only
```

Key rules:

- One long-lived bridge process polls all configured Telegram bots.
- Each Claude Code agent connects to the bridge over MCP/SSE with a `bot=<BOT_NAME>` selector.
- Claude agents must not connect to Telegram directly and must not store bot tokens in their own workspaces.
- The bridge owns Telegram delivery, pairing/allowlist checks, permission forwarding, live status messages, and media download/transcription handoff.
- Agent sessions run separately, usually inside a tmux session whose name matches the bot name.
- If an idle agent has no active SSE connection, the bridge can wake the matching tmux session through the local start-agent hook, then deliver the first message after the session reconnects.

## What changed in the hardened bridge flow

### Duplicate-session prevention

`claude-tg` now protects each bot with a local lock. Before launching a new agent session it runs `cleanup-agent-orphans.py` for the current agent directory.

The cleanup script only targets confirmed stale bridge-backed Claude processes:

- orphaned `script(1)` wrappers adopted by PID 1;
- or, during prestart, an already-running bridge Claude process for the exact same agent directory.

It should not kill unrelated tmux sessions, unrelated Claude processes, or headless system workers.

### Wake-on-message

When Telegram receives a valid user message but no matching SSE session exists:

1. The bridge checks aliases for the configured bot name.
2. If a stale/disconnected tmux session exists for that bot, it is replaced.
3. The bridge calls the configured local start-agent hook.
4. It waits for the SSE session to reconnect.
5. Only then does it forward the Telegram message into Claude Code.
6. If the agent cannot be started, the bridge sends a short user-facing failure message and logs the reason.

### Voice/audio handling

Voice and audio messages are downloaded by the bridge and saved to a temporary local file. If speech-to-text is configured in the bridge environment, the bridge sends the transcript plus the local audio path into the agent message. If transcription is unavailable, the agent receives the saved file path and a clear “transcript unavailable” marker.

Do not implement speech-to-text inside individual agents. Keep media handling centralized in the bridge.

### Live status rendering

`status-watcher.sh` uses the system Python by default so agent-local virtual environments do not break renderer dependencies. It renders the Claude TUI log into compact plain text and posts it to the bridge status endpoint.

## Safe configuration examples

All sensitive values below are placeholders. Replace them only in local private config files, never in committed docs.

### Bot registry

The bridge reads a local bot registry file. Shape:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

Rules:

- Keep this file outside git.
- Never paste real tokens into commits, issues, screenshots, logs, or docs.
- If several bot names intentionally share the same token, the bridge deduplicates polling.

### Agent MCP config

Each agent workspace needs an MCP/SSE entry pointing to the shared bridge:

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

Use a private local base URL in real deployments. Do not commit private hostnames, internal IPs, or chat-specific URLs.

### Per-agent defaults

Optional per-agent launcher defaults:

```json
{
  "model": "<CLAUDE_MODEL_ALIAS>",
  "effort": "<EFFORT_LEVEL>",
  "telegramTelemetry": "status"
}
```

`telegramTelemetry` values:

- `silent` — no live status message;
- `status` — compact live status updates;
- `verbose` — more detailed status updates for debugging.

## Operating the bridge

### Build

```bash
npm ci --ignore-scripts
npm run build
```

### Start bridge in development

```bash
TRANSPORT=sse PORT=<PORT> node dist/index.js
```

Health check:

```bash
curl -sf <SSE_BASE_URL>/health
```

### Start an agent session

From an agent workspace:

```bash
tmux new-session -d -s <BOT_NAME> 'claude-tg --bot <BOT_NAME>'
```

The tmux session name should match `<BOT_NAME>` so bridge commands and lifecycle scripts can find the right process.

### Restart decision table

- Edited `src/**/*.ts`: run `npm run build`, then restart the bridge process.
- Edited `claude-tg`: restart affected agent tmux sessions.
- Edited `status-watcher.sh` or `render-tui.py`: restart affected agent tmux sessions.
- Changed local bot registry: restart the bridge process.
- Changed one agent’s instructions/config: restart only that agent session.

### Cleanup check

Dry-run orphan detection:

```bash
./cleanup-agent-orphans.py --json
```

Prestart cleanup for one agent directory:

```bash
./cleanup-agent-orphans.py --agent-dir <AGENT_DIR> --prestart --kill --json
```

Use `--kill` only when the matching process is confirmed stale or belongs to the same agent being relaunched.

## Security and privacy checklist before commit

Run this before every push:

```bash
git status --short
git diff --cached --stat
npm run build
python3 -m py_compile cleanup-agent-orphans.py
zsh -n claude-tg
bash -n status-watcher.sh
```

Then scan staged content for:

- real Telegram bot tokens;
- provider API keys;
- bearer tokens or session cookies;
- real user IDs, chat IDs, phone numbers, emails;
- private hostnames, internal IPs, private URLs;
- customer/company/person names from private operations;
- absolute paths that reveal private machine/user layout;
- raw chat exports, transcripts, logs, or screenshots.

If a value is needed for documentation, replace it with `<PLACEHOLDER>`.

## Repository hygiene

- Commit source files and generic docs only.
- Do not commit local registry files, `.env`, auth folders, generated caches, runtime logs, or temporary media.
- Keep `dist/` generated by `npm run build`; the source of truth is `src/`.
- Keep operational instructions generic enough for a clean deployment without exposing a real deployment.
