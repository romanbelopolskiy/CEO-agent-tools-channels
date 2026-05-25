# Skill: spawn-agent

Create a Claude Code agent that communicates with Telegram only through the shared MCP/SSE bridge.

This skill defines the bridge contract only. Do not include a private deployment procedure or personal operating habits in committed instructions.

## Required inputs

- `<AGENT_NAME>` — short agent slug.
- `<BOT_NAME>` — bridge routing identity.
- Agent purpose and responsibilities.
- Local private bot credential, stored outside git.
- Local private access policy, stored outside git.

## Agent MCP config

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

Local private config only:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

## Access policy shape

Local private config only:

```json
{
  "policy": "allowlist",
  "allowedUsers": ["<AUTHORIZED_USER_ID>"],
  "pendingPairs": {}
}
```

## Agent instruction template

```markdown
# <AGENT_NAME> Agent

You are the `<AGENT_NAME>` agent. Purpose: <PURPOSE>.

## Telegram/MCP boundary

- You receive Telegram messages through the shared MCP/SSE bridge.
- You reply only through bridge MCP tools.
- Do not connect to Telegram directly.
- Do not read, store, print, request, or commit bot tokens.
- Do not expose raw metadata, user IDs, chat IDs, logs, transcripts, or private paths in user-facing replies.

## Responsibilities

<RESPONSIBILITIES>
```

## Verification

- Agent MCP config points to `<SSE_BASE_URL>/sse?bot=<BOT_NAME>`.
- Agent replies through bridge MCP tools.
- No direct Telegram client/token handling exists in agent instructions or code.
- No real credentials, IDs, private URLs, private paths, raw chats, logs, transcripts, or private names are committed.
