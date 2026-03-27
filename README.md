# claude-telegram-MCP-multi-agent

Telegram channel MCP server for Claude Code. Run multiple independent Claude Code agents, each with its own Telegram bot, skills, and tools.

Unlike the official Telegram plugin (which stores the bot token globally), this server is configured **per-project** via environment variables — so you can run as many bots as you want in parallel.

## How it works

```
Telegram user
     │
     ▼
Telegram Bot API  ◄── long polling ──  this MCP server  ◄── stdio ──►  Claude Code
                  ── send_message ──►                    ── channel ──►
```

1. The server connects to Telegram via Bot API and polls for new messages
2. When a message arrives, it emits a `notifications/claude/channel` event to Claude Code
3. Claude Code processes the message using its configured skills, tools, and CLAUDE.md prompt
4. Claude Code replies by calling the `send_telegram_message` tool
5. The server sends the reply back through Telegram

## Quick start

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, run `/newbot`, and save the token.

### 2. Install

```bash
git clone https://github.com/terorex-web/claude-telegram-MCP-multi-agent.git
cd claude-telegram-MCP-multi-agent
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
      "args": ["/absolute/path/to/claude-telegram-MCP-multi-agent/dist/index.js"],
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

The whole point of this project: run **multiple bots** from different project directories, each with its own personality and tools.

### Create separate directories

```
my-agents/
├── smm-bot/
│   ├── .mcp.json       ← bot token #1
│   └── CLAUDE.md       ← "You are an SMM manager..."
├── dev-bot/
│   ├── .mcp.json       ← bot token #2
│   └── CLAUDE.md       ← "You are a frontend developer..."
└── dev-senior/
    ├── .mcp.json       ← bot token #3
    └── CLAUDE.md       ← "You are a senior engineer..."
```

### Each `.mcp.json` points to the same server, different token

**smm-bot/.mcp.json:**
```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
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
      "args": ["/path/to/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "TOKEN_FOR_DEV_BOT",
        "TELEGRAM_BOT_NAME": "dev-bot"
      }
    }
  }
}
```

### Launch each agent in a separate terminal

```bash
# Terminal 1
cd smm-bot && claude --channels server:telegram

# Terminal 2
cd dev-bot && claude --channels server:telegram

# Terminal 3
cd dev-senior && claude --channels server:telegram
```

Each session reads its own `.mcp.json`, `CLAUDE.md`, and `.claude/skills/` — completely independent.

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

1. Unknown user sends a message → bot replies with a 6-char code
2. You tell Claude Code to pair that code → user is added to the allowlist
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

Reply with `yes abcde` or `no abcde` to approve or deny — directly from Telegram.

## Architecture

```
src/
├── index.ts          # Entry point: starts MCP server + polling loop
├── config.ts         # Environment variables → typed config
├── telegram.ts       # Telegram Bot API client (zero dependencies, pure fetch)
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

MIT
