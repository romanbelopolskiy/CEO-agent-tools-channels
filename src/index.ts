#!/usr/bin/env node

import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import type { TelegramUser } from "./telegram.js";
import { AccessControl } from "./access.js";
import { PermissionManager } from "./permissions.js";
import { emitChannelMessage, emitPermissionResponse } from "./channel.js";
import { registerTools, type BotContext } from "./tools.js";
import type { GroupPolicy } from "./config.js";
import { log, debug, logConversation } from "./logger.js";
import { TYPING_INTERVAL_MS, TYPING_TIMEOUT_MS, DEFAULT_SSE_PORT, STATUS_GC_INTERVAL_MS } from "./constants.js";
import { StatusManager, loadTelemetryConfig, type VerbosityMode } from "./status-messages.js";
import { maybeGate } from "./auto-compact.js";
import { isOutgoingOnly } from "./outgoing-only.js";
import { synthesizeCallbackMessage } from "./callback-query.js";

const OPENAI_TRANSCRIPTIONS_URL = process.env.TELEGRAM_STT_OPENAI_URL || "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTIONS_MODEL = process.env.TELEGRAM_STT_MODEL || "whisper-1";
const OPENAI_TRANSCRIPTIONS_LANGUAGE = process.env.TELEGRAM_STT_LANGUAGE || "ru";
const OPENAI_TRANSCRIPTIONS_TIMEOUT_MS = Number(process.env.TELEGRAM_STT_TIMEOUT_MS || "120000");

interface BotRuntime {
  ctx: BotContext;
  permissions: PermissionManager;
  me: TelegramUser;
  botUsername: string;
}

// --- SSE session tracking ---
interface SseSession {
  id: string;
  server: Server;
  transport: SSEServerTransport;
  botName: string | null; // null = all bots
}

const sseSessions = new Map<string, SseSession>();

// --- Pending-message replay queue ---
// When a Telegram message arrives for an agent whose SSE session is not yet
// ready (cold start after restart), we must NEVER drop it. We queue it here and
// replay it once the agent's SSE session connects (see SSE /sse handler) or via
// a periodic sweeper. TTL-bounded so a never-waking agent doesn't keep stale msgs.
interface PendingMessage {
  msg: any;
  botMentioned: boolean;
  isReplyToBot: boolean;
  enqueuedAt: number;
}
const pendingByBot = new Map<string, PendingMessage[]>();
const PENDING_TTL_MS = Number(process.env.TELEGRAM_PENDING_TTL_MS || "300000"); // 5 min
const PENDING_MAX_PER_BOT = Number(process.env.TELEGRAM_PENDING_MAX || "20");

// --- Status manager (live status messages per ТЗ) ---
let statusManager: StatusManager | null = null;
let telemetryMode: VerbosityMode = "status";

const STATUS_CODE_WRAPPER_OVERHEAD = "<pre><code></code></pre>".length;
const STATUS_CODE_MAX_LENGTH = 4000;

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function compactLiveStatus(text: string): string {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const hudLine = [...lines]
    .reverse()
    .find((line) => /\b5h:[^\n]*\bwk:[^\n]*\bsn:[^\n]*·\s*ctx:\d+%/.test(line));

  const activityLine = [...lines]
    .reverse()
    .find((line) =>
      /^[✻✢✶✽✦✧✷✸✹●◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line) ||
      /\b(Perusing|Pondering|Thinking|Tinkering|Calling|Reading|Searching|Writing|Editing|Running)\b/.test(line)
    );

  if (activityLine && hudLine) return `${activityLine}\n  ${hudLine}`;
  if (activityLine) return activityLine;
  if (hudLine) return `✻ Working…\n  ${hudLine}`;
  return text || "\u200b";
}

function formatStatusAsCodeBlock(text: string): string {
  let raw = compactLiveStatus(text);
  let escaped = escapeTelegramHtml(raw);
  const maxEscapedLength = STATUS_CODE_MAX_LENGTH - STATUS_CODE_WRAPPER_OVERHEAD;

  while (escaped.length > maxEscapedLength && raw.length > 1) {
    raw = raw.slice(Math.max(0, raw.length - Math.ceil(raw.length * 0.9)));
    escaped = escapeTelegramHtml(raw);
  }

  if (escaped.length > maxEscapedLength) {
    escaped = escaped.slice(-maxEscapedLength);
  }

  return `<pre><code>${escaped}</code></pre>`;
}

// Load per-agent config if we're inside an agent dir.
try {
  const agentDir = process.env.AGENT_DIR || process.cwd();
  const cfg = loadTelemetryConfig(agentDir);
  telemetryMode = cfg.mode;
} catch {}

// --- Typing indicator ---
const typingIntervals = new Map<string, NodeJS.Timeout>();

function startTyping(botsMap: Map<string, BotContext>, botName: string, chatId: number) {
  const key = `${botName}:${chatId}`;
  if (typingIntervals.has(key)) return;

  const bot = botsMap.get(botName);
  if (!bot) return;

  bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

  const interval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);

  typingIntervals.set(key, interval);

  // Auto-stop after 2 minutes
  setTimeout(() => stopTyping(botName, chatId), TYPING_TIMEOUT_MS);
}

function stopTyping(botName: string, chatId: number) {
  const key = `${botName}:${chatId}`;
  const interval = typingIntervals.get(key);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(key);
  }
}

// --- Build MCP Server instance ---
function createMcpServer(
  runtimes: BotRuntime[],
  botsMap: Map<string, BotContext>,
  sessionBotName: string | null = null
): Server {
  const botList = runtimes.map((r) => `"${r.ctx.name}" (@${r.me.username})`).join(", ");

  const server = new Server(
    {
      name: "telegram-channels",
      version: "1.0.0",
    },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: [
        `This is a multi-bot Telegram channel plugin with ${runtimes.length} bot(s): ${botList}.`,
        `When a user asks you to pair with a code (e.g. "pair code abc123"), call the telegram_access tool with action "pair" and the code.`,
        `Do NOT run "claude pair" shell command — that is an unrelated pair-coding feature.`,
        `Use send_telegram_message to reply. The bot_name and chat_id come from channel message metadata.`,
        `Always use the same bot_name that the message arrived on.`,
      ].join("\n"),
    }
  );

  registerTools(server, botsMap, (botName, chatId) => {
    stopTyping(botName, chatId);
  }, statusManager);

  server.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "notifications/claude/channel/permission_request") {
      return;
    }

    const params = notification.params as Record<string, unknown> | undefined;
    if (!params) return;

    const requestId = params.requestId as string;
    const toolName = params.toolName as string;
    const description = params.description as string;

    const targetRuntimes = sessionBotName
      ? runtimes.filter((r) => r.ctx.name === sessionBotName)
      : runtimes;
    for (const runtime of targetRuntimes) {
      const users = runtime.ctx.access.listUsers();
      for (const userId of users) {
        try {
          await runtime.permissions.forwardRequest(userId, requestId, toolName, description);
        } catch (err) {
          log(`Failed to forward permission to user ${userId} via ${runtime.ctx.name}: ${err}`);
        }
      }
    }
  };

  return server;
}

// --- Command registry: send keys to the claude CLI running in tmux ---
type CommandDef = {
  name: string;
  triggers: string[];
  tmuxKeys: string[][];
  reply: string;
  streamOutput: boolean;
  restartSession?: boolean;
};

const COMMANDS: CommandDef[] = [
  {
    name: "stop",
    triggers: ["stop", "/stop", "стоп", "esc", "escape"],
    tmuxKeys: [["Escape"]],
    reply: "🛑 Interrupted",
    streamOutput: false,
  },
  {
    name: "new",
    triggers: ["new", "/new", "новая сессия", "новый чат"],
    tmuxKeys: [],
    reply: "🔄 Новая сессия агента запущена",
    streamOutput: false,
    restartSession: true,
  },
  {
    name: "status",
    triggers: ["status", "/status", "статус"],
    tmuxKeys: [["Escape"], ["/status", "Enter"]],
    reply: "📊 Sent /status to CLI",
    streamOutput: true,
  },
  {
    name: "compact",
    triggers: ["compact", "/compact", "компакт"],
    tmuxKeys: [["Escape"], ["/compact", "Enter"]],
    reply: "🗜 Sent /compact to CLI",
    streamOutput: true,
  },
];

// Validate a bare command name for the generic passthrough.
// Allows plugin-scoped names like `oh-my-claudecode:cancel` and dashed names like `design-review`.
const SAFE_CMD_NAME_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const PASSTHROUGH_MAX_LEN = 500;
// Reject any C0 control character or DEL in the raw message. Without this, embedded
// ESC / TAB / BS bytes would be typed into the Claude Code TUI, potentially escaping
// slash-command mode, driving ANSI parsing, or triggering autocompletes.
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const SESSION_ARCHIVE_ROOT = process.env.TELEGRAM_SESSION_ARCHIVE_ROOT || "";

async function tryHandleCommand(
  botName: string,
  chatId: number,
  text: string,
  opts: { allowPassthrough?: boolean } = {},
): Promise<string | null> {
  const { allowPassthrough = true } = opts;
  const raw = text.trim();
  const trimmed = raw.toLowerCase();
  let cmd = COMMANDS.find(c => c.triggers.includes(trimmed));

  // Generic slash passthrough: any `/<name> [args]` not in the registry is
  // typed into the CLI verbatim (Escape → command → Enter), with streaming on.
  // Mirrors the /status + /compact pattern so every Claude Code slash-command
  // (built-in or user-defined skill) is reachable from Telegram.
  if (!cmd) {
    if (!allowPassthrough) return null;
    if (!raw.startsWith("/")) return null;
    if (CONTROL_CHAR_RE.test(raw)) return null;
    if (raw.length > PASSTHROUGH_MAX_LEN) return null;
    const name = raw.slice(1).split(/\s+/)[0].toLowerCase();
    if (!SAFE_CMD_NAME_RE.test(name)) return null;
    cmd = {
      name,
      triggers: [trimmed],
      // SECURITY INVARIANT: `raw` is passed as a single argv element to tmux send-keys.
      // tmux treats named keys (`Enter`, `C-c`, `Escape`, `Up`, …) specially ONLY when
      // they appear as SEPARATE argv elements. Do not split `raw` on whitespace before
      // passing to send-keys — that would convert any user-chosen word into a keystroke.
      tmuxKeys: [["Escape"], [raw, "Enter"]],
      // Wrap the command name in backticks so the default legacy-Markdown parse mode
      // treats it as inline code. Protects names containing `_` (e.g. `my_skill`) from
      // being interpreted as italic markers and rejected by Telegram with HTTP 400.
      reply: `🔀 Sent \`/${name}\` to CLI`,
      streamOutput: true,
    };
  }

  if (cmd.restartSession) {
    try {
      const existingTask = statusManager?.findTaskByChatId(chatId, botName);
      if (existingTask) {
        statusManager?.finishTask(existingTask.taskId);
        log(`[${botName}] finalized task ${existingTask.taskId} on /${cmd.name}`);
      }
    } catch {}
    stopTyping(botName, chatId);
    const restarted = await restartAgentSessionForCommand(botName);
    return restarted.ok
      ? `${cmd.reply}${restarted.archivePath ? `\nПредыдущая сохранена: ${restarted.archivePath}` : ""}`
      : `❌ Не смог запустить новую сессию агента ${botName}`;
  }

  // Check whether the tmux session exists (non-zero exit = no session)
  try {
    execFileSync("tmux", ["has-session", "-t", botName], { timeout: 3000 });
  } catch {
    return `❌ No tmux session '${botName}' — claude-tg not running`;
  }

  // Finalize any existing active task for this (botName, chatId) pair — clean slate.
  try {
    const existingTask = statusManager?.findTaskByChatId(chatId, botName);
    if (existingTask) {
      statusManager?.finishTask(existingTask.taskId);
      log(`[${botName}] finalized task ${existingTask.taskId} on /${cmd.name}`);
    }
  } catch {}

  // If this command streams output, create a synthetic task so the watcher can pipe CLI output to TG.
  if (cmd.streamOutput && statusManager && telemetryMode !== "silent") {
    const taskId = `${botName}:${chatId}:cmd-${cmd.name}-${Date.now()}`;
    statusManager.startTask({
      taskId,
      botName,
      chatId,
      sourceMessageId: 0,
      mode: telemetryMode,
    }).catch((err) => log(`[${botName}] status startTask error for /${cmd.name}: ${err}`));
    log(`[${botName}] synthetic task ${taskId} created for /${cmd.name} streaming`);
  }

  // Send keystroke batches with 150ms delay between them
  for (let i = 0; i < cmd.tmuxKeys.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 150));
    try {
      execFileSync("tmux", ["send-keys", "-t", botName, ...cmd.tmuxKeys[i]], { timeout: 3000 });
    } catch (err) {
      log(`[${botName}] tmux send-keys failed for ${cmd.name}: ${err}`);
      return `❌ tmux send-keys failed for /${cmd.name}`;
    }
  }
  log(`[${botName}] /${cmd.name} executed via tmux send-keys`);

  // Stop the typing indicator from the interrupted turn
  stopTyping(botName, chatId);

  return cmd.reply;
}

// --- Get all bot names that share a token with the given bot ---
function getBotAliases(botName: string, botsMap: Map<string, BotContext>): string[] {
  // Find the token for this bot by checking tokenAliases. Do not require the
  // caller to pass a populated botsMap: command handlers may run with only the
  // bot slug but still need alias-aware SSE matching.
  for (const [, aliases] of tokenAliases) {
    if (aliases.includes(botName)) {
      return aliases;
    }
  }
  return [botName];
}

function hasMatchingSseSession(botName: string, botsMap: Map<string, BotContext>): boolean {
  const aliases = getBotAliases(botName, botsMap);
  for (const [, session] of sseSessions) {
    if (session.botName === null || aliases.includes(session.botName)) return true;
  }
  return false;
}

function startAgentSession(botName: string): boolean {
  // Called only when no matching SSE session exists. If tmux is still present,
  // it is disconnected from the bridge (for example after bridge restart), so
  // replace it; otherwise a start hook may no-op on an already-existing tmux.
  try {
    execFileSync("tmux", ["has-session", "-t", botName], { timeout: 3000 });
    execFileSync("tmux", ["kill-session", "-t", botName], { timeout: 5000 });
    log(`[${botName}] wake-on-message replaced disconnected tmux session`);
  } catch {}

  try {
    const startAgentCommand = process.env.START_AGENT_COMMAND || "/srv/agents/bin/start-agent.sh";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      execFileSync(startAgentCommand, [botName], { timeout: 45000, stdio: "pipe" });
      try {
        execFileSync("tmux", ["has-session", "-t", botName], { timeout: 3000, stdio: "ignore" });
        log(`[${botName}] wake-on-message started tmux session`);
        return true;
      } catch {
        log(`[${botName}] wake-on-message start attempt ${attempt} left no tmux session; retrying`);
        execFileSync("sleep", [String(attempt)], { timeout: 5000, stdio: "ignore" });
      }
    }
    log(`[${botName}] wake-on-message failed: start-agent returned but no tmux session exists`);
    return false;
  } catch (err) {
    log(`[${botName}] wake-on-message failed to start session: ${err}`);
    return false;
  }
}

function archivePreviousAgentSession(botName: string): string | null {
  const safeBotName = botName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = SESSION_ARCHIVE_ROOT
    ? `${SESSION_ARCHIVE_ROOT}/${safeBotName}`
    : `/srv/agents/claude-agents/${safeBotName}/logs/session-archive`;
  const archivePath = `${archiveDir}/${stamp}.txt`;

  try {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const parts: string[] = [];
    parts.push(`# Claude Telegram agent session archive`);
    parts.push(`bot: ${botName}`);
    parts.push(`archived_at: ${new Date().toISOString()}`);
    parts.push("");

    try {
      const panes = execFileSync("tmux", ["list-panes", "-t", botName, "-F", "#S #{pane_id} pid=#{pane_pid} command=#{pane_current_command} path=#{pane_current_path}"], { timeout: 3000 }).toString();
      parts.push("## tmux panes");
      parts.push(panes.trim() || "(empty)");
      parts.push("");
    } catch (err) {
      parts.push(`## tmux panes\n(unavailable: ${(err as Error).message})\n`);
    }

    try {
      const pane = execFileSync("tmux", ["capture-pane", "-pt", botName, "-S", "-100000"], { timeout: 5000, maxBuffer: 20 * 1024 * 1024 }).toString();
      parts.push("## tmux captured pane");
      parts.push(pane.trimEnd() || "(empty)");
      parts.push("");
    } catch (err) {
      parts.push(`## tmux captured pane\n(unavailable: ${(err as Error).message})\n`);
    }

    writeFileSync(archivePath, parts.join("\n"), { mode: 0o600 });
    log(`[${botName}] previous session archived before /new: ${archivePath}`);
    return archivePath;
  } catch (err) {
    log(`[${botName}] failed to archive previous session before /new: ${err}`);
    return null;
  }
}

async function restartAgentSessionForCommand(botName: string): Promise<{ ok: boolean; archivePath?: string | null }> {
  // `/new` from Telegram should mean a fresh Claude Code runtime, not Claude Code's
  // in-TUI `/clear` alias. Kill the tmux-backed session, let prestart orphan cleanup
  // run through start-agent.sh, then wait until the new MCP/SSE session reconnects.
  const aliases = getBotAliases(botName, new Map());
  const previousSessionIds = new Set<string>();
  let archivePath: string | null = null;
  for (const [id, session] of sseSessions) {
    if (session.botName === null || aliases.includes(session.botName)) previousSessionIds.add(id);
  }

  try {
    execFileSync("tmux", ["has-session", "-t", botName], { timeout: 3000 });
    archivePath = archivePreviousAgentSession(botName);
    execFileSync("tmux", ["kill-session", "-t", botName], { timeout: 5000 });
    log(`[${botName}] /new killed tmux session for fresh restart`);
  } catch {
    log(`[${botName}] /new found no tmux session before fresh restart`);
  }

  const started = startAgentSession(botName);
  if (!started) return { ok: false, archivePath };

  const deadline = Date.now() + Number(process.env.TELEGRAM_NEW_WAIT_MS || process.env.TELEGRAM_WAKE_WAIT_MS || "90000");
  while (Date.now() < deadline) {
    for (const [id, session] of sseSessions) {
      if (!previousSessionIds.has(id) && (session.botName === null || aliases.includes(session.botName))) {
        return { ok: true, archivePath };
      }
    }
    try {
      const pane = execFileSync("tmux", ["capture-pane", "-pt", botName, "-S", "-80"], { timeout: 3000 }).toString();
      if (/Listening for channel messages from: server:ceo-agent-tools-channels/.test(pane)) return { ok: true, archivePath };
    } catch {}
    await sleep(500);
  }
  return { ok: hasMatchingSseSession(botName, new Map()), archivePath };
}

async function ensureSessionForDelivery(botName: string, botsMap: Map<string, BotContext>): Promise<boolean> {
  if (hasMatchingSseSession(botName, botsMap)) return true;
  startAgentSession(botName);

  // Cold-starting Claude Code can take longer than 25s after idle reaping
  // (plugin init, auto-update checks, dev-channel confirmation). Keep the
  // polling loop alive long enough so the first Telegram message is not dropped.
  const deadline = Date.now() + Number(process.env.TELEGRAM_WAKE_WAIT_MS || "90000");
  while (Date.now() < deadline) {
    if (hasMatchingSseSession(botName, botsMap)) return true;
    await sleep(500);
  }
  return hasMatchingSseSession(botName, botsMap);
}

// --- Emit a channel message to every ready SSE session matching this bot. Returns true if delivered. ---
function deliverToReadySessions(
  botsMap: Map<string, BotContext>,
  botName: string,
  msg: any,
  botMentioned: boolean,
  isReplyToBot: boolean
): boolean {
  const aliases = getBotAliases(botName, botsMap);
  let delivered = false;
  for (const [, session] of sseSessions) {
    if (session.botName === null || aliases.includes(session.botName)) {
      // Use the session's own bot name so the agent sees its expected bot
      const effectiveBotName = session.botName || botName;
      emitChannelMessage(session.server, effectiveBotName, msg, botMentioned, isReplyToBot);
      delivered = true;
    }
  }
  return delivered;
}

// --- Post-delivery decoration: typing indicator + live status task. ---
function onDelivered(botsMap: Map<string, BotContext>, botName: string, msg: any) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  startTyping(botsMap, botName, chatId);
  if (statusManager && telemetryMode !== "silent") {
    const taskId = `${botName}:${chatId}:${Date.now()}`;
    statusManager.startTask({
      taskId,
      botName,
      chatId,
      sourceMessageId: msg.message_id || 0,
      mode: telemetryMode,
    }).catch((err) => log(`status startTask error: ${err}`));
  }
}

// --- Queue a message for replay when the agent's SSE session connects. ---
function enqueuePending(botName: string, msg: any, botMentioned: boolean, isReplyToBot: boolean): boolean {
  const queue = pendingByBot.get(botName) || [];
  const wasEmpty = queue.length === 0;
  if (queue.length >= PENDING_MAX_PER_BOT) {
    queue.shift(); // drop oldest to bound memory; never silently drop the newest
    log(`Pending queue for "${botName}" hit cap ${PENDING_MAX_PER_BOT}; dropped oldest`);
  }
  queue.push({ msg, botMentioned, isReplyToBot, enqueuedAt: Date.now() });
  pendingByBot.set(botName, queue);
  return wasEmpty;
}

// --- Replay queued messages to any ready session; expire stale ones (TTL). ---
function flushAllPending(botsMap: Map<string, BotContext>) {
  const now = Date.now();
  for (const [botName, queue] of [...pendingByBot]) {
    const fresh = queue.filter((p) => now - p.enqueuedAt <= PENDING_TTL_MS);
    const expired = queue.length - fresh.length;
    if (expired > 0) log(`Expired ${expired} stale pending message(s) for "${botName}"`);
    if (fresh.length === 0) { pendingByBot.delete(botName); continue; }
    if (!hasMatchingSseSession(botName, botsMap)) { pendingByBot.set(botName, fresh); continue; }
    const remaining: PendingMessage[] = [];
    let replayed = 0;
    for (const p of fresh) {
      const ok = deliverToReadySessions(botsMap, botName, p.msg, p.botMentioned, p.isReplyToBot);
      if (ok) { onDelivered(botsMap, botName, p.msg); replayed++; }
      else remaining.push(p);
    }
    if (remaining.length) pendingByBot.set(botName, remaining); else pendingByBot.delete(botName);
    if (replayed > 0) log(`Replayed ${replayed} pending message(s) to "${botName}"`);
  }
}

// --- Route channel message to matching SSE sessions; cold-start the agent if idle. ---
async function routeToSessions(
  botsMap: Map<string, BotContext>,
  botName: string,
  msg: any,
  botMentioned: boolean,
  isReplyToBot: boolean
) {
  const chatId = msg.chat?.id;
  const ready = await ensureSessionForDelivery(botName, botsMap);
  const aliases = getBotAliases(botName, botsMap);

  const delivered = ready && deliverToReadySessions(botsMap, botName, msg, botMentioned, isReplyToBot);

  if (delivered) {
    onDelivered(botsMap, botName, msg);
    return;
  }

  // Not ready yet: NEVER drop the message — queue it for replay when the agent's
  // SSE session connects (or the periodic sweeper picks it up). Tell the user the
  // honest truth instead of the old misleading "DevOps proverit po logam" string.
  const firstForBot = enqueuePending(botName, msg, botMentioned, isReplyToBot);
  log(`SSE session for "${botName}" not ready (aliases: ${aliases.join(",")}); message queued for replay`);
  if (chatId && firstForBot) {
    const bot = botsMap.get(botName);
    bot?.telegram
      .sendMessage(chatId, "⏳ Агент перезапускается после простоя — отвечу через ~минуту. Сообщение сохранил, повторять не нужно.")
      .catch(() => {});
  }
}

// --- Token alias tracking ---
// Maps token -> primary bot name (first bot registered with that token)
const tokenPrimaryBot = new Map<string, string>();
// Maps token -> all bot names sharing that token
const tokenAliases = new Map<string, string[]>();

// --- Initialize bots ---
async function initBots(config: ReturnType<typeof loadConfig>) {
  const botsMap = new Map<string, BotContext>();
  const runtimes: BotRuntime[] = [];
  const clientsByToken = new Map<string, TelegramClient>();

  for (const botEntry of config.bots) {
    log(`Connecting bot "${botEntry.name}"...`);

    // Share TelegramClient for bots with same token
    let telegram = clientsByToken.get(botEntry.token);
    if (!telegram) {
      telegram = new TelegramClient(botEntry.token);
      clientsByToken.set(botEntry.token, telegram);
    }

    // Track token aliases
    if (!tokenAliases.has(botEntry.token)) {
      tokenAliases.set(botEntry.token, []);
    }
    tokenAliases.get(botEntry.token)!.push(botEntry.name);

    const access = new AccessControl(botEntry.accessListPath);
    const permissions = new PermissionManager(telegram);

    try {
      const me = await telegram.getMe();
      log(`Bot "${botEntry.name}" connected: @${me.username} (${me.first_name})`);

      const ctx: BotContext = { name: botEntry.name, telegram, access, topicId: botEntry.topicId };
      botsMap.set(botEntry.name, ctx);

      // Only create runtime for the first bot per token (avoids duplicate polling)
      if (!tokenPrimaryBot.has(botEntry.token)) {
        tokenPrimaryBot.set(botEntry.token, botEntry.name);
        runtimes.push({
          ctx,
          permissions,
          me,
          botUsername: me.username?.toLowerCase() || "",
        });
      } else {
        log(`Bot "${botEntry.name}" shares token with "${tokenPrimaryBot.get(botEntry.token)}", skipping duplicate poll`);
      }
    } catch (err) {
      log(`Failed to connect bot "${botEntry.name}": ${err}`);
    }
  }

  if (runtimes.length === 0) {
    throw new Error("No bots connected successfully. Check your tokens.");
  }

  log(`${runtimes.length} bot(s) online (${botsMap.size} names, ${runtimes.length} unique tokens polling)`);
  return { botsMap, runtimes };
}

// --- SSE mode ---
async function startSseServer(
  port: number,
  runtimes: BotRuntime[],
  botsMap: Map<string, BotContext>,
  config: ReturnType<typeof loadConfig>
) {
  // Start polling (shared, one loop per bot)
  for (const runtime of runtimes) {
    startPolling(null, botsMap, runtime, config.groupPolicy, config.pollInterval, "sse");
  }

  // Periodic safety net: replay any queued messages to ready sessions and expire
  // stale ones, even if the on-connect replay hook was missed.
  setInterval(() => flushAllPending(botsMap), 15000);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // --- SSE endpoint ---
    if (req.method === "GET" && url.pathname === "/sse") {
      const botName = url.searchParams.get("bot") || null;
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      const server = createMcpServer(runtimes, botsMap, botName);

      sseSessions.set(sessionId, { id: sessionId, server, transport, botName });
      log(`SSE session ${sessionId} connected (bot: ${botName || "all"})`);

      res.on("close", () => {
        sseSessions.delete(sessionId);
        log(`SSE session ${sessionId} disconnected`);
      });

      await server.connect(transport);
      // The agent just (re)connected — replay any messages queued while it was
      // cold-starting. Small delay lets the MCP channel finish wiring up.
      setTimeout(() => flushAllPending(botsMap), 1500);
      return;
    }

    // --- POST messages ---
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("session_id") || url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing session_id");
        return;
      }

      const session = sseSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    // --- Live status feed from CLI wrapper (claude-tg pipes here) ---
    if (req.method === "POST" && url.pathname === "/status-feed") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body) as {
          botName?: string;
          chatId?: number;
          text?: string;
        };
        if (statusManager && data.chatId && data.text && data.botName) {
          const task = statusManager.findTaskByChatId(data.chatId, data.botName);
          if (!task) {
            // No active task — state is "replied" or idle. Skip per state machine.
            debug(`status-feed: no active task for ${data.botName}:${data.chatId}, skipping`);
          } else {
            statusManager.emitEvent({
              type: "thinking_updated",
              taskId: task.taskId,
              text: data.text,
            });
            // Override rendered text with raw CLI output
            const client = botsMap.get(task.botName)?.telegram;
            if (client && task.statusMessageId) {
              const renderedCode = formatStatusAsCodeBlock(data.text);
              if (renderedCode !== task.lastRenderedText) {
                try {
                  await client.editMessageText(
                    task.chatId,
                    task.statusMessageId,
                    renderedCode,
                    "HTML",
                  );
                  task.lastRenderedText = renderedCode;
                  task.lastRenderAt = Date.now();
                } catch (err) {
                  debug(`status-feed editMessageText failed for ${task.botName}:${task.chatId}: ${(err as Error).message}`);
                }
              }
            }
          }
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad json");
      }
      return;
    }

    // --- Inject mirror: scheduler posts a copy of every task injected into an
    // agent so the bot owner sees, in their chat with that bot, that the agent
    // received work. Called fire-and-forget from cron-task-scheduler.py right
    // after the tmux send-keys. Must never throw back at the caller and must not
    // leak any bot token (tokens stay inside this process). ---
    if (req.method === "POST" && url.pathname === "/inject-mirror") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body) as {
          botName?: string;
          text?: string;
          kind?: string;
        };
        const botName = typeof data.botName === "string" ? data.botName.trim() : "";
        const rawText = typeof data.text === "string" ? data.text.trim() : "";
        if (!botName || !rawText) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("missing botName or text");
          return;
        }
        const bot = botsMap.get(botName);
        if (!bot) {
          // Unknown bot — no-op (never crash the scheduler's fire-and-forget call).
          debug(`inject-mirror: unknown bot "${botName}", skipping`);
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("unknown bot");
          return;
        }
        // Owner's chat = first allowlisted user for this bot (resolved from the
        // bot's local private access config at runtime). Optional env fallback
        // for headless setups; if neither is present, skip — no real chat IDs
        // are hardcoded here so the repo stays sanitized.
        const envChat = Number(process.env.INJECT_MIRROR_DEFAULT_CHAT || "");
        const chatId =
          bot.access.listUsers()[0] ??
          (Number.isFinite(envChat) && envChat !== 0 ? envChat : 0);
        if (!chatId) {
          debug(`inject-mirror: no allowlisted chat for bot "${botName}", skipping`);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("no chat");
          return;
        }
        // Phone-friendly copy: truncate long prompts, do not paste the full payload.
        const MAX = 400;
        const clipped =
          rawText.length > MAX ? rawText.slice(0, MAX).trimEnd() + " …" : rawText;
        const message = `🔻 Агент ${botName} получил задачу:\n\n${clipped}`;
        try {
          // Plain text (parseMode ""): task titles/prompts may contain Markdown
          // metacharacters; we must not let them break or reinterpret the copy.
          const sent = await bot.telegram.sendMessage(chatId, message, "");
          logConversation({
            botName,
            direction: "system",
            chatId,
            messageId: sent?.message_id,
            text: message,
            meta: { kind: "inject-mirror", injectKind: data.kind || "cron" },
          });
        } catch (err) {
          debug(
            `inject-mirror sendMessage failed for ${botName}:${chatId}: ${(err as Error).message}`,
          );
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad json");
      }
      return;
    }

    // --- Health check ---
    if (req.method === "GET" && url.pathname === "/health") {
      const info = {
        status: "ok",
        sessions: sseSessions.size,
        bots: Array.from(botsMap.keys()),
        typing: typingIntervals.size,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(port, "127.0.0.1", () => {
    log(`SSE server listening on http://127.0.0.1:${port}`);
    log(`Connect agents with: "url": "http://127.0.0.1:${port}/sse?bot=BOT_NAME"`);
  });

  process.on("SIGINT", () => shutdown(httpServer));
  process.on("SIGTERM", () => shutdown(httpServer));
}

async function shutdown(httpServer: http.Server) {
  log("Shutting down...");
  for (const [id, session] of sseSessions) {
    try {
      await session.transport.close();
    } catch {}
    sseSessions.delete(id);
  }
  for (const [key, interval] of typingIntervals) {
    clearInterval(interval);
    typingIntervals.delete(key);
  }
  httpServer.close();
  process.exit(0);
}

// --- Stdio mode (backward compat) ---
async function startStdioServer(
  runtimes: BotRuntime[],
  botsMap: Map<string, BotContext>,
  config: ReturnType<typeof loadConfig>
) {
  const server = createMcpServer(runtimes, botsMap);

  log("Connecting stdio transport...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server started on stdio");

  process.stdin.on("end", () => { log("stdin closed, exiting"); process.exit(0); });
  process.stdin.on("close", () => { log("stdin closed, exiting"); process.exit(0); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { log(`Received ${sig}, exiting`); process.exit(0); });
  }

  for (const runtime of runtimes) {
    startPolling(server, botsMap, runtime, config.groupPolicy, config.pollInterval, "stdio");
  }
}

// --- Polling ---
function startPolling(
  stdioServer: Server | null,
  botsMap: Map<string, BotContext>,
  runtime: BotRuntime,
  groupPolicy: GroupPolicy,
  pollInterval: number,
  mode: "stdio" | "sse"
) {
  const { ctx, permissions, me, botUsername } = runtime;
  const { name: botName, telegram, access } = ctx;
  const pairingNotified = new Set<number>();

  // Fleet outgoing-only guard: worker processes (CEO_AGENT_OUTGOING_ONLY=1) must
  // NOT start a second getUpdates loop on the shared bot token (Telegram returns
  // 409 Conflict for a 2nd poller). They still SEND via send_telegram_message
  // over the SSE bridge. Unset/empty => normal polling, so the base and the 11
  // existing bots are unaffected.
  if (isOutgoingOnly()) {
    log(`[${botName}] Outgoing-only mode: inbound polling disabled (worker process)`);
    return;
  }

  const poll = async () => {
    await telegram.deleteWebhook(true);
    let offset: number | undefined;

    const pending = await telegram.getUpdates(undefined, 0, 100);
    if (pending.length > 0) {
      offset = pending[pending.length - 1].update_id + 1;
      log(`[${botName}] Skipped ${pending.length} old update(s)`);
    }
    log(`[${botName}] Polling started (${mode} mode)`);

    while (true) {
      try {
        const updates = await telegram.getUpdates(offset, 1);

        for (const update of updates) {
          offset = update.update_id + 1;

          // --- Single-bot Forum Topics routing ---
          let activeBotName = botName;
          let activeCtx = ctx;
          let activeAccess = access;
          let activePermissions = permissions;

          const msgForTopic = update.message || update.callback_query?.message;
          if (msgForTopic && typeof msgForTopic.message_thread_id === "number") {
            for (const [name, bCtx] of botsMap.entries()) {
              if (bCtx.topicId === msgForTopic.message_thread_id) {
                activeBotName = name;
                activeCtx = bCtx;
                activeAccess = bCtx.access;
                break;
              }
            }
          }

          // --- Inline-button tap (callback_query) ---
          // Forward the tap to the agent over the SAME inbound path normal text
          // uses, then ALWAYS ack to stop Telegram's client-side spinner. The
          // bridge never manages fleet/reply-target state itself — the agent
          // acts on the `[button] <data>` marker via its own MCP. Fully opt-in:
          // updates of this type only arrive once an inline button was sent.
          if (update.callback_query && !update.message) {
            const cbq = update.callback_query;
            try {
              const synthetic = synthesizeCallbackMessage(cbq);
              if (synthetic) {
                const cbUserId = cbq.from?.id;
                const cbChatId = cbq.message?.chat?.id;
                // Honor access control just like a normal private inbound: only
                // deliver taps from a paired user; otherwise ack + ignore.
                if (
                  cbUserId !== undefined &&
                  cbChatId !== undefined &&
                  activeAccess.isAllowed(cbUserId, cbChatId)
                ) {
                  logConversation({
                    botName: activeBotName,
                    direction: "inbound",
                    chatId: cbChatId,
                    userId: cbUserId,
                    username: cbq.from?.username || cbq.from?.first_name || "unknown",
                    messageId: synthetic.message_id,
                    chatType: synthetic.chat.type || "private",
                    text: synthetic.text || "",
                    meta: { isGroup: false, callbackQuery: true },
                  });
                  log(`[${activeBotName}] Inline button tap from @${cbq.from?.username || cbq.from?.first_name}: ${synthetic.text}`);
                  if (mode === "stdio" && stdioServer) {
                    emitChannelMessage(stdioServer, activeBotName, synthetic, false, false);
                  } else {
                    routeToSessions(botsMap, activeBotName, synthetic, false, false);
                  }
                } else {
                  log(`[${activeBotName}] Inline button tap ignored (user not allowed or no chat context)`);
                }
              } else {
                log(`[${activeBotName}] Inline button tap with no routable chat context; acking only`);
              }
            } catch (cbErr) {
              log(`[${activeBotName}] callback_query handling error: ${cbErr}`);
            }
            // Always acknowledge so the user's button spinner stops, even on
            // ignore/error. Never throw out of the poll loop for an ack failure.
            try {
              await telegram.answerCallbackQuery(cbq.id);
            } catch (ackErr) {
              log(`[${activeBotName}] answerCallbackQuery failed: ${ackErr}`);
            }
            continue;
          }

          if (!update.message?.from) continue;

          const msg = update.message;
          if (!msg.text && !msg.photo && !msg.document && !msg.voice && !msg.audio && !msg.contact) continue;

          const userId = msg.from!.id;
          const chatType = msg.chat.type || "private";
          const isGroup = ["group", "supergroup", "channel"].includes(chatType);

          // --- Group chat ---
          if (isGroup) {
            const msgText = (msg.text || msg.caption || "").toLowerCase();
            const entities = msg.entities || msg.caption_entities || [];

            const mentionedInText = botUsername ? msgText.includes(`@${botUsername}`) : false;
            const mentionedViaEntity = entities.some((e) => {
              if (e.type === "mention") {
                const slice = (msg.text || msg.caption || "").substring(e.offset, e.offset + e.length).toLowerCase();
                return slice === `@${botUsername}`;
              }
              if (e.type === "text_mention" && e.user) {
                return e.user.id === me.id;
              }
              return false;
            });

            let botMentioned = mentionedInText || mentionedViaEntity;
            if (msg.message_thread_id !== undefined && msg.message_thread_id === activeCtx.topicId) {
              botMentioned = true;
            }
            const isReplyToBot = !!(msg.reply_to_message?.from?.id === me.id);

            if (groupPolicy === "mention-only" && !botMentioned && !isReplyToBot) continue;
            if (groupPolicy === "allowlist" && !activeAccess.isAllowed(userId, msg.chat.id)) continue;

            let text = msg.text || msg.caption || "";
            if (botUsername && text.toLowerCase().includes(`@${botUsername}`)) {
              text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
            }

            text = await enrichMedia(telegram, msg, text, activeBotName);
            if (!text || text.trim() === "") text = "[message received - no text content]";
            (msg as unknown as Record<string, unknown>).text = text;

            const permResult = activePermissions.tryMatch(text);
            if (permResult) {
              if (mode === "stdio" && stdioServer) {
                emitPermissionResponse(stdioServer, permResult.requestId, permResult.approved);
              } else {
                // Broadcast to all sessions for this bot
                for (const [, session] of sseSessions) {
                  if (session.botName === null || session.botName === activeBotName) {
                    emitPermissionResponse(session.server, permResult.requestId, permResult.approved);
                  }
                }
              }
              const emoji = permResult.approved ? "\u2705" : "\u274C";
              await telegram.sendMessage(msg.chat.id, `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`, "Markdown", undefined, msg.message_thread_id);
              continue;
            }

            // Passthrough (any `/<cmd>`) is only allowed to sender who is on the access list
            // for this chat — an un-paired group member can still send the legacy static
            // triggers (/stop, /status, /compact), preserving v3.1.x behavior.
            const groupAllowPassthrough = activeAccess.isAllowed(userId, msg.chat.id);
            const stopReply = await tryHandleCommand(activeBotName, msg.chat.id, text, { allowPassthrough: groupAllowPassthrough });
            if (stopReply) {
              await telegram.sendMessage(msg.chat.id, stopReply, "Markdown", undefined, msg.message_thread_id);
              continue;
            }

            logConversation({
              botName: activeBotName,
              direction: "inbound",
              chatId: msg.chat.id,
              userId,
              username: msg.from!.username || msg.from!.first_name,
              messageId: msg.message_id,
              chatType,
              text,
              meta: {
                isGroup: true,
                chatTitle: msg.chat.title || msg.chat.username || "",
                botMentioned,
                isReplyToBot,
              },
            });
            log(`[${activeBotName}] Group msg from @${msg.from!.username || msg.from!.first_name} in "${msg.chat.title || msg.chat.id}"`);

            {
              const deliver = () => {
                if (mode === "stdio" && stdioServer) {
                  emitChannelMessage(stdioServer, activeBotName, msg, botMentioned, isReplyToBot);
                } else {
                  routeToSessions(botsMap, activeBotName, msg, botMentioned, isReplyToBot);
                }
              };
              const triggerCompact = () => {
                tryHandleCommand(activeBotName, msg.chat.id, "compact").catch((err) =>
                  log(`[${activeBotName}] auto-compact trigger error: ${err}`)
                );
              };
              const gated = await maybeGate(activeBotName, msg.chat.id, triggerCompact, deliver);
              if (!gated) deliver();
            }
            continue;
          }

          // --- Private chat ---
          let text = msg.text || msg.caption || "";
          text = await enrichMedia(telegram, msg, text, activeBotName);
          if (!text || text.trim() === "") text = "[message received - no text content]";
          (msg as unknown as Record<string, unknown>).text = text;

          const permResult = activePermissions.tryMatch(text);
          if (permResult) {
            if (mode === "stdio" && stdioServer) {
              emitPermissionResponse(stdioServer, permResult.requestId, permResult.approved);
            } else {
              for (const [, session] of sseSessions) {
                if (session.botName === null || session.botName === activeBotName) {
                  emitPermissionResponse(session.server, permResult.requestId, permResult.approved);
                }
              }
            }
            const emoji = permResult.approved ? "\u2705" : "\u274C";
            await telegram.sendMessage(msg.chat.id, `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`, "Markdown", undefined, msg.message_thread_id);
            continue;
          }

          if (!activeAccess.isAllowed(userId, msg.chat.id)) {
            if (!pairingNotified.has(userId)) {
              pairingNotified.add(userId);
              const code = activeAccess.generatePairingCode(userId, msg.chat.id);
              log(`[${activeBotName}] Pairing code "${code}" for user ${userId}`);
              await telegram.sendMessage(msg.chat.id, `\`pair code ${code}\``, "Markdown", undefined, msg.message_thread_id);
            }
            continue;
          }

          const stopReply = await tryHandleCommand(activeBotName, msg.chat.id, text);
          if (stopReply) {
            await telegram.sendMessage(msg.chat.id, stopReply, "Markdown", undefined, msg.message_thread_id);
            continue;
          }

          pairingNotified.delete(userId);
          logConversation({
            botName: activeBotName,
            direction: "inbound",
            chatId: msg.chat.id,
            userId,
            username: msg.from!.username || msg.from!.first_name,
            messageId: msg.message_id,
            chatType,
            text,
            meta: { isGroup: false },
          });
          log(`[${activeBotName}] DM from @${msg.from!.username || msg.from!.first_name}: ${text.substring(0, 50)}...`);

          {
            const deliver = () => {
              if (mode === "stdio" && stdioServer) {
                emitChannelMessage(stdioServer, activeBotName, msg, false, false);
              } else {
                routeToSessions(botsMap, activeBotName, msg, false, false);
              }
            };
            const triggerCompact = () => {
              tryHandleCommand(activeBotName, msg.chat.id, "compact").catch((err) =>
                log(`[${activeBotName}] auto-compact trigger error: ${err}`)
              );
            };
            const gated = await maybeGate(activeBotName, msg.chat.id, triggerCompact, deliver);
            if (!gated) deliver();
          }
        }
      } catch (err) {
        log(`[${botName}] Polling error: ${err}`);
      }

      await sleep(pollInterval);
    }
  };

  poll().catch((err) => {
    log(`[${botName}] Fatal polling error: ${err}`);
  });
}

async function transcribeAudioFile(filePath: string, botName: string): Promise<string | null> {
  if (process.env.TELEGRAM_STT_ENABLED === "0") return null;

  const apiKey = process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log(`[${botName}] OpenAI STT skipped: missing VOICE_TOOLS_OPENAI_KEY/OPENAI_API_KEY`);
    return null;
  }

  const fs = await import("node:fs/promises");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TRANSCRIPTIONS_TIMEOUT_MS);

  try {
    const data = await fs.readFile(filePath);
    const fileName = filePath.split("/").pop() || "audio.ogg";
    const form = new FormData();
    form.append("file", new Blob([data]), fileName);
    form.append("model", OPENAI_TRANSCRIPTIONS_MODEL);
    if (OPENAI_TRANSCRIPTIONS_LANGUAGE) form.append("language", OPENAI_TRANSCRIPTIONS_LANGUAGE);

    const res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`[${botName}] OpenAI STT failed: HTTP ${res.status} ${res.statusText} ${body.slice(0, 500)}`);
      return null;
    }

    const json = (await res.json()) as { text?: string; error?: unknown };
    const transcript = (json.text || "").trim();
    if (!transcript) {
      log(`[${botName}] OpenAI STT completed with empty transcript for ${filePath}`);
      return null;
    }

    log(`[${botName}] OpenAI STT ok for ${filePath} (${OPENAI_TRANSCRIPTIONS_MODEL})`);
    return transcript;
  } catch (err) {
    log(`[${botName}] OpenAI STT exec failed for ${filePath}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichMedia(
  telegram: TelegramClient,
  msg: { photo?: any[]; document?: any; voice?: any; audio?: any; contact?: any; caption?: string; text?: string },
  text: string,
  botName: string
): Promise<string> {
  const fs = await import("node:fs/promises");

  if (msg.contact) {
    const c = msg.contact;
    const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    const parts = [
      `[contact card: name="${fullName || c.first_name || "unknown"}"`,
      `phone="${c.phone_number || ""}"`,
      c.user_id ? `telegram_user_id=${c.user_id}` : null,
      c.vcard ? `vcard=${JSON.stringify(String(c.vcard))}` : null,
    ].filter(Boolean);
    text = `${parts.join(" ")}]${text ? "\n" + text : ""}`;
    log(`[${botName}] Contact card received: ${fullName || c.first_name || "unknown"}`);
  }

  if (msg.photo && msg.photo.length > 0) {
    try {
      const largest = msg.photo[msg.photo.length - 1];
      const fileInfo = await telegram.getFile(largest.file_id);
      const fileData = await telegram.downloadFile(fileInfo.file_path);
      const ext = fileInfo.file_path.split(".").pop() || "jpg";
      const tmpPath = `/tmp/tg-photo-${largest.file_unique_id}.${ext}`;
      await fs.writeFile(tmpPath, fileData);
      const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
      text = `[photo saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
      log(`[${botName}] Photo saved: ${tmpPath}`);
    } catch (err) {
      log(`[${botName}] Failed to download photo: ${err}`);
      text = `[photo - download failed]${text ? "\n" + text : ""}`;
    }
  }

  if (msg.document) {
    try {
      const doc = msg.document;
      const fileInfo = await telegram.getFile(doc.file_id);
      const fileData = await telegram.downloadFile(fileInfo.file_path);
      const fileName = doc.file_name || `document.${doc.mime_type?.split("/")[1] || "bin"}`;
      const tmpPath = `/tmp/tg-doc-${doc.file_unique_id}-${fileName}`;
      await fs.writeFile(tmpPath, fileData);
      const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
      text = `[document: ${fileName} (${doc.mime_type || "unknown"}) saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
      log(`[${botName}] Document saved: ${tmpPath}`);
    } catch (err) {
      log(`[${botName}] Failed to download document: ${err}`);
      text = `[document: ${msg.document.file_name || "unknown"} - download failed]${text ? "\n" + text : ""}`;
    }
  }

  if (msg.voice) {
    try {
      const voice = msg.voice;
      const fileInfo = await telegram.getFile(voice.file_id);
      const fileData = await telegram.downloadFile(fileInfo.file_path);
      const ext = fileInfo.file_path.split(".").pop() || "ogg";
      const tmpPath = `/tmp/tg-voice-${voice.file_unique_id}.${ext}`;
      await fs.writeFile(tmpPath, fileData);
      const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
      const duration = voice.duration ? ` duration=${voice.duration}s` : "";
      const transcript = await transcribeAudioFile(tmpPath, botName);
      const voicePrefix = transcript
        ? `[voice transcript${duration}; audio saved to ${tmpPath}${caption}]\n${transcript}`
        : `[voice saved to ${tmpPath}${duration}; transcript unavailable${caption}]`;
      text = `${voicePrefix}${text ? "\n" + text : ""}`;
      log(`[${botName}] Voice saved: ${tmpPath}`);
    } catch (err) {
      log(`[${botName}] Failed to download voice: ${err}`);
      text = `[voice - download failed]${text ? "\n" + text : ""}`;
    }
  }

  if (msg.audio) {
    try {
      const audio = msg.audio;
      const fileInfo = await telegram.getFile(audio.file_id);
      const fileData = await telegram.downloadFile(fileInfo.file_path);
      const fileName = audio.file_name || `audio.${fileInfo.file_path.split(".").pop() || "bin"}`;
      const tmpPath = `/tmp/tg-audio-${audio.file_unique_id}-${fileName}`;
      await fs.writeFile(tmpPath, fileData);
      const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
      const duration = audio.duration ? ` duration=${audio.duration}s` : "";
      const transcript = await transcribeAudioFile(tmpPath, botName);
      const audioPrefix = transcript
        ? `[audio transcript: ${fileName}${duration}; audio saved to ${tmpPath}${caption}]\n${transcript}`
        : `[audio: ${fileName} saved to ${tmpPath}${duration}; transcript unavailable${caption}]`;
      text = `${audioPrefix}${text ? "\n" + text : ""}`;
      log(`[${botName}] Audio saved: ${tmpPath}`);
    } catch (err) {
      log(`[${botName}] Failed to download audio: ${err}`);
      text = `[audio: ${msg.audio.file_name || "unknown"} - download failed]${text ? "\n" + text : ""}`;
    }
  }

  return text;
}

// Logging is imported from logger.ts at the top of the file.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---
async function main() {
  log("Starting MCP server...");
  const config = loadConfig();
  log(`Loaded ${config.bots.length} bot(s): ${config.bots.map((b) => b.name).join(", ")}`);

  const { botsMap, runtimes } = await initBots(config);

  // Initialize status manager with access to bot clients.
  statusManager = new StatusManager((botName) => botsMap.get(botName)?.telegram);

  // Periodic GC of old finished tasks.
  setInterval(() => statusManager?.gc(), STATUS_GC_INTERVAL_MS);

  const transport = process.env.TRANSPORT || (process.env.PORT ? "sse" : "stdio");
  const port = parseInt(process.env.PORT || String(DEFAULT_SSE_PORT));

  if (transport === "sse") {
    await startSseServer(port, runtimes, botsMap, config);
  } else {
    await startStdioServer(runtimes, botsMap, config);
  }
}

main().catch((err) => {
  process.stderr.write(`[telegram-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
