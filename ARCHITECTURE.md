# MCP Bridge Contract

This document defines how Claude Code agents interact with the `ceo-agent-tools-channels` MCP bridge. It is intentionally limited to the agent/MCP boundary.

## Boundary

```text
Claude Code agent
  <-> MCP/SSE bridge (`ceo-agent-tools-channels`)
  <-> Telegram Bot API
```

Agents interact only with the bridge. The bridge interacts with Telegram.

## Agent responsibilities

- Connect to the bridge using MCP/SSE with `bot=<BOT_NAME>`.
- Receive incoming Telegram messages from the bridge as channel messages.
- Reply through bridge MCP tools.
- Treat bridge-provided transcripts and media file references as normal user input.
- Keep replies user-facing; do not expose internal IDs, raw metadata, logs, stack traces, or bridge diagnostics unless explicitly asked for debugging.

## Bridge responsibilities

- Store and use bot credentials in local private config.
- Poll Telegram and route each update to the matching MCP/SSE session.
- Enforce access policy before forwarding user messages to agents.
- Forward permission requests when needed.
- Send agent replies to Telegram.
- Handle Telegram formatting fallback and document/media delivery.
- Download voice/audio/files and pass safe local references to agents.
- Optionally transcribe voice/audio before forwarding the message to the agent.
- Manage live status messages.
- Mirror scheduler-injected tasks to the bot owner's chat (local `POST /inject-mirror`), so the owner sees when an agent picks up cron/registry work.
- Prevent duplicate live sessions for the same bot where supported by the launcher.

## Prohibited for agents

Agents must not:

- connect to Telegram directly;
- store or print bot tokens;
- ask users for bot tokens in normal operation;
- bypass bridge access control;
- implement their own Telegram polling or sending loop;
- send raw private metadata back to users;
- commit local deployment config, logs, transcripts, tokens, IDs, or private paths.

## MCP/SSE config shape

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

## Bot registry shape

The bot registry is local private config and must not be committed:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

## Inbound message contract

The bridge may include:

- message text;
- chat metadata;
- sender metadata;
- reply/mention flags;
- local file path for downloaded media;
- transcript text for voice/audio when transcription is configured;
- marker that transcript is unavailable when transcription fails or is disabled.

Agents should use this data only to complete the user task and route the reply through bridge tools.

## Outbound reply contract

Agents should send concise final replies through the bridge MCP send tool. The bridge owns final Telegram delivery and error handling.

## Local control endpoints

The bridge exposes localhost-only HTTP endpoints for trusted same-host processes (never exposed publicly):

- `POST /status-feed` — live CLI status feed for the active task message.
- `POST /inject-mirror` — body `{botName, text, kind?}`. Mirrors a scheduler-injected task to the bot owner's chat with a copy marker. Resolves the owner chat from the bot's local access config, truncates long text, sends as plain text, is fire-and-forget (best-effort), and no-ops on unknown bot / empty text / no resolved chat. Bot tokens never leave the bridge process; callers post only plain text to localhost.
- `GET /health` — liveness and registry snapshot.

## Privacy rule

Repository files must use placeholders only. Do not commit real credentials, real user/chat IDs, private URLs, private hostnames, private paths, raw chats, raw logs, screenshots, transcripts, or private personal/company names.
