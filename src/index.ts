#!/usr/bin/env node

import http from "node:http";
import * as fsSync from "node:fs";
import { execFileSync } from "node:child_process";
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
import { log, debug } from "./logger.js";
import { TYPING_INTERVAL_MS, TYPING_TIMEOUT_MS, DEFAULT_SSE_PORT, STATUS_GC_INTERVAL_MS } from "./constants.js";
import { StatusManager, loadTelemetryConfig, type VerbosityMode } from "./status-messages.js";

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

// --- Status manager (live status messages per ТЗ) ---
let statusManager: StatusManager | null = null;
let telemetryMode: VerbosityMode = "status";

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
  botsMap: Map<string, BotContext>
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

  registerTools(server, botsMap, stopTyping, statusManager);

  server.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "notifications/claude/channel/permission_request") {
      return;
    }

    const params = notification.params as Record<string, unknown> | undefined;
    if (!params) return;

    const requestId = params.requestId as string;
    const toolName = params.toolName as string;
    const description = params.description as string;

    for (const runtime of runtimes) {
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

// --- Stop command: send ESC to the claude CLI running in tmux ---
const STOP_PATTERN = /^\s*(stop|стоп|esc|escape|\/stop)\s*$/i;

function tryHandleStop(botName: string, chatId: number, text: string): string | null {
  if (!STOP_PATTERN.test(text)) return null;
  try {
    // Check whether the tmux session exists (non-zero exit = no session)
    try {
      execFileSync("tmux", ["has-session", "-t", botName], { timeout: 3000 });
    } catch {
      return `❌ No tmux session '${botName}' — claude-tg not running`;
    }
    // Send Escape key to cancel the current turn
    execFileSync("tmux", ["send-keys", "-t", botName, "Escape"], { timeout: 3000 });
    log(`[${botName}] ESC sent via tmux send-keys`);
    // Finalize the active task for this chat so the next user message gets a fresh status message
    if (statusManager) {
      const task = statusManager.findTaskByChatId(chatId);
      if (task) {
        statusManager.finishTask(task.taskId);
        log(`[${botName}] finalized task ${task.taskId} on stop`);
      }
    }
    // Stop the typing indicator from the interrupted turn
    stopTyping(botName, chatId);
    return "🛑 Interrupted (ESC sent to claude via tmux)";
  } catch (err: any) {
    return `❌ Stop failed: ${err.message}`;
  }
}

// --- Get all bot names that share a token with the given bot ---
function getBotAliases(botName: string, botsMap: Map<string, BotContext>): string[] {
  const bot = botsMap.get(botName);
  if (!bot) return [botName];

  // Find the token for this bot by checking tokenAliases
  for (const [, aliases] of tokenAliases) {
    if (aliases.includes(botName)) {
      return aliases;
    }
  }
  return [botName];
}

// --- Route channel message to matching SSE sessions ---
function routeToSessions(
  botsMap: Map<string, BotContext>,
  botName: string,
  msg: any,
  botMentioned: boolean,
  isReplyToBot: boolean
) {
  const chatId = msg.chat?.id;
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

  if (delivered && chatId) {
    startTyping(botsMap, botName, chatId);

    // Create live status message for this task.
    if (statusManager && telemetryMode !== "silent") {
      const taskId = `${botName}:${chatId}:${Date.now()}`;
      const msgId = msg.message_id || 0;
      statusManager.startTask({
        taskId,
        botName,
        chatId,
        sourceMessageId: msgId,
        mode: telemetryMode,
      }).catch((err) => log(`status startTask error: ${err}`));
    }
  }

  if (!delivered) {
    log(`No SSE session for bot "${botName}" (aliases: ${aliases.join(",")}), message dropped`);
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

      const ctx: BotContext = { name: botEntry.name, telegram, access };
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

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // --- SSE endpoint ---
    if (req.method === "GET" && url.pathname === "/sse") {
      const botName = url.searchParams.get("bot") || null;
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      const server = createMcpServer(runtimes, botsMap);

      sseSessions.set(sessionId, { id: sessionId, server, transport, botName });
      log(`SSE session ${sessionId} connected (bot: ${botName || "all"})`);

      res.on("close", () => {
        sseSessions.delete(sessionId);
        log(`SSE session ${sessionId} disconnected`);
      });

      await server.connect(transport);
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
        if (statusManager && data.chatId && data.text) {
          const task = statusManager.findTaskByChatId(data.chatId);
          if (task) {
            statusManager.emitEvent({
              type: "thinking_updated",
              taskId: task.taskId,
              text: data.text,
            });
            // Override rendered text with raw CLI output
            const client = botsMap.get(task.botName)?.telegram;
            if (client && task.statusMessageId) {
              const trimmed = data.text.slice(-3500); // Telegram limit ~4096
              if (trimmed !== task.lastRenderedText) {
                try {
                  await client.editMessageText(
                    task.chatId,
                    task.statusMessageId,
                    `\`\`\`\n${trimmed}\n\`\`\``,
                  );
                  task.lastRenderedText = trimmed;
                  task.lastRenderAt = Date.now();
                } catch {}
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

          if (!update.message?.from) continue;

          const msg = update.message;
          if (!msg.text && !msg.photo && !msg.document) continue;

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

            const botMentioned = mentionedInText || mentionedViaEntity;
            const isReplyToBot = !!(msg.reply_to_message?.from?.id === me.id);

            if (groupPolicy === "mention-only" && !botMentioned && !isReplyToBot) continue;
            if (groupPolicy === "allowlist" && !access.isAllowed(userId, msg.chat.id)) continue;

            let text = msg.text || msg.caption || "";
            if (botUsername && text.toLowerCase().includes(`@${botUsername}`)) {
              text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
            }

            text = await enrichMedia(telegram, msg, text, botName);
            if (!text || text.trim() === "") text = "[message received - no text content]";
            (msg as unknown as Record<string, unknown>).text = text;

            const permResult = permissions.tryMatch(text);
            if (permResult) {
              if (mode === "stdio" && stdioServer) {
                emitPermissionResponse(stdioServer, permResult.requestId, permResult.approved);
              } else {
                // Broadcast to all sessions for this bot
                for (const [, session] of sseSessions) {
                  if (session.botName === null || session.botName === botName) {
                    emitPermissionResponse(session.server, permResult.requestId, permResult.approved);
                  }
                }
              }
              const emoji = permResult.approved ? "\u2705" : "\u274C";
              await telegram.sendMessage(msg.chat.id, `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`);
              continue;
            }

            const stopReply = tryHandleStop(botName, msg.chat.id, text);
            if (stopReply) {
              await telegram.sendMessage(msg.chat.id, stopReply);
              continue;
            }

            log(`[${botName}] Group msg from @${msg.from!.username || msg.from!.first_name} in "${msg.chat.title || msg.chat.id}"`);

            if (mode === "stdio" && stdioServer) {
              emitChannelMessage(stdioServer, botName, msg, botMentioned, isReplyToBot);
            } else {
              routeToSessions(botsMap, botName, msg, botMentioned, isReplyToBot);
            }
            continue;
          }

          // --- Private chat ---
          let text = msg.text || msg.caption || "";
          text = await enrichMedia(telegram, msg, text, botName);
          if (!text || text.trim() === "") text = "[message received - no text content]";
          (msg as unknown as Record<string, unknown>).text = text;

          const permResult = permissions.tryMatch(text);
          if (permResult) {
            if (mode === "stdio" && stdioServer) {
              emitPermissionResponse(stdioServer, permResult.requestId, permResult.approved);
            } else {
              for (const [, session] of sseSessions) {
                if (session.botName === null || session.botName === botName) {
                  emitPermissionResponse(session.server, permResult.requestId, permResult.approved);
                }
              }
            }
            const emoji = permResult.approved ? "\u2705" : "\u274C";
            await telegram.sendMessage(msg.chat.id, `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`);
            continue;
          }

          if (!access.isAllowed(userId, msg.chat.id)) {
            if (!pairingNotified.has(userId)) {
              pairingNotified.add(userId);
              const code = access.generatePairingCode(userId, msg.chat.id);
              log(`[${botName}] Pairing code "${code}" for user ${userId}`);
              await telegram.sendMessage(msg.chat.id, `\`pair code ${code}\``);
            }
            continue;
          }

          const stopReply = tryHandleStop(botName, msg.chat.id, text);
          if (stopReply) {
            await telegram.sendMessage(msg.chat.id, stopReply);
            continue;
          }

          pairingNotified.delete(userId);
          log(`[${botName}] DM from @${msg.from!.username || msg.from!.first_name}: ${text.substring(0, 50)}...`);

          if (mode === "stdio" && stdioServer) {
            emitChannelMessage(stdioServer, botName, msg, false, false);
          } else {
            routeToSessions(botsMap, botName, msg, false, false);
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

async function enrichMedia(
  telegram: TelegramClient,
  msg: { photo?: any[]; document?: any; caption?: string; text?: string },
  text: string,
  botName: string
): Promise<string> {
  const fs = await import("node:fs/promises");

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
