# CEO Agent Tools & Channels

Multi-agent toolkit for startup founders. Manage isolated Claude Code agents through separate Telegram chats — each with its own skills, tools, and personality.

**Author:** Roman Belopolskiy, CEO [4sell.ai](https://4sell.ai)

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

Unlike the official Telegram plugin (which stores the bot token globally), this server is configured **per-project** via environment variables — so you can run as many agents as you need.

## Quick start

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, run `/newbot`, and save the token.

### 2. Install

```bash
git clone https://github.com/terorex-web/CEO-agent-tools-channels.git
cd CEO-agent-tools-channels
npm install
npm run build
```

### 3. Configure

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/CEO-agent-tools-channels/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "123456:ABC-DEF...",
        "TELEGRAM_BOT_NAME": "my-bot"
      }
    }
  }
}
```

### 4. Launch Claude Code with channels

```bash
claude --channels server:telegram
```

### 5. Pair your Telegram account

1. Send any message to your bot in Telegram
2. The bot replies with a 6-character pairing code
3. In Claude Code, say: "pair code `abc123`"
4. Done — your messages now reach Claude Code

## Multi-agent setup

The core use case: run **multiple agents** from separate directories, each with its own Telegram bot, personality, and toolset.

### Directory structure

```
my-agents/
├── smm-bot/
│   ├── .mcp.json       ← bot token #1
│   ├── CLAUDE.md       ← "You are an SMM manager..."
│   └── .claude/skills/ ← create-post, write-comment, find-accounts
├── dev-bot/
│   ├── .mcp.json       ← bot token #2
│   ├── CLAUDE.md       ← "You are a frontend developer..."
│   └── .claude/skills/ ← fix-bug, update-page
└── dev-senior/
    ├── .mcp.json       ← bot token #3
    ├── CLAUDE.md       ← "You are a senior engineer..."
    └── .claude/skills/ ← refactor, deploy, review-pr
```

### Each `.mcp.json` points to the same server binary, different token

**smm-bot/.mcp.json:**
```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/CEO-agent-tools-channels/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "TOKEN_FOR_SMM_BOT",
        "TELEGRAM_BOT_NAME": "smm-bot"
      }
    }
  }
}
```

**dev-bot/.mcp.json:**
```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/CEO-agent-tools-channels/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "TOKEN_FOR_DEV_BOT",
        "TELEGRAM_BOT_NAME": "dev-bot"
      }
    }
  }
}
```

### Launch each agent

```bash
# Terminal 1 — SMM agent
cd smm-bot && claude --channels server:telegram

# Terminal 2 — Dev agent
cd dev-bot && claude --channels server:telegram

# Terminal 3 — Senior dev agent
cd dev-senior && claude --channels server:telegram
```

Each session reads its own `.mcp.json`, `CLAUDE.md`, and `.claude/skills/` — fully isolated contexts, zero token leakage between agents.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from @BotFather |
| `TELEGRAM_BOT_NAME` | no | `telegram` | Name used in MCP registration and channel `source` attribute |
| `TELEGRAM_POLL_INTERVAL` | no | `1000` | Polling interval in ms |
| `TELEGRAM_ACCESS_LIST` | no | `./access.json` | Path to the access control file |

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

## Access control

By default, the server runs in `allowlist` mode — only paired users can send messages.

**Pairing flow:**

1. Unknown user sends a message to the bot — bot replies with a 6-char code
2. You tell Claude Code to pair that code — user is added to the allowlist
3. User can now send messages that reach Claude Code

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

## Architecture

```
src/
├── index.ts          # Entry point: MCP server + Telegram polling loop
├── config.ts         # Environment variables → typed config
├── telegram.ts       # Telegram Bot API client (zero deps, pure fetch)
├── access.ts         # Allowlist, pairing codes, policy management
├── channel.ts        # Emits MCP channel notifications to Claude Code
├── permissions.ts    # Permission relay (Claude Code ↔ Telegram)
└── tools.ts          # MCP tool definitions and handlers
```

## Requirements

- Node.js >= 18
- Claude Code with channels support (v2.1.80+)
- Claude.ai login (not API key)

## License

All rights reserved. Copyright Roman Belopolskiy / [4sell.ai](https://4sell.ai)
