# Changelog

All notable changes to this project are documented here.

---

## [3.0.0] — 2026-04-16

### Added

#### Live status messages (spec: ceo-tools-telegram-live-status-tz.md)
- **One editable status message per task** — when a user sends a task to an agent, the bot creates a single status message in Telegram and edits it on every runtime event instead of spamming new messages.
- **`editMessageText` in telegram.ts** — new Telegram API method wired into the existing client.
- **`src/status-messages.ts`** — new module with:
  - `StatusManager` class: task lifecycle (create / update / finalize), in-memory state per taskId.
  - `renderStatus()` function: event → human-readable status card (emoji + agent + model + step + details).
  - Edit throttling: 1s debounce, text dedupe, forced flush on terminal events.
  - GC for finished tasks (>10 min auto-cleanup).
  - `loadTelemetryConfig()`: reads `~/agents/<agent>/.claude-tg.json` for per-agent verbosity.
- **Three verbosity modes** configurable via `telegramTelemetry` in `.claude-tg.json`:
  - `silent` — no status message.
  - `status` (default) — key state changes only (started, thinking, command, tool, error, finished).
  - `verbose` — all events including tool finished, command exit codes, thinking updates.
- **Supported events**: task_started, thinking_started/updated/finished, command_started/finished, tool_started/finished, permission_request, api_error, retrying, task_finished, task_failed.
- **Tool call tracking** — any MCP tool call with a `chat_id` arg emits `tool_started` to the status message.
- **Auto-finalize** — when agent calls `send_telegram_message`, the status message is finalized with `✅ Готово`.

### Per-agent config

New optional file `~/agents/<agent>/.claude-tg.json`:

```json
{
  "model": "opus",
  "effort": "max",
  "telegramTelemetry": "status"
}
```

---

## [2.0.0] — 2026-04-09

### Breaking changes

- **SSE transport mode** — the server now runs as a shared SSE service (`TRANSPORT=sse PORT=3200`). One instance serves all Claude Code sessions instead of spawning per-session processes via stdio. Stdio mode is still supported for backward compatibility.
- **MCP config format changed** — agent `.mcp.json` now uses `"type": "sse"` + `"url"` instead of `"command"` + `"args"`.
- **`claude-tg` no longer generates temp MCP configs** — it auto-detects the bot name from the directory and uses the agent's own `.mcp.json`.

### Added

#### SSE server with per-bot routing
- `GET /sse?bot=NAME` — each agent connects with its bot name, receives only its messages
- `GET /sse` (no filter) — receives messages from all bots
- `GET /health` — JSON status: connected sessions, bot list, active typing indicators
- `POST /messages?sessionId=xxx` — MCP message forwarding

#### Typing indicator
When a Telegram message is routed to an agent, the server sends `sendChatAction("typing")` every 4 seconds. Stops when the agent replies via `send_telegram_message` or after 2-minute timeout.

#### Token deduplication
Bots sharing the same Telegram token (e.g., `post`/`smm` are aliases) are polled only once. Messages are delivered to all sessions registered for any alias. Prevents Telegram 409 Conflict errors.

#### `claude-tg` auto-detect
- `--bot NAME` flag for non-interactive use
- Auto-detects bot name from current directory (`~/agents/devops/` → bot `devops`)
- Health check before launch — fails fast if SSE server is down
- Writes `.mcp.json` with SSE URL if missing

#### launchd service
- `com.ceo-agent-tools.channels-sse.plist` — auto-start + keepalive for macOS

### Changed

- `telegram.ts` — added `sendChatAction()` method
- `tools.ts` — `registerTools()` accepts `onMessageSent` callback (stops typing on reply)
- `index.ts` — full rewrite: HTTP server, session management, shared polling, routing

---

## [1.3.0] — 2026-03-31

### Added

#### Group chat support

Agents can now be added to Telegram groups with proper mention-awareness.

**`TELEGRAM_GROUP_POLICY` env var** controls group behavior:

| Value | Behavior |
|-------|----------|
| `mention-only` | Only respond when `@mentioned` or replied to (default) |
| `allowlist` | Only respond to users in the access list |
| `open` | Respond to all messages (like DM behavior) |

**Rich group metadata** is now included in every channel notification:
- `chat_type` — `"private"` \| `"group"` \| `"supergroup"` \| `"channel"`
- `chat_title` — group name
- `is_group` — `"true"` for group chats
- `bot_mentioned` — `"true"` when bot was `@mentioned` in the message
- `is_reply_to_bot` — `"true"` when message is a reply to the bot

This metadata is available to agents via `CLAUDE.md` channel event context and can be used for agent-level filtering.

**Mention detection** works via:
- `@botusername` in message text (case-insensitive)
- Telegram `mention` entity
- `text_mention` entity (bots without usernames)
- Reply to previous bot message

**Auto-strip mention:** `@botusername` is automatically removed from message text before forwarding — agent sees the clean command.

**`message_id`** is now included in channel metadata for potential future reply-to-message support.

---

## [1.2.0] — 2026-03-30

### Fixed

#### Photos without caption were silently ignored
When a user sent a photo without a caption, the channel event had empty `content`. Claude Code discards channel messages with empty content, so the agent never received the photo.

**Fix:** after photo/document processing, if `text` is still empty, a fallback `[message received - no text content]` is set — ensuring the channel message always reaches the agent.

### Added

#### Persistent debug log file (`MCP_LOG_FILE`)
Set `MCP_LOG_FILE=/path/to/file.log` in the MCP server's env to write all log output to a file in addition to stderr. Useful for diagnosing delivery issues after the fact:
```json
{
  "env": {
    "TELEGRAM_BOT_NAME": "devops",
    "DEBUG": "1",
    "MCP_LOG_FILE": "/tmp/devops-mcp.log"
  }
}
```

---

## [Unreleased] — 2026-03-29

### Added

#### Direct allowlist authorization (bypass pairing)
Instead of going through the interactive pairing flow, you can now authorize users by writing the access file directly:
```bash
cat > ~/.claude/telegram-access-{botname}.json << 'EOF'
{
  "policy": "allowlist",
  "allowedUsers": [YOUR_TELEGRAM_USER_ID],
  "pendingPairs": {}
}
EOF
```
Useful when creating multiple agents at once — no need to send a message and confirm a pairing code for each bot.

#### Media support (photos and documents)
The server now handles incoming photos and documents, not just text messages:
- **Photos** — downloaded to `/tmp/tg-photo-{file_unique_id}.jpg`
- **Documents** — downloaded to `/tmp/tg-doc-{file_unique_id}-{filename}`
- The channel event includes the local file path, MIME type, and caption
- Agent can read and analyze the file using Claude Code's `Read` tool

#### `skills/spawn-agent` — automated agent creation
A complete skill file (`skills/spawn-agent/SKILL.md`) that lets Claude Code create a new agent end-to-end from a single prompt:
1. Register bot token in `~/.claude/telegram-bots.json`
2. Create access file with direct allowlist
3. Set up agent directory: `~/agents/{name}/logs/`, `state/`, `.claude/skills/`
4. Generate `.claude/settings.json` with `bypassPermissions` and all tool permissions
5. Write a task-specific `CLAUDE.md`
6. Create the MCP config at `/tmp/claude-tg-mcp.{name}.json`
7. Launch a tmux session
8. Update the architecture doc
9. Send a completion report to Telegram

Usage: copy the skill into your workspace's `.claude/skills/` folder, then ask Claude Code to create a new agent by describing what it should do.

---

## [1.0.0] — 2026-03-27

### Initial release

Fork of the official [Anthropic Telegram Channel Plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), rewritten in TypeScript/Node.js with multi-agent support as the primary design goal.

#### Core changes vs official plugin

- **Per-bot token registry** — `~/.claude/telegram-bots.json` instead of a single global token. Run N bots in parallel, each with its own token and access list.
- **`claude-tg` launcher** — interactive bot selector / creator. Replaces the `/telegram:configure` slash command. Supports adding new bots on the fly.
- **Node.js / pure fetch** — rewritten from Bun/Grammy to Node.js 18+ with zero Telegram dependencies. `fetch` only.
- **Per-bot access lists** — `~/.claude/telegram-access-{name}.json` instead of session-scoped pairing. Authorizations survive Claude Code restarts.
- **Process cleanup** — exits cleanly when Claude Code closes stdin or sends SIGINT/SIGTERM/SIGHUP. No zombie MCP processes.
- **Debug mode** — `DEBUG=1` env enables verbose stderr logging across all modules.
- **Permission relay** — Claude Code permission requests forwarded to Telegram with approve/deny buttons.
