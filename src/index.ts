#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { AccessControl } from "./access.js";
import { PermissionManager } from "./permissions.js";
import { emitChannelMessage, emitPermissionResponse } from "./channel.js";
import { registerTools } from "./tools.js";

async function main() {
  log("Starting MCP server...");
  const config = loadConfig();
  log(`Config loaded: bot="${config.botName}", accessList="${config.accessListPath}", poll=${config.pollInterval}ms`);
  debug(`Token prefix: ${config.botToken.substring(0, 10)}...`);

  const telegram = new TelegramClient(config.botToken);
  const access = new AccessControl(config.accessListPath);
  const permissions = new PermissionManager(telegram);

  // Verify bot token
  log("Verifying bot token with Telegram API...");
  const me = await telegram.getMe();
  log(`Bot connected: @${me.username} (${me.first_name})`);
  debug(`Bot ID: ${me.id}, is_bot: ${me.is_bot}`);
  log(`Group policy: ${config.groupPolicy}`);

  const botUsername = me.username?.toLowerCase() || "";

  // Create MCP server
  const server = new Server(
    {
      name: `telegram-channel-${config.botName}`,
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
        `This is a Telegram channel plugin (bot: "${config.botName}").`,
        `When a user asks you to pair with a code (e.g. "pair code abc123"), call the telegram_access tool with action "pair" and the code.`,
        `Do NOT run "claude pair" shell command — that is an unrelated pair-coding feature.`,
        `Use send_telegram_message to reply to Telegram users. The chat_id comes from channel message metadata.`,
      ].join("\n"),
    }
  );

  // Register tools
  registerTools(server, telegram, access, config.botName);

  // Handle permission requests from Claude Code via fallback notification handler
  server.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== "notifications/claude/channel/permission_request") {
      return;
    }

    const params = notification.params as Record<string, unknown> | undefined;
    if (!params) return;

    const requestId = params.requestId as string;
    const toolName = params.toolName as string;
    const description = params.description as string;

    // Forward to all allowed users
    const users = access.listUsers();
    if (users.length === 0) {
      log("Permission request received but no paired users to forward to");
      return;
    }

    for (const userId of users) {
      try {
        await permissions.forwardRequest(userId, requestId, toolName, description);
      } catch (err) {
        log(`Failed to forward permission request to user ${userId}: ${err}`);
      }
    }
  };

  // Start stdio transport
  log("Connecting stdio transport...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server started on stdio");
  debug(`Server name: telegram-channel-${config.botName}`);

  // Exit when parent (Claude Code) closes stdin
  process.stdin.on("end", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
  process.stdin.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });

  // Exit on signals
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      log(`Received ${sig}, exiting`);
      process.exit(0);
    });
  }

  // Start polling — claim exclusive polling access and flush old updates
  log("Deleting webhook and flushing old updates...");
  await telegram.deleteWebhook(true);
  let offset: number | undefined;

  // Skip any messages that arrived before this session
  const pending = await telegram.getUpdates(undefined, 0, 100);
  if (pending.length > 0) {
    offset = pending[pending.length - 1].update_id + 1;
    log(`Skipped ${pending.length} old update(s)`);
  } else {
    debug("No pending updates to skip");
  }
  log("Polling started");

  // Track users who have already been notified about pairing (debounce)
  const pairingNotified = new Set<number>();

  const poll = async () => {
    while (true) {
      try {
        const updates = await telegram.getUpdates(offset, 1);
        if (updates.length > 0) {
          debug(`Got ${updates.length} update(s)`);
        }

        for (const update of updates) {
          offset = update.update_id + 1;

          if (!update.message?.from) {
            debug(`Skipping update ${update.update_id}: no from`);
            continue;
          }

          // Accept text, photo, document messages; skip everything else
          const msg = update.message;
          if (!msg.text && !msg.photo && !msg.document) {
            debug(`Skipping update ${update.update_id}: not text/photo/document`);
            continue;
          }

          const userId = msg.from!.id;
          const chatType = msg.chat.type || "private";
          const isGroup = ["group", "supergroup", "channel"].includes(chatType);

          // --- Group policy check ---
          if (isGroup) {
            const msgText = (msg.text || msg.caption || "").toLowerCase();
            const entities = msg.entities || msg.caption_entities || [];

            // Detect bot mention via @username in text
            const mentionedInText = botUsername
              ? msgText.includes(`@${botUsername}`)
              : false;

            // Detect bot mention via mention entity (works for private/public bots)
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

            // Detect reply to bot message
            const isReplyToBot = !!(
              msg.reply_to_message?.from?.id === me.id
            );

            if (config.groupPolicy === "mention-only" && !botMentioned && !isReplyToBot) {
              debug(`Skipping group message (mention-only policy, bot not mentioned): chat=${msg.chat.id}`);
              continue;
            }

            if (config.groupPolicy === "allowlist" && !access.isAllowed(userId, msg.chat.id)) {
              debug(`Skipping group message (allowlist policy, user ${userId} / chat ${msg.chat.id} not allowed)`);
              continue;
            }
            // "open" policy: fall through to normal processing

            // Build text content including media info
            let text = msg.text || msg.caption || "";

            // Strip bot mention from text so agent sees clean command
            if (botUsername && text.toLowerCase().includes(`@${botUsername}`)) {
              text = text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
            }

            // Handle photo
            if (msg.photo && msg.photo.length > 0) {
              try {
                const largest = msg.photo[msg.photo.length - 1];
                const fileInfo = await telegram.getFile(largest.file_id);
                const fileData = await telegram.downloadFile(fileInfo.file_path);
                const ext = fileInfo.file_path.split(".").pop() || "jpg";
                const tmpPath = `/tmp/tg-photo-${largest.file_unique_id}.${ext}`;
                const fs = await import("node:fs/promises");
                await fs.writeFile(tmpPath, fileData);
                const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
                text = `[photo saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
                log(`Photo saved: ${tmpPath}`);
              } catch (err) {
                log(`Failed to download photo: ${err}`);
                text = `[photo - download failed]${text ? "\n" + text : ""}`;
              }
            }

            // Handle document
            if (msg.document) {
              try {
                const doc = msg.document;
                const fileInfo = await telegram.getFile(doc.file_id);
                const fileData = await telegram.downloadFile(fileInfo.file_path);
                const fileName = doc.file_name || `document.${doc.mime_type?.split("/")[1] || "bin"}`;
                const tmpPath = `/tmp/tg-doc-${doc.file_unique_id}-${fileName}`;
                const fs = await import("node:fs/promises");
                await fs.writeFile(tmpPath, fileData);
                const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
                text = `[document: ${fileName} (${doc.mime_type || "unknown"}) saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
                log(`Document saved: ${tmpPath}`);
              } catch (err) {
                log(`Failed to download document: ${err}`);
                text = `[document: ${msg.document.file_name || "unknown"} - download failed]${text ? "\n" + text : ""}`;
              }
            }

            if (!text || text.trim() === "") {
              text = "[message received - no text content]";
            }

            (msg as unknown as Record<string, unknown>).text = text;

            debug(`Group message: user=${userId} (@${msg.from!.username || msg.from!.first_name}) mentioned=${botMentioned} reply=${isReplyToBot} text="${text.substring(0, 80)}"`);

            // Check permission response (even in groups)
            const permResult = permissions.tryMatch(text);
            if (permResult) {
              emitPermissionResponse(server, permResult.requestId, permResult.approved);
              const emoji = permResult.approved ? "✅" : "❌";
              await telegram.sendMessage(msg.chat.id, `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`);
              continue;
            }

            log(`Group message from @${msg.from!.username || msg.from!.first_name} in "${msg.chat.title || msg.chat.id}": ${text.substring(0, 50)}...`);
            emitChannelMessage(server, config.botName, msg, botMentioned, isReplyToBot);
            continue;
          }

          // --- Private chat (DM) logic below ---

          // Build text content including media info
          let text = msg.text || msg.caption || "";

          // Handle photo: download largest size, save to temp, prepend [photo] tag
          if (msg.photo && msg.photo.length > 0) {
            try {
              const largest = msg.photo[msg.photo.length - 1];
              const fileInfo = await telegram.getFile(largest.file_id);
              const fileData = await telegram.downloadFile(fileInfo.file_path);
              const ext = fileInfo.file_path.split(".").pop() || "jpg";
              const tmpPath = `/tmp/tg-photo-${largest.file_unique_id}.${ext}`;
              const fs = await import("node:fs/promises");
              await fs.writeFile(tmpPath, fileData);
              const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
              text = `[photo saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
              log(`Photo saved: ${tmpPath}`);
            } catch (err) {
              log(`Failed to download photo: ${err}`);
              text = `[photo - download failed]${text ? "\n" + text : ""}`;
            }
          }

          // Handle document
          if (msg.document) {
            try {
              const doc = msg.document;
              const fileInfo = await telegram.getFile(doc.file_id);
              const fileData = await telegram.downloadFile(fileInfo.file_path);
              const fileName = doc.file_name || `document.${doc.mime_type?.split("/")[1] || "bin"}`;
              const tmpPath = `/tmp/tg-doc-${doc.file_unique_id}-${fileName}`;
              const fs = await import("node:fs/promises");
              await fs.writeFile(tmpPath, fileData);
              const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
              text = `[document: ${fileName} (${doc.mime_type || "unknown"}) saved to ${tmpPath}${caption}]${text ? "\n" + text : ""}`;
              log(`Document saved: ${tmpPath}`);
            } catch (err) {
              log(`Failed to download document: ${err}`);
              text = `[document: ${msg.document.file_name || "unknown"} - download failed]${text ? "\n" + text : ""}`;
            }
          }

          // Ensure text is never empty — Claude Code ignores empty channel messages
          if (!text || text.trim() === "") {
            text = "[message received - no text content]";
          }

          // Patch msg.text so emitChannelMessage sends enriched content
          (msg as unknown as Record<string, unknown>).text = text;

          debug(`Update ${update.update_id}: user=${userId} (@${msg.from!.username || msg.from!.first_name}) text="${text.substring(0, 80)}"`);

          // Check if this is a permission response
          const permResult = permissions.tryMatch(text);
          if (permResult) {
            emitPermissionResponse(server, permResult.requestId, permResult.approved);
            const emoji = permResult.approved ? "✅" : "❌";
            await telegram.sendMessage(
              msg.chat.id,
              `${emoji} Permission ${permResult.approved ? "granted" : "denied"}.`
            );
            continue;
          }

          // Check access
          if (!access.isAllowed(userId, msg.chat.id)) {
            debug(`User ${userId} / chat ${msg.chat.id} not in allowlist`);
            // Only send pairing message once per user per session
            if (!pairingNotified.has(userId)) {
              pairingNotified.add(userId);
              const code = access.generatePairingCode(userId, msg.chat.id);
              log(`Pairing code "${code}" generated for user ${userId} (chat ${msg.chat.id})`);
              await telegram.sendMessage(
                msg.chat.id,
                `\`pair code ${code}\``
              );
              debug(`Pairing message sent to chat ${msg.chat.id}`);
            } else {
              debug(`User ${userId} already notified about pairing, skipping`);
            }
            continue;
          }

          // User is now authorized — clear pairing debounce if present
          pairingNotified.delete(userId);
          debug(`User ${userId} authorized, emitting channel message`);

          // Emit to Claude Code
          log(
            `DM from @${msg.from!.username || msg.from!.first_name}: ${text.substring(0, 50)}...`
          );
          emitChannelMessage(server, config.botName, msg, false, false);
        }
      } catch (err) {
        log(`Polling error: ${err}`);
      }

      await sleep(config.pollInterval);
    }
  };

  poll().catch((err) => {
    log(`Fatal polling error: ${err}`);
    process.exit(1);
  });
}

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

const LOG_FILE = process.env.MCP_LOG_FILE;

export function log(message: string): void {
  const line = `[telegram-mcp] ${message}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      const fs = require("node:fs");
      fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + line);
    } catch {}
  }
}

export function debug(message: string): void {
  if (DEBUG) {
    process.stderr.write(`[telegram-mcp:debug] ${message}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  process.stderr.write(`[telegram-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
