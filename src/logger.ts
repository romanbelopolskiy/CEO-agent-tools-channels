/**
 * Shared logging — single source for all modules.
 * Removes duplicate debug/log functions from index.ts, tools.ts, telegram.ts.
 */
import fs from "node:fs";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const LOG_FILE = process.env.MCP_LOG_FILE;

export function log(message: string): void {
  const line = `[telegram-mcp] ${message}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + line);
    } catch {}
  }
}

export function debug(message: string): void {
  if (DEBUG) process.stderr.write(`[telegram-mcp:debug] ${message}\n`);
}

export type ConversationDirection = "inbound" | "outbound" | "system";

export interface ConversationLogEvent {
  botName: string;
  direction: ConversationDirection;
  chatId?: number;
  userId?: number;
  username?: string;
  messageId?: number;
  chatType?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

const CONVERSATION_LOG_DIR = process.env.CONVERSATION_LOG_DIR || "/srv/agents/logs/telegram-conversations";

export function logConversation(event: ConversationLogEvent): void {
  try {
    fs.mkdirSync(CONVERSATION_LOG_DIR, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const file = `${CONVERSATION_LOG_DIR}/${day}.jsonl`;
    const record = {
      ts: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(file, JSON.stringify(record, null, 0) + "\n", { mode: 0o600 });
  } catch (err) {
    debug(`conversation log failed: ${err}`);
  }
}
