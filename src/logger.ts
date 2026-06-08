/**
 * Shared logging — single source for all modules.
 * Removes duplicate debug/log functions from index.ts, tools.ts, telegram.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const LOG_FILE = process.env.MCP_LOG_FILE;
const BASE_AGENT_DIR = "/srv/agents/claude-agents";

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

const CONVERSATION_LOG_DIR = process.env.CONVERSATION_LOG_DIR || `${os.tmpdir()}/telegram-conversations`;

export function logConversation(event: ConversationLogEvent): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const record = {
      ts: new Date().toISOString(),
      ...event,
    };

    // 1. Log to the central temp folder (historical fallback)
    try {
      fs.mkdirSync(CONVERSATION_LOG_DIR, { recursive: true, mode: 0o700 });
      const globalFile = `${CONVERSATION_LOG_DIR}/${day}.jsonl`;
      fs.appendFileSync(globalFile, JSON.stringify(record, null, 0) + "\n", { mode: 0o600 });
    } catch (globalErr) {
      debug(`global conversation log failed: ${globalErr}`);
    }

    // 2. Log to the specific agent's folder
    if (event.botName) {
      const agentDir = path.join(BASE_AGENT_DIR, event.botName);
      const logsDir = path.join(agentDir, "logs");

      try {
        fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });

        // A. JSONL format
        const jsonlFile = path.join(logsDir, `${day}.jsonl`);
        fs.appendFileSync(jsonlFile, JSON.stringify(record, null, 0) + "\n", { mode: 0o644 });

        // B. Human-readable .log format
        const logFile = path.join(logsDir, `${day}.log`);
        const timeStr = new Date().toISOString().replace("T", " ").slice(0, 19);
        const dir = (event.direction || "system").toUpperCase();
        let prefix = `[${timeStr}] [${dir}]`;

        if (event.chatId) {
          prefix += ` [Chat: ${event.chatId}]`;
        }

        if (event.direction === "inbound") {
          const user = event.username ? `@${event.username}` : `ID ${event.userId || "unknown"}`;
          prefix += ` [From: ${user}]`;
        }

        const msgLine = `${prefix}: ${event.text || ""}\n`;
        fs.appendFileSync(logFile, msgLine, { mode: 0o644 });
      } catch (agentErr) {
        debug(`agent-specific conversation log failed for ${event.botName}: ${agentErr}`);
      }
    }
  } catch (err) {
    debug(`conversation log outer failed: ${err}`);
  }
}
