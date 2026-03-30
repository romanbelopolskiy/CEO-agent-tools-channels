# Changelog

All notable changes to this project are documented here.

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
