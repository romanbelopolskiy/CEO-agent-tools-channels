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

          if (!update.message?.text || !update.message.from) {
            debug(`Skipping update ${update.update_id}: no text or no from`);
            continue;
          }

          const msg = update.message;
          const userId = msg.from!.id;
          const text = msg.text!;
          debug(`Update ${update.update_id}: user=${userId} (@${msg.from!.username || msg.from!.first_name}) text="${text.substring(0, 50)}"`);

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
          if (!access.isAllowed(userId)) {
            debug(`User ${userId} not in allowlist`);
            // Only send pairing message once per user per session
            if (!pairingNotified.has(userId)) {
              pairingNotified.add(userId);
              const code = access.generatePairingCode(userId, msg.chat.id);
              log(`Pairing code "${code}" generated for user ${userId} (chat ${msg.chat.id})`);
              await telegram.sendMessage(
                msg.chat.id,
                [
                  `🔑 You are not authorized.`,
                  ``,
                  `Your pairing code: \`${code}\``,
                  ``,
                  `Send this code to the Claude Code session to pair.`,
                ].join("\n")
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
            `Message from @${msg.from!.username || msg.from!.first_name}: ${text.substring(0, 50)}...`
          );
          emitChannelMessage(server, config.botName, msg);
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

export function log(message: string): void {
  process.stderr.write(`[telegram-mcp] ${message}\n`);
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
