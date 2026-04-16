# Skill: spawn-agent

Создание нового AI-агента с Telegram-ботом с нуля — полная инфраструктура за один запрос.

## Когда использовать

Когда Roman говорит что-то вроде:
- "Создай агента для X"
- "Хочу бота который делает Y"
- "Нужен агент для Z"

## Что нужно от Roman

Перед началом уточни (если не сказано):

1. **Имя агента** — короткое, латиницей (пример: `sales`, `hiring`, `content`)
2. **Цель** — зачем агент нужен, что делает (1-2 предложения)
3. **Задачи** — какие команды/задачи будет выполнять (список или описание)
4. **Telegram-токен** — токен от @BotFather для нового бота

Если какого-то пункта нет — спроси. Не начинай создание без всех четырёх.

---

## Алгоритм создания

### Шаг 1 — Получить Telegram-токен

Если токен не предоставлен, напомни Roman:
```
Создай бота через @BotFather:
1. Открой @BotFather в Telegram
2. /newbot
3. Задай имя и username
4. Пришли токен сюда
```

### Шаг 2 — Зарегистрировать бота

Добавить токен в реестр:
```bash
python3 -c "
import json
path = '/Users/romanbelopolskiy/.claude/telegram-bots.json'
d = json.load(open(path))
d['{BOT_NAME}'] = {'token': '{TOKEN}'}
json.dump(d, open(path, 'w'), indent=2)
"
```

Создать access-файл:
```bash
cat > /Users/romanbelopolskiy/.claude/telegram-access-{BOT_NAME}.json << 'EOF'
{
  "policy": "allowlist",
  "allowedUsers": [YOUR_TELEGRAM_USER_ID],
  "pendingPairs": {}
}
EOF
```

### Шаг 3 — Создать папку агента

```bash
mkdir -p /Users/romanbelopolskiy/agents/{NAME}/logs
mkdir -p /Users/romanbelopolskiy/agents/{NAME}/.claude/skills
mkdir -p /Users/romanbelopolskiy/agents/{NAME}/state
```

### Шаг 4 — Создать .claude/settings.json

```bash
cat > /Users/romanbelopolskiy/agents/{NAME}/.claude/settings.json << 'EOF'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Edit(*)",
      "Read(*)",
      "Write(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "Agent(*)",
      "NotebookEdit(*)",
      "Skill(*)",
      "ToolSearch(*)",
      "TaskCreate(*)",
      "TaskUpdate(*)",
      "TaskGet(*)",
      "TaskList(*)",
      "TaskStop(*)",
      "TaskOutput(*)",
      "CronCreate(*)",
      "CronDelete(*)",
      "CronList(*)",
      "EnterPlanMode(*)",
      "ExitPlanMode(*)",
      "EnterWorktree(*)",
      "ExitWorktree(*)",
      "AskUserQuestion(*)",
      "mcp__ceo-agent-tools-channels__*"
    ],
    "deny": []
  },
  "defaultMode": "bypassPermissions",
  "skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true,
  "enableAllProjectMcpServers": true
}
EOF
```

### Шаг 5 — Создать CLAUDE.md

Генерируй CLAUDE.md на основе цели и задач агента. Шаблон:

```markdown
# {NAME} Agent

You are Roman Belopolskiy's {DESCRIPTION} agent. {ONE_LINE_PURPOSE}.

## Permissions

You have full root access. Never ask for confirmation — execute everything immediately. You can:
- Run any shell command without approval
- Edit any file on the system including your own CLAUDE.md, skills, and configs
- Read/write any path
- Self-modify your skills and learned patterns based on feedback

## How you work

You communicate with the user exclusively through Telegram. When you receive a message, it's a task to {MAIN_TASK}.

## Context files

Before starting any task, read:
- [список контекстных файлов специфичных для агента]

## Workflow

[описание режимов работы и команд агента — специфично под задачи]

## Communication

- Reply to the user via the `send_telegram_message` tool using the `chat_id` from the incoming message metadata
- Always confirm task completion with a brief summary

## Context loading rule (token efficiency)

When re-reading skill/context files at the start of a run:
- If the file was already read in this session and has not changed — skip re-reading it
- Check modification time: `stat -f "%m" <file>` vs your last read timestamp stored in session memory
- Only re-read if the file was modified since last read
- For large skill files (>200 lines): read only the relevant section using offset/limit, not the full file

## Logging

Log every request and response to a daily file in your agent folder:
- Path: `~/agents/{NAME}/logs/YYYY-MM-DD.md` (replace YYYY-MM-DD with actual date)
- Create the `logs/` directory if it does not exist
- At the start of each new day, start a new file (do not append to previous day)

Format for each entry:
\`\`\`
## [HH:MM:SS]

**IN:** [full incoming message text]

**OUT:** [summary of what you did / replied]

**FILES:** [list of files read/analyzed during this task, or "none"]

---
\`\`\`

Log immediately after processing each message — before or after sending the Telegram reply.
Do not log internal tool calls or intermediate steps, only the user-facing request and your final response summary.
```

### Шаг 6 — Создать MCP-конфиг

Создать `.mcp.json` в папке агента (подключение к shared SSE серверу):

```bash
cat > /Users/romanbelopolskiy/agents/{NAME}/.mcp.json << 'EOF'
{
  "mcpServers": {
    "ceo-agent-tools-channels": {
      "type": "sse",
      "url": "http://127.0.0.1:3200/sse?bot={BOT_NAME}"
    }
  }
}
EOF
```

> SSE сервер (`com.ceo-agent-tools.channels-sse`) должен быть запущен на порту 3200.
> Проверить: `curl http://127.0.0.1:3200/health`

### Шаг 7 — Перезапустить SSE сервер (чтобы подхватить нового бота)

```bash
launchctl unload ~/Library/LaunchAgents/com.ceo-agent-tools.channels-sse.plist
launchctl load ~/Library/LaunchAgents/com.ceo-agent-tools.channels-sse.plist
```

### Шаг 8 — Запустить в tmux

```bash
tmux new-session -d -s {NAME} -x 220 -y 50
tmux send-keys -t {NAME}:0 "cd /Users/romanbelopolskiy/agents/{NAME} && ~/CEO-agent-tools-channels/claude-tg" Enter
```

`claude-tg` автоматически определит бота по имени директории.

### Шаг 9 — Обновить архитектурный документ

Открыть и добавить секцию нового агента:
`/Users/romanbelopolskiy/.openclaw/workspace/Obsidian-Networking-KB/95 Agents/agent-factory-architecture.md`

Добавить в секцию агентов:
```markdown
### 🤖 {NAME} Agent

**tmux:** `{NAME}` | **Бот:** `{BOT_NAME}` | **Папка:** `~/agents/{NAME}/`

#### Назначение
{DESCRIPTION}

#### Workflow
{краткое описание что делает}

#### Skills
`~/agents/{NAME}/.claude/skills/`
```

Обновить таблицу Cron-задач если нужно.
Обновить дату: `Последнее обновление: YYYY-MM-DD`.

### Шаг 10 — Отчёт Roman

Отправить итог:
```
✅ Агент {NAME} создан

📁 Папка: ~/agents/{NAME}/
🤖 Telegram-бот: @{USERNAME}
🖥 tmux-сессия: {NAME}
📋 CLAUDE.md: настроен под задачу
⚙️ Права: bypassPermissions, полный доступ
📝 Логи: ~/agents/{NAME}/logs/YYYY-MM-DD.md
📄 Архитектура: обновлена

Написать боту в Telegram — он готов к работе.
```

---

## Checklist (проверь перед тем как отчитаться)

- [ ] Токен добавлен в `telegram-bots.json`
- [ ] `telegram-access-{NAME}.json` создан (allowlist: YOUR_TELEGRAM_USER_ID)
- [ ] `~/agents/{NAME}/` создана со всеми папками (logs, state, .claude/skills)
- [ ] `.claude/settings.json` — bypassPermissions, все разрешения
- [ ] `CLAUDE.md` — написан под конкретную задачу агента
- [ ] `.mcp.json` с SSE URL (`?bot={NAME}`) создан в папке агента
- [ ] SSE сервер перезапущен (подхватил нового бота)
- [ ] tmux-сессия запущена через `claude-tg`
- [ ] Архитектурный документ обновлён

---

## Заметки

- **Один бот = одна tmux-сессия** — не запускать несколько агентов в одной сессии
- **BOT_NAME в telegram-bots.json** должен совпадать с `?bot=` параметром в `.mcp.json`
- **SSE сервер** — один shared инстанс на порту 3200, launchd `com.ceo-agent-tools.channels-sse`
- **Typing indicator** — автоматически отправляется пока агент обрабатывает сообщение
- **Логи** — каждый агент пишет в свою папку, новый день = новый файл
- **CLAUDE.md** — пиши конкретно под задачу, не копируй шаблон буквально
