# CEO Agent Tools & Channels

> Fork of the official [Anthropic Telegram Channel Plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), extended for multi-agent workflows.

Multi-agent toolkit for startup founders. Manage isolated Claude Code agents through separate Telegram chats — each with its own skills, tools, and personality.

**Author:** Roman Belopolskiy, CEO [4sell.ai](https://4sell.ai)

## What's different from the official plugin

The [official `telegram@claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) plugin stores the bot token globally — one token per machine. This project solves that:

| | Official plugin | This project |
|---|---|---|
| Bot token | Global (one per machine) | Per-bot registry (`~/.claude/telegram-bots.json`) |
| Multiple bots | Not supported | Run N bots in parallel |
| Runtime | Bun | Node.js >= 18 |
| Telegram lib | Grammy | Pure fetch (zero deps) |
| Config | `/telegram:configure` | `claude-tg` launcher with interactive bot selection |
| Isolation | Shared state | Each agent has its own context |
| Process cleanup | Zombie processes on crash | Auto-exit on stdin close / signals |
| Pairing | Per-session | Per-bot persistent access lists |
| Authorization | Pairing flow only | Pairing flow OR direct allowlist file (no interaction) |
| Media support | Text only | Photos and documents (saved to `/tmp/`, path forwarded to agent) |
| Agent creation | Manual | `skills/spawn-agent` — automated full setup |

## Why this exists

Running a startup means juggling SMM, development, analytics, ops — all at once. AI agents help, but managing them through a single Claude Code terminal or a cluttered web UI is painful. Too many context switches, too many wasted tokens.

This project was born out of frustration with managing agents through a single interface. The idea is simple: **one Telegram chat = one agent with its own isolated context**. You text your SMM bot — it writes posts. You text your dev bot — it ships code. No cross-contamination, no token waste, no cognitive overhead.

Built on top of [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code/channels) — a feature that lets external systems push messages into a running Claude Code session.

## How it works

```
You (Telegram)
     │
     ├── @smm_bot        ──►  Claude Code session #1  (CLAUDE.md: SMM skills)
     ├── @dev_bot         ──►  Claude Code session #2  (CLAUDE.md: frontend dev)
     └── @senior_dev_bot  ──►  Claude Code session #3  (CLAUDE.md: architecture + deploy)
```

Under the hood:

```
Telegram Bot API  ◄── long polling ──  MCP server (this project)  ◄── stdio ──►  Claude Code
                  ── send_message ──►                              ── channel ──►
```

1. Each agent runs as a separate Claude Code session with its own `CLAUDE.md`, `.mcp.json`, and `.claude/skills/`
2. Each session connects to its own Telegram bot via this MCP server
3. When you send a message in Telegram, it arrives as a channel event in Claude Code
4. Claude processes it with its configured skills and replies back through Telegram
5. Permission requests (tool approvals) are forwarded to Telegram — approve or deny right from your phone

## Quick start

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, run `/newbot`, and save the token.

### 2. Install

```bash
git clone https://github.com/romanbelopolskiy/CEO-agent-tools-channels.git
cd CEO-agent-tools-channels
npm install
npm run build
```

### 3. Add `claude-tg` to PATH

```bash
ln -sf "$(pwd)/claude-tg" /opt/homebrew/bin/claude-tg
```

### 4. Launch

```bash
claude-tg
```

On first run with no bots configured, it will prompt you:

```
No bots configured. Let's add one.

Bot name (e.g. ceo, support): devops
Bot token (from @BotFather): 123456:ABC-DEF...
Bot 'devops' saved.
Starting Claude Code with bot: devops
```

On subsequent runs:
- **One bot** — auto-selects it
- **Multiple bots** — shows a numbered picker

### 5. Authorize your Telegram account

There are two ways to authorize yourself:

**Option A — Interactive pairing (default)**

1. Send any message to your bot in Telegram
2. The bot replies with a 6-character pairing code
3. In Claude Code, say: `pair code abc123`
4. The bot sends a confirmation: "Bot authorized under name devops"
5. Done — your messages now reach Claude Code

**Option B — Direct allowlist (no pairing required)**

Faster for multi-agent setups where you're creating many bots at once. Bypass the pairing flow by writing the access file directly:

```bash
cat > ~/.claude/telegram-access-{botname}.json << 'EOF'
{
  "policy": "allowlist",
  "allowedUsers": [YOUR_TELEGRAM_USER_ID],
  "pendingPairs": {}
}
EOF
```

Replace `{botname}` with your bot name from the registry (e.g. `devops`, `smm`) and `YOUR_TELEGRAM_USER_ID` with your Telegram user ID.

**Finding your user ID:** send a message to [@userinfobot](https://t.me/userinfobot) — it replies with your ID.

This file is read at startup. No restart needed if the agent isn't running yet — just create the file before launching.

## Bot registry

Bots are stored in `~/.claude/telegram-bots.json`:

```json
{
  "devops": { "token": "123456:ABC..." },
  "smm": { "token": "789012:DEF..." },
  "senior": { "token": "345678:GHI..." }
}
```

Each bot gets its own access list at `~/.claude/telegram-access-{name}.json`.

You can add bots manually to the JSON file or let `claude-tg` prompt you on first run.

## Multi-agent setup

The core use case: run **multiple agents** from separate directories, each with its own Telegram bot, personality, and toolset.

### Directory structure

```
my-agents/
├── smm-bot/
│   ├── CLAUDE.md       ← "You are an SMM manager..."
│   └── .claude/skills/ ← create-post, write-comment, find-accounts
├── dev-bot/
│   ├── CLAUDE.md       ← "You are a frontend developer..."
│   └── .claude/skills/ ← fix-bug, update-page
└── dev-senior/
    ├── CLAUDE.md       ← "You are a senior engineer..."
    └── .claude/skills/ ← refactor, deploy, review-pr
```

### Launch each agent

```bash
# Terminal 1 — SMM agent
cd smm-bot && claude-tg    # select "smm"

# Terminal 2 — Dev agent
cd dev-bot && claude-tg    # select "devops"

# Terminal 3 — Senior dev agent
cd dev-senior && claude-tg # select "senior"
```

Each session reads its own `CLAUDE.md` and `.claude/skills/` — fully isolated contexts, zero token leakage between agents. The bot token is resolved from the shared registry by name.

### Manual setup (without `claude-tg`)

If you prefer manual configuration, add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ceo-agent-tools-channels": {
      "command": "node",
      "args": ["/absolute/path/to/CEO-agent-tools-channels/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_NAME": "devops"
      }
    }
  }
}
```

Then launch:

```bash
claude --dangerously-load-development-channels server:ceo-agent-tools-channels
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_NAME` | **yes** | — | Bot name to load from `~/.claude/telegram-bots.json`. **Only this bot will be started** — ensures strict per-agent routing. |
| `TELEGRAM_POLL_INTERVAL` | no | `1000` | Polling interval in ms |
| `TELEGRAM_ACCESS_LIST` | no | `~/.claude/telegram-access-{name}.json` | Path to the access control file |
| `DEBUG` | no | `0` | Set to `1` to enable debug logging to stderr |
| `MCP_LOG_FILE` | no | — | Path to a file for persistent debug logging (e.g. `/tmp/mybot.log`) |
| `TELEGRAM_GROUP_POLICY` | no | `mention-only` | How to handle group chat messages: `open` \| `allowlist` \| `mention-only` |

### Bot routing (important)

When `TELEGRAM_BOT_NAME` is set, **only that bot is loaded** — the MCP server starts a single Telegram poller for that bot only. This prevents the "all agents receive all messages" problem when running multiple agents in parallel.

`claude-tg` sets `TELEGRAM_BOT_NAME` automatically based on your selection. If launching manually, always pass it explicitly:

```json
"env": { "TELEGRAM_BOT_NAME": "devops" }
```

If `TELEGRAM_BOT_NAME` is **not** set (legacy mode), all bots in the registry are loaded simultaneously. This is not recommended for multi-agent setups.

## Tools

### `send_telegram_message`

Send a message to a Telegram chat.

| Parameter | Type | Description |
|---|---|---|
| `chat_id` | number | Chat ID (from channel event metadata) |
| `text` | string | Message text (Markdown) |

### `telegram_access`

Manage access control.

| Parameter | Type | Description |
|---|---|---|
| `action` | string | `pair`, `unpair`, `list`, or `set-policy` |
| `code` | string | Pairing code (for `pair`) |
| `user_id` | number | User ID (for `unpair`) |
| `policy` | string | `open` or `allowlist` (for `set-policy`) |

## Group chat support

Agents can be added to Telegram group chats and will respond based on the `TELEGRAM_GROUP_POLICY` setting.

### Policies

| Policy | Behavior |
|--------|----------|
| `mention-only` | Only respond when bot is `@mentioned` or the message is a reply to a bot message. **Default.** Ideal for finance, ops, or any shared team chat where the bot should stay quiet unless addressed. |
| `allowlist` | Only respond to messages from users in the access list. Useful for bots where the group is shared but only admins should trigger it. |
| `open` | Respond to all messages in the group, same as DM behavior. Use only for dedicated bot channels with no casual conversation. |

### What agents receive

When a message arrives from a group, Claude Code receives the full context via channel metadata:

```
chat_type       = "supergroup"
chat_title      = "Finance Team"
is_group        = "true"
bot_mentioned   = "true"      ← bot was @mentioned
is_reply_to_bot = "false"
```

This lets agents make their own filtering decisions in `CLAUDE.md` on top of the MCP-level policy.

### Bot mention detection

Mention is detected via:
- `@botusername` appearing in text (case-insensitive)
- Telegram `mention` entity pointing to the bot
- `text_mention` entity (for bots without usernames)
- Message is a reply to a previous bot message

The `@mention` is automatically stripped from the message text before forwarding to Claude — so the agent sees a clean command without the `@botname` prefix.

### Access control in groups

By default (`mention-only`), no pairing is required — anyone who mentions the bot will get a response. If you need per-user access control in groups, switch to `allowlist` policy and pair users as usual.

## Media support

The server handles incoming photos and documents — not just text.

**Photos:**
- Downloaded from Telegram and saved to `/tmp/tg-photo-{file_unique_id}.jpg`
- Channel event text becomes: `[photo saved to /tmp/tg-photo-<id>.jpg Caption: "..."]`
- Agent reads the file via Claude Code's native `Read` tool (supports images natively)

**Documents (any file type):**
- Downloaded to `/tmp/tg-doc-{file_unique_id}-{filename}`
- Channel event text becomes: `[document: filename.ext (mime/type) saved to /tmp/tg-doc-<id>-filename Caption: "..."]`
- Text files (`.txt`, `.md`, `.csv`, `.json`, `.yaml`, `.log`) — agent reads with `cat`
- Images (`.jpg`, `.png`) sent as documents — agent reads with `Read` tool

**Empty messages (photo without caption):**
- Previously ignored by Claude Code (empty `content` in channel event)
- Now: fallback text `[message received - no text content]` ensures the message always reaches the agent

**Example channel content for a photo with caption:**
```
[photo saved to /tmp/tg-photo-AgACAgI.jpg Caption: "Here's the screenshot"]
```

**Example channel content for a `.md` file:**
```
[document: report.md (text/markdown) saved to /tmp/tg-doc-XYZ123-report.md Caption: "Review this"]
```

Your agent parses the path from the message text and reads the file directly.

## Access control

By default, the server runs in `allowlist` mode — only paired users can send messages.

**Pairing flow:**

1. Unknown user sends a message to the bot — bot replies with a 6-char code
2. You tell Claude Code to pair that code — user is added to the allowlist
3. Bot confirms in Telegram: "Bot authorized under name {botName}"
4. User can now send messages that reach Claude Code

Pairing codes are single-use and per-user (sending multiple messages won't generate duplicate codes).

**Open mode:**

If you want anyone to message the bot:
```
Tell Claude: "set telegram access policy to open"
```

## Permission relay

When Claude Code needs approval to run a tool (e.g., `Bash`), it forwards the request to Telegram:

```
🔒 Permission request

Tool: Bash
Action: Run npm test

Reply "yes abcde" or "no abcde"
```

Approve or deny tool execution right from your phone — no need to sit at the terminal.

## Debug mode

Debug mode enables verbose logging across all modules. Useful for troubleshooting bot connectivity, pairing issues, and channel communication.

### Enabling

Set `DEBUG=1` in the MCP server's environment.

**Via `claude-tg`** — edit `claude-tg` and change `"DEBUG": "0"` to `"DEBUG": "1"` in the env block.

**Via `.mcp.json`:**
```json
{
  "env": {
    "TELEGRAM_BOT_NAME": "devops",
    "DEBUG": "1"
  }
}
```

### Where logs go

All logs are written to **stderr** (MCP uses stdout for protocol messages). Claude Code captures stderr and shows it in the MCP server output.

### Log prefixes

| Prefix | Module | What it logs |
|---|---|---|
| `[telegram-mcp]` | `index.ts` | Startup, bot connection, polling, pairing codes, authorized messages |
| `[config:debug]` | `config.ts` | Env vars, bot registry lookup, token resolution |
| `[telegram-api:debug]` | `telegram.ts` | Every Telegram API call and errors |
| `[access:debug]` | `access.ts` | Access file load/save, pair code lookup, allowlist changes |
| `[tools:debug]` | `tools.ts` | Tool invocations with arguments, pair results |
| `[channel:debug]` | `channel.ts` | Channel notifications emitted to Claude Code (full JSON payload) |

### Example debug output

```
[telegram-mcp] Starting MCP server...
[config:debug] TELEGRAM_BOT_NAME="devops"
[config:debug] Token found in registry for "devops"
[telegram-mcp] Config loaded: bot="devops", accessList="~/.claude/telegram-access-devops.json", poll=1000ms
[telegram-mcp] Bot connected: @cc_devopsbot (CC devops bot)
[telegram-mcp] MCP server started on stdio
[telegram-mcp] Polling started
[telegram-mcp] Pairing code "abc123" generated for user 123456789 (chat 123456789)
[access:debug] pair("abc123"): success, allowedUsers=[123456789]
[telegram-mcp] Sending authorization confirmation to chat 123456789 for bot "devops"
[channel:debug] Emitting channel notification: {"method":"notifications/claude/channel",...}
```

### Disabling

Set `DEBUG=0` or remove the `DEBUG` env var. Non-debug logs (`[telegram-mcp]`) always print regardless.

## Process cleanup

The MCP server automatically exits when:
- Claude Code closes stdin (normal exit or crash)
- `SIGINT`, `SIGTERM`, or `SIGHUP` signal is received

This prevents zombie processes from accumulating after sessions end.

## Skills

The `skills/` directory contains reusable agent skill files.

### spawn-agent

**File:** `skills/spawn-agent/SKILL.md`

A complete step-by-step skill for creating a new agent from scratch. Covers everything:

1. Register bot token in `~/.claude/telegram-bots.json`
2. Create `telegram-access-{name}.json` with direct allowlist (no pairing needed)
3. Set up agent directory: `logs/`, `state/`, `.claude/skills/`
4. Write `.claude/settings.json` with `bypassPermissions` and all tool permissions
5. Generate a task-specific `CLAUDE.md`
6. Create the MCP config at `/tmp/claude-tg-mcp.{name}.json`
7. Start the tmux session
8. Update the architecture doc in Obsidian
9. Send a completion report to Telegram

**Usage:** copy the skill file into your agent's `.claude/skills/` folder, or reference it when asking Claude Code to create a new agent:

```
Create a new agent called "hiring" — it should review incoming CVs, score them against our criteria, and reply with a structured verdict.
```

Claude will follow the skill and build everything automatically.

---

## Architecture

```
src/
├── index.ts          # Entry point: MCP server + Telegram polling loop + process cleanup
├── config.ts         # Bot registry (~/.claude/telegram-bots.json) + env vars → typed config
├── telegram.ts       # Telegram Bot API client (zero deps, pure fetch)
├── access.ts         # Allowlist, pairing codes, policy management (per-bot files)
├── channel.ts        # Emits MCP channel notifications to Claude Code
├── permissions.ts    # Permission relay (Claude Code ↔ Telegram)
└── tools.ts          # MCP tool definitions and handlers
```

## Acknowledgements

Based on the official [Anthropic Telegram Channel Plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) (`telegram@claude-plugins-official`). Rewritten from scratch in TypeScript/Node.js with multi-agent support as the primary design goal.

## Requirements

- Node.js >= 18
- Claude Code with channels support (v2.1.80+)
- Claude.ai login (not API key)

## License

Source Available — free to use, fork, and modify. Commercial use (selling the software or services based on it) is not permitted without a separate license. See [LICENSE](./LICENSE) for details.

Copyright Roman Belopolskiy / [4sell.ai](https://4sell.ai) — for commercial licensing: r.belopolskiy@4sell.ai
