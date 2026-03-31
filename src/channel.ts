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
 *
 * Group-aware metadata is passed via meta fields:
 *   chat_type       — "private" | "group" | "supergroup" | "channel"
 *   chat_title      — group/channel title (empty for private chats)
 *   bot_mentioned   — "true" if bot was @mentioned in the message
 *   is_reply_to_bot — "true" if message is a reply to a bot message
 *   is_group        — "true" for group/supergroup/channel chats
 */
export function emitChannelMessage(
  server: Server,
  source: string,
  message: TelegramMessage,
  botMentioned: boolean = false,
  isReplyToBot: boolean = false
): void {
  const text = message.text || "";
  const username = message.from?.username || message.from?.first_name || "unknown";
  const userId = message.from?.id || 0;
  const chatId = message.chat.id;
  const chatType = message.chat.type || "private";
  const chatTitle = message.chat.title || message.chat.username || "";
  const isGroup = ["group", "supergroup", "channel"].includes(chatType);

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
        chat_type: chatType,
        chat_title: chatTitle,
        is_group: String(isGroup),
        bot_mentioned: String(botMentioned),
        is_reply_to_bot: String(isReplyToBot),
        message_id: String(message.message_id),
      },
    },
  };
  debug(`Emitting channel notification: chat_type=${chatType} bot_mentioned=${botMentioned} is_reply_to_bot=${isReplyToBot}`);
  debug(`Full notification: ${JSON.stringify(notification)}`);
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
