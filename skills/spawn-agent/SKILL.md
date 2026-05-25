# Skill: spawn-agent

Create a new Claude Code agent connected to this shared Telegram/MCP/SSE bridge.

This skill is intentionally generic. Never write real bot tokens, user IDs, chat IDs, private hostnames, internal URLs, or absolute private paths into committed files.

## Inputs required

Ask for these if they are missing:

1. `<AGENT_NAME>` — short lowercase slug.
2. Purpose — what the agent should do.
3. Main responsibilities — brief bullet list.
4. Bot credential — provided out-of-band and stored only in local private config.
5. Authorized operator identity — stored only in local private access config.

Do not ask the user to paste secrets into a public issue, PR, or committed document.

## Creation workflow

### 1. Register bot locally

Add the bot to the local private bridge registry. Example shape only:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

The registry path is deployment-specific and must stay outside git.

### 2. Create local access policy

Create a local private access file for the bot. Example shape only:

```json
{
  "policy": "allowlist",
  "allowedUsers": ["<AUTHORIZED_USER_ID>"],
  "pendingPairs": {}
}
```

Do not commit this file.

### 3. Create agent workspace

Use deployment-specific workspace paths. In docs and templates, refer to them as:

```text
<AGENT_DIR>/
  CLAUDE.md
  .mcp.json
  .claude-tg.json
  .claude/settings.json
  logs/
  state/
```

### 4. Create `.mcp.json`

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

### 5. Create `.claude-tg.json`

```json
{
  "model": "<MODEL_ALIAS>",
  "effort": "<EFFORT_LEVEL>",
  "telegramTelemetry": "status"
}
```

### 6. Create `CLAUDE.md`

Template:

```markdown
# <AGENT_NAME> Agent

You are the `<AGENT_NAME>` agent. Your purpose is: <PURPOSE>.

## Communication

- You receive user messages through the shared bridge.
- You reply only through the bridge MCP tools.
- Do not connect to Telegram directly.
- Do not read, store, or print bot tokens.
- Keep user-facing messages concise and useful.

## Responsibilities

<RESPONSIBILITIES>

## Boundaries

- Use only approved tools for this workspace.
- Do not expose secrets, credentials, private IDs, raw chats, or internal paths.
- If a task requires a new paid service or external infrastructure, ask for approval first.

## Logging

If local logging is enabled, log only concise summaries. Do not log raw private messages, credentials, tokens, or full transcripts.
```

### 7. Launch agent

```bash
tmux new-session -d -s <BOT_NAME> 'claude-tg --bot <BOT_NAME>'
```

The tmux session name should match `<BOT_NAME>`.

### 8. Restart bridge if registry changed

After changing the local bot registry, restart the bridge process in the deployment-specific way, then verify:

```bash
curl -sf <SSE_BASE_URL>/health
```

### 9. Verify

- Bot registry contains `<BOT_NAME>` locally.
- Access policy allows the intended operator only.
- Agent `.mcp.json` points to `<SSE_BASE_URL>/sse?bot=<BOT_NAME>`.
- tmux session exists with name `<BOT_NAME>`.
- Bridge health endpoint is OK.
- Agent receives a test message and replies through the bridge.
- No secrets or private deployment values were committed.

## Security checklist

Before committing any agent template or documentation, confirm there are no:

- real bot tokens;
- API keys;
- user IDs or chat IDs;
- private hostnames or internal URLs;
- personal emails or phone numbers;
- customer/company/person names from private operations;
- raw logs, raw chats, screenshots, transcripts;
- absolute private paths.
