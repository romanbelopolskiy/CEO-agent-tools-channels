import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TelegramMessage } from "./telegram.js";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[channel:debug] ${msg}\n`); }

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

  const notification = {
    method: "notifications/claude/channel",
    params: {
      content: text,
      source,
      meta: {
        chat_id: String(chatId),
        user_id: String(userId),
        username,
        first_name: message.from?.first_name || "",
      },
    },
  };
  debug(`Emitting channel notification: ${JSON.stringify(notification)}`);
  server.notification(notification);
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
      request_id: requestId,
      behavior: approved ? "allow" : "deny",
    },
  });
}
