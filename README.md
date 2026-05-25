# CEO Agent Tools Channels

Shared MCP/SSE bridge that lets Claude Code agents communicate through Telegram without giving agents direct Telegram access.

## Agent-to-MCP contract

Agents must follow this contract when using this MCP bridge:

1. **Connect only through MCP/SSE.**
   - Agent config points to `<SSE_BASE_URL>/sse?bot=<BOT_NAME>`.
   - `<BOT_NAME>` is the routing identity used by the bridge.

2. **Never connect to Telegram directly.**
   - Agents must not create Telegram clients.
   - Agents must not read, store, print, or request bot tokens.
   - All Telegram API calls are performed by the bridge.

3. **Use bridge tools for outbound messages.**
   - User-facing replies must go through the MCP tools exposed by this bridge.
   - The bridge handles Telegram delivery, formatting fallback, document sending, status finalization, and errors.

4. **Treat inbound channel messages as user input.**
   - The bridge emits Telegram messages into the matching agent session.
   - Message metadata may include bot name, chat id, user id, chat type, reply context, media markers, and transcript text.
   - Agents should use metadata only for correct routing/reply behavior and must not expose private IDs in user-facing replies.

5. **Do not bypass bridge access control.**
   - Pairing, allowlists, group policy, and permission forwarding are bridge responsibilities.
   - Agents should not implement their own Telegram authorization layer.

6. **Media is bridge-owned.**
   - The bridge downloads Telegram media and passes local file references to agents.
   - If speech-to-text is configured, the bridge passes a transcript with the message.
   - Agents should not call Telegram media APIs directly.

7. **Live status is bridge-owned.**
   - Status messages are created/updated/finalized by bridge-side status tooling.
   - Agents should send final user-facing replies through the bridge tools, not by editing status messages themselves.

## Minimal MCP config shape

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

## Local private config shape

Bot credentials are local private deployment config, never repository content:

```json
{
  "<BOT_NAME>": { "token": "<TELEGRAM_BOT_TOKEN>" }
}
```

## Repository privacy rule

Committed files must not contain real bot tokens, API keys, user IDs, chat IDs, private hostnames, internal URLs, personal contacts, customer names, raw chats, logs, transcripts, or private absolute paths. Use placeholders such as `<BOT_NAME>`, `<SSE_BASE_URL>`, `<CHAT_ID>`, `<USER_ID>`, and `<TELEGRAM_BOT_TOKEN>`.
