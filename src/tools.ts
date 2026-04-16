import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TelegramClient } from "./telegram.js";
import type { AccessControl } from "./access.js";
import type { StatusManager } from "./status-messages.js";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[tools:debug] ${msg}\n`); }
function log(msg: string) { process.stderr.write(`[telegram-mcp] ${msg}\n`); }

export interface BotContext {
  name: string;
  telegram: TelegramClient;
  access: AccessControl;
}

const TOOLS = [
  {
    name: "send_telegram_message",
    description:
      "Send a message to a Telegram chat. Use this to reply to the user who messaged you through the channel. The bot_name must match the source from the channel message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bot_name: {
          type: "string",
          description: "Bot name (from channel message source / metadata)",
        },
        chat_id: {
          type: "number",
          description: "Telegram chat ID (from channel metadata)",
        },
        text: {
          type: "string",
          description: "Message text (Markdown supported)",
        },
      },
      required: ["bot_name", "chat_id", "text"],
    },
  },
  {
    name: "telegram_access",
    description:
      "Manage Telegram access control. Use action 'pair' with a pairing code to authorize a Telegram user. Also supports: unpair, list, set-policy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bot_name: {
          type: "string",
          description: "Bot name to manage access for",
        },
        action: {
          type: "string",
          enum: ["pair", "unpair", "list", "set-policy"],
          description: "Action to perform",
        },
        code: {
          type: "string",
          description: "Pairing code (for 'pair' action)",
        },
        user_id: {
          type: "number",
          description: "User ID (for 'unpair' action)",
        },
        policy: {
          type: "string",
          enum: ["open", "allowlist"],
          description: "Access policy (for 'set-policy' action)",
        },
      },
      required: ["bot_name", "action"],
    },
  },
  {
    name: "list_telegram_bots",
    description: "List all registered Telegram bots and their status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

export function registerTools(
  server: Server,
  botsMap: Map<string, BotContext>,
  onMessageSent?: (botName: string, chatId: number) => void,
  statusManager?: StatusManager | null
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log(`Tool called: ${name}(${JSON.stringify(args)})`);

    // Emit tool_started status for any tool call (not just send_telegram_message).
    const toolChatId = args?.chat_id as number | undefined;
    const toolBotName = args?.bot_name as string | undefined;
    if (statusManager && toolChatId) {
      const task = statusManager.findTaskByChatId(toolChatId);
      if (task) {
        statusManager.emitEvent({
          type: "tool_started",
          taskId: task.taskId,
          tool: name,
        });
      }
    }

    function getBot(botName?: string): BotContext | null {
      if (!botName) return null;
      return botsMap.get(botName) || null;
    }

    switch (name) {
      case "list_telegram_bots": {
        const lines = Array.from(botsMap.entries()).map(
          ([n, ctx]) => `- ${n}`
        );
        return {
          content: [
            { type: "text", text: `Registered bots (${botsMap.size}):\n${lines.join("\n")}` },
          ],
        };
      }

      case "send_telegram_message": {
        const botName = args?.bot_name as string;
        const chatId = args?.chat_id as number;
        const text = args?.text as string;

        const bot = getBot(botName);
        if (!bot) {
          return {
            content: [
              { type: "text", text: `Error: bot "${botName}" not found. Use list_telegram_bots to see available bots.` },
            ],
          };
        }

        if (!chatId || !text) {
          return {
            content: [
              { type: "text", text: "Error: chat_id and text are required" },
            ],
          };
        }

        try {
          onMessageSent?.(botName, chatId);
          await bot.telegram.sendMessage(chatId, text);

          // Finalize live status — agent has replied.
          if (statusManager) {
            const task = statusManager.findTaskByChatId(chatId);
            if (task) {
              statusManager.finishTask(task.taskId);
            }
          }

          return {
            content: [
              { type: "text", text: `Message sent via ${botName} to chat ${chatId}` },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text", text: `Error sending message: ${msg}` },
            ],
          };
        }
      }

      case "telegram_access": {
        const botName = args?.bot_name as string;
        const action = args?.action as string;

        const bot = getBot(botName);
        if (!bot) {
          return {
            content: [
              { type: "text", text: `Error: bot "${botName}" not found. Use list_telegram_bots to see available bots.` },
            ],
          };
        }

        switch (action) {
          case "pair": {
            const code = args?.code as string;
            if (!code) {
              return {
                content: [{ type: "text", text: "Error: code is required" }],
              };
            }
            const result = bot.access.pair(code);
            debug(`pair result: ${JSON.stringify(result)}`);
            if (result.success) {
              if (result.chatId) {
                log(`Sending authorization confirmation to chat ${result.chatId} for bot "${botName}"`);
                bot.telegram.sendMessage(
                  result.chatId,
                  `✅ Bot authorized as *${botName}*. You can now send messages.`
                ).catch((err) => { log(`Failed to send auth confirmation: ${err}`); });
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Paired user ${result.userId}. They can now send messages via ${botName}.`,
                  },
                ],
              };
            }
            return {
              content: [
                { type: "text", text: "Invalid or expired pairing code." },
              ],
            };
          }

          case "unpair": {
            const userId = args?.user_id as number;
            if (!userId) {
              return {
                content: [
                  { type: "text", text: "Error: user_id is required" },
                ],
              };
            }
            const removed = bot.access.unpair(userId);
            return {
              content: [
                {
                  type: "text",
                  text: removed
                    ? `Removed user ${userId} from ${botName} allowlist.`
                    : `User ${userId} was not in the ${botName} allowlist.`,
                },
              ],
            };
          }

          case "list": {
            const users = bot.access.listUsers();
            const policy = bot.access.policy;
            return {
              content: [
                {
                  type: "text",
                  text: `Bot: ${botName}\nPolicy: ${policy}\nAllowed users: ${users.length > 0 ? users.join(", ") : "(none)"}`,
                },
              ],
            };
          }

          case "set-policy": {
            const policy = args?.policy as "open" | "allowlist";
            if (!policy || !["open", "allowlist"].includes(policy)) {
              return {
                content: [
                  {
                    type: "text",
                    text: 'Error: policy must be "open" or "allowlist"',
                  },
                ],
              };
            }
            bot.access.setPolicy(policy);
            return {
              content: [
                { type: "text", text: `${botName} access policy set to: ${policy}` },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action: ${action}. Use pair, unpair, list, or set-policy.`,
                },
              ],
            };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  });
}
