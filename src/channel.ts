import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TelegramMessage } from "./telegram.js";

/**
 * Emit a channel notification to Claude Code.
 *
 * Claude Code receives this as:
 * <channel source="bot-name" chat_id="123" user_id="456" username="roman">
 *   message text here
 * </channel>
 */
export function emitChannelMessage(
  server: Server,
  source: string,
  message: TelegramMessage
): void {
  const text = message.text || "";
  const username = message.from?.username || message.from?.first_name || "unknown";
  const userId = message.from?.id || 0;
  const chatId = message.chat.id;

  server.notification({
    method: "notifications/claude/channel",
    params: {
      channel: {
        source,
        metadata: {
          chat_id: String(chatId),
          user_id: String(userId),
          username,
        },
        content: text,
      },
    },
  });
}

/**
 * Emit a permission response back to Claude Code.
 * Called when user replies "yes <id>" or "no <id>" in Telegram.
 */
export function emitPermissionResponse(
  server: Server,
  requestId: string,
  approved: boolean
): void {
  server.notification({
    method: "notifications/claude/channel/permission",
    params: {
      requestId,
      approved,
    },
  });
}
