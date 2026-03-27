import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TelegramClient } from "./telegram.js";
import type { AccessControl } from "./access.js";

const TOOLS = [
  {
    name: "send_telegram_message",
    description:
      "Send a message to a Telegram chat. Use this to reply to the user who messaged you through the channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chat_id: {
          type: "number",
          description: "Telegram chat ID (from channel metadata)",
        },
        text: {
          type: "string",
          description: "Message text (Markdown supported)",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "telegram_access",
    description:
      "Manage Telegram access control: pair/unpair users, list allowed users, set policy.",
    inputSchema: {
      type: "object" as const,
      properties: {
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
      required: ["action"],
    },
  },
];

export function registerTools(
  server: Server,
  telegram: TelegramClient,
  access: AccessControl,
  botName: string
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "send_telegram_message": {
        const chatId = args?.chat_id as number;
        const text = args?.text as string;

        if (!chatId || !text) {
          return {
            content: [
              { type: "text", text: "Error: chat_id and text are required" },
            ],
          };
        }

        try {
          await telegram.sendMessage(chatId, text);
          return {
            content: [
              { type: "text", text: `Message sent to chat ${chatId}` },
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
        const action = args?.action as string;

        switch (action) {
          case "pair": {
            const code = args?.code as string;
            if (!code) {
              return {
                content: [{ type: "text", text: "Error: code is required" }],
              };
            }
            const result = access.pair(code);
            if (result.success) {
              // Notify user in Telegram
              if (result.chatId) {
                telegram.sendMessage(
                  result.chatId,
                  `✅ Бот авторизован под именем *${botName}*. Теперь вы можете отправлять сообщения.`
                ).catch(() => {});
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Paired user ${result.userId}. They can now send messages.`,
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid or expired pairing code.",
                },
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
            const removed = access.unpair(userId);
            return {
              content: [
                {
                  type: "text",
                  text: removed
                    ? `Removed user ${userId} from allowlist.`
                    : `User ${userId} was not in the allowlist.`,
                },
              ],
            };
          }

          case "list": {
            const users = access.listUsers();
            const policy = access.policy;
            return {
              content: [
                {
                  type: "text",
                  text: `Policy: ${policy}\nAllowed users: ${users.length > 0 ? users.join(", ") : "(none)"}`,
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
            access.setPolicy(policy);
            return {
              content: [
                { type: "text", text: `Access policy set to: ${policy}` },
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
