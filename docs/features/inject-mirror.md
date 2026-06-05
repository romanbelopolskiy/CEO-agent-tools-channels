# Feature: inject-mirror

## Goal

When the task scheduler injects a task/prompt into any agent's session, send the
bot owner exactly **one** copy in their Telegram chat with that same bot, so they
can see the agent received work. The task still goes to the agent once (via the
existing tmux send-keys path) and is additionally mirrored to the owner once.

## Why

The scheduler injects prompts straight into the agent TUI (`tmux send-keys`),
bypassing the Telegram bridge. The owner therefore never saw cron/registry tasks
land — only their own messages and the agent's final replies. This closes that
visibility gap without adding new credentials or new delivery paths.

## Design (approach A)

```
agents.cron_tasks / agents.tasks
        │
        ▼
cron-task-scheduler.py ──tmux send-keys──▶ agent (unchanged)
        │
        └── POST /inject-mirror ──▶ bridge (CEO-tools) ──▶ owner's Telegram chat
```

Reuses the existing localhost `/status-feed` pattern: the scheduler posts a small
copy to the bridge, the bridge sends it through the right bot. Tokens stay inside
the bridge process.

## Components

- **Bridge — `src/index.ts`, `POST /inject-mirror`.** Accepts `{botName, text, kind?}`.
  Resolves the owner chat from the bot's local access config (first allowlisted
  user; optional `INJECT_MIRROR_DEFAULT_CHAT` env fallback for headless setups).
  Truncates text (~400 chars + `…`), sends as plain text with a copy marker
  (`🔻 Агент <bot> получил задачу:`), and logs a `system` conversation entry.
  No-ops safely on unknown bot, empty text, or no resolvable chat; never throws
  back at the caller.
- **Scheduler — `/srv/agents/bin/cron-task-scheduler.py`.** Right after a
  successful `send_to_tmux(...)`, fires a best-effort `POST` to
  `http://127.0.0.1:3200/inject-mirror` (3s timeout, all errors swallowed).

## What is mirrored

- **Registry pickups (`task-registry-pickup-*`):** the actual claimable task
  titles (+ creator + priority), not the generic "claim your tasks" prompt
  (`build_registry_mirror_text`, guarded by a SAVEPOINT so a summary query
  failure cannot poison the scheduler's main transaction).
- **Regular cron prompts:** the prompt itself (truncated by the bridge).
- **`RUN_SCRIPT` health probes:** **not** mirrored — they run in a separate
  scheduler branch that never reaches the mirror call.
- **Owner's own incoming messages / other scripts' system pings:** not mirrored
  (phase 1 covers the scheduler only).

## Guarantees

- One real inject → exactly one owner copy, in the same bot's chat, marked as a copy.
- No loop: the copy is an outbound bot→owner message; it never re-enters the agent.
- A copy failure never blocks or fails the inject (fire-and-forget + swallow).
- Bot tokens never leave the bridge; the scheduler posts only plain text to localhost.

## Config

- `INJECT_MIRROR_URL` (scheduler env, default `http://127.0.0.1:3200/inject-mirror`).
- `INJECT_MIRROR_DEFAULT_CHAT` (bridge env, optional fallback owner chat for headless setups).

## Operational note

Activating a bridge change requires rebuilding `dist/` and restarting the SSE
server, which briefly reconnects Telegram for all bridge-served agents. Schedule
the restart in a quiet window; smoke-test against one bot first.
