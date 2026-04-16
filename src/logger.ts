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
