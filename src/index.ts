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
  const config = loadConfig();
  const telegram = new TelegramClient(config.botToken);
  const access = new AccessControl(config.accessListPath);
  const permissions = new PermissionManager(telegram);

  // Verify bot token
  const me = await telegram.getMe();
  log(`Bot connected: @${me.username} (${me.first_name})`);

  // Create MCP server
  const server = new Server(
    {
      name: `telegram-channel-${config.botName}`,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools
  registerTools(server, telegram, access);

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server started on stdio");

  // Start polling
  let offset: number | undefined;

  const poll = async () => {
    while (true) {
      try {
        const updates = await telegram.getUpdates(offset, 1);

        for (const update of updates) {
          offset = update.update_id + 1;

          if (!update.message?.text || !update.message.from) continue;

          const msg = update.message;
          const userId = msg.from!.id;
          const text = msg.text!;

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
            const code = access.generatePairingCode(userId);
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
            continue;
          }

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

function log(message: string): void {
  process.stderr.write(`[telegram-mcp] ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  process.stderr.write(`[telegram-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
