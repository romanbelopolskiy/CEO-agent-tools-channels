# Changelog

All notable changes to this project are documented here.

---

## v3.1.6 — 2026-04-16

### Added

- **New Telegram commands: `/status` and `/compact`** — send `status`, `/status`, `статус` to forward `/status` to the CLI; send `compact`, `/compact`, `компакт` to forward `/compact`. Both work by sending `Escape` first (to bring the CLI back to the prompt if mid-inference), then typing the command with `Enter` after a 150ms delay.
- **Generalized command registry** — refactored the old `tryHandleStop` function into `tryHandleCommand`, driven by a `COMMANDS` registry (`CommandDef[]`). Each entry declares its triggers, the sequence of `tmux send-keys` batches, and the reply string. Adding new commands requires only a new entry in the array.

### Changed

- `tryHandleStop` removed; all call sites now use `await tryHandleCommand(...)`.
- `/stop` reply shortened to `🛑 Interrupted` (was `🛑 Interrupted (ESC sent to claude via tmux)`).

---

## v3.1.5 — 2026-04-17

### Fixed

- **Strip Claude Code startup banner from live status stream** — logo art, model/effort line (`"Opus 4.7 with max effort · Claude Max"`), experimental channel warning, `(ctrl+b…)` footer hint, and tip lines no longer leak into Telegram status messages. Extended `is_chrome()` in `render-tui.py` with seven new patterns: logo box-drawing char check, `"Claude Code v"` prefix, `"Welcome to "` prefix, `"Listening for channel messages"` substring, `"Experimental · inbound"` substring, `"Restart Claude Code without"` substring, `"(ctrl+"` line prefix, `"⎿  Tip:"`/`"Tip:"` stripped-prefix, and a `MODEL_BANNER_RE` regex for model/effort header lines. (`render-tui.py`)

---

## v3.1.4 — 2026-04-16

### Changed

- **Simpler status lifecycle — output streams between user message and agent reply, freezes on reply.** Replaced the auto-create (v3.1.2) and cooldown (v3.1.3) heuristics with an explicit state machine: per `(botName, chatId)`, state is `"streaming"` while a task is active and `"replied"` once the agent sends its reply (via `send_telegram_message`) or `/stop` is handled. The `/status-feed` handler now simply skips updates when no active task exists — no auto-create, no cooldown check. (`src/index.ts`, `src/status-messages.ts`, `src/constants.ts`)

### Removed

- `findLastFinishedTaskByChatId` from `StatusManager` (added in v3.1.3, no longer used).
- `STATUS_AUTOCREATE_COOLDOWN_MS` constant (added in v3.1.3, no longer used).

---

## v3.1.3 — 2026-04-16

### Fixed

- **No more phantom status messages after the agent replies** — brief cooldown suppresses the TUI flush tail. When the most-recently-finished task for a `(chatId, botName)` pair ended within the last 10 seconds, `/status-feed` skips auto-creating a new task. This kills the spurious post-reply status message caused by the TUI flushing its final frame ~1s after `finishTask`, while preserving the intermediate-reply resume flow (which kicks in once the cooldown expires). (`src/status-messages.ts`, `src/index.ts`, `src/constants.ts`)

---

## [3.1.2] — 2026-04-17

### Fixed

- **Status streaming resumes automatically after intermediate replies** — agents often send mid-turn messages ("Принято…", "Запускаю субагентов", etc.) via `send_telegram_message`, which finalizes the live status task. Subsequent `status-watcher.sh` POSTs to `/status-feed` found no active task (because `findTaskByChatId` correctly skips finalized tasks) and were silently dropped, causing streaming to stop for the rest of the turn. Fixed: the `/status-feed` POST handler now auto-creates a new task on the fly whenever no active task exists for the `(chatId, botName)` pair, immediately spawning a fresh Telegram status message and resuming streaming. This was a latent bug first exposed by the v3.1.1 `botName`-scoped lookup that removed the cross-bot leak which had accidentally masked it. (`src/index.ts`)

---

## [3.1.1] — 2026-04-16

### Fixed

- **Cross-bot status leak via `findTaskByChatId`** — when the same user (`chat_id`) had active tasks in multiple bots simultaneously, `/status-feed` updates from bot A could land on a task belonging to bot B (whichever had the most-recent `startedAt`). Fixed by adding a `botName` parameter to `findTaskByChatId(chatId, botName)` so lookups are scoped to the correct bot. All four call sites updated: `/status-feed` handler, `tryHandleStop`, `send_telegram_message` finalizer, and the tool-started emitter in `tools.ts`. (`src/status-messages.ts`, `src/index.ts`, `src/tools.ts`)

---

## [3.1.0] — 2026-04-16

### Added

- **`/stop` via tmux send-keys** — `/stop` (also: `stop`, `стоп`, `esc`, `escape`) now sends the ESC key directly to the claude CLI via `tmux send-keys -t <botName> Escape`. This genuinely cancels the current turn. Requires `claude-tg` to run inside a tmux session named after the bot. (`src/index.ts`)
- **Stale status-watcher cleanup on startup** — `claude-tg` now runs `pkill -f "status-watcher.sh.*<botName>"` at startup to kill orphaned watchers from crashed previous sessions. Previously, orphan watchers with PPID=1 kept POSTing to `/status-feed`, competing with the new watcher. (`claude-tg`)
- **`render-tui.py`** — new utility: renders a `script(1)` TTY capture to plain text via pyte VT100 emulation, strips chrome decorations, and normalizes the progress counter so the hash stays stable. Used by the live status pipeline.

### Changed

- **`tryHandleStop` now finalizes the task and stops typing** — signature changed to `(botName, chatId, text)`. On successful ESC send: calls `statusManager.finishTask(taskId)` so the interrupted task is marked done, and calls `stopTyping(botName, chatId)` so the Telegram "typing…" indicator stops immediately. (`src/index.ts`)
- **`StatusManager.findTaskByChatId` returns most-recent active task** — previously returned the first (insertion-order) active task for a chat. After `/stop`, the old unfinalized task would intercept status updates for the next task. Now scans all active tasks for the chat and returns the one with the highest `startedAt`. (`src/status-messages.ts`)
- **`renderStatus` tool_started template** — now shows `🔧 Tool: \`<name>\`` with an optional preview truncated to 300 chars, replacing the previous generic "Вызываю tool" card. (`src/status-messages.ts`)
- **Logger and constants extracted** — `log()`/`debug()` moved to `src/logger.ts`; magic numbers (`TYPING_INTERVAL_MS`, `TYPING_TIMEOUT_MS`, `STATUS_DEBOUNCE_MS`, etc.) moved to `src/constants.ts`. Both `index.ts` and `status-messages.ts` now import from these shared modules. (`src/index.ts`, `src/status-messages.ts`)

### Fixed

- **Removed PID-file sidecar from `claude-tg`** — the old `PID_WRITER` loop used `pgrep` to find the claude grandchild PID and wrote it to `/tmp/claude-tg-<bot>.pid` so the stop handler could send SIGINT. No longer needed: `/stop` uses tmux. The PID file, its creation loop, and the trap cleanup are removed. (`claude-tg`)
- **`render-tui.py` chrome detection for current claude CLI** — `is_chrome()` previously required both `"bypass permissions"` AND `"shift+tab"` to match the footer. Newer claude CLI versions dropped `shift+tab`, so the detector stopped filtering chrome lines, leaving decorative dash rules and `❯` prompts in the output. Fixed: match `"bypass permissions"` alone. Also changed filter from trailing-only `pop()` loop to a full-pass list comprehension, catching chrome lines anywhere in the buffer. (`render-tui.py`)
- **`render-tui.py` stable hash for idle-thinking** — the progress line `✳ Tinkering… (1m 19s · ↓ 2.3k tokens · thinking with max effort)` has a live timer and token counter that changed every second, causing the hash to change each tick and the Telegram status message to be edited continuously ("endless flicker"). Fixed: `COUNTER_RE` pattern normalizes the parenthetical to `(…)` before hashing, so the hash stays stable during idle reasoning. (`render-tui.py`)

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
