import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[config:debug] ${msg}\n`); }

export type GroupPolicy = "open" | "allowlist" | "mention-only";

export interface Config {
  botToken: string;
  botName: string;
  pollInterval: number;
  accessListPath: string;
  groupPolicy: GroupPolicy;
}

interface BotsRegistry {
  [botName: string]: {
    token: string;
    accessList?: string;
  };
}

function loadBotsRegistry(): BotsRegistry {
  const registryPath = resolve(homedir(), ".claude", "telegram-bots.json");
  if (!existsSync(registryPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const botName = process.env.TELEGRAM_BOT_NAME || "telegram";
  debug(`TELEGRAM_BOT_NAME="${botName}"`);
  debug(`TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN ? "set" : "not set"}`);
  let botToken = process.env.TELEGRAM_BOT_TOKEN;

  // If no token in env, look up by name in ~/.claude/telegram-bots.json
  if (!botToken) {
    const registry = loadBotsRegistry();
    debug(`Registry bots: ${JSON.stringify(Object.keys(registry))}`);
    const entry = registry[botName];
    if (entry?.token) {
      botToken = entry.token;
      debug(`Token found in registry for "${botName}"`);
    } else {
      debug(`No token in registry for "${botName}"`);
    }
  }

  if (!botToken) {
    const registryPath = resolve(homedir(), ".claude", "telegram-bots.json");
    throw new Error(
      `No token for bot "${botName}".\n` +
      `Either set TELEGRAM_BOT_TOKEN env var, or add it to ${registryPath}:\n` +
      `{\n  "${botName}": { "token": "123456:ABC..." }\n}`
    );
  }

  const pollInterval = parseInt(
    process.env.TELEGRAM_POLL_INTERVAL || "1000",
    10
  );
  if (isNaN(pollInterval) || pollInterval < 100) {
    throw new Error("TELEGRAM_POLL_INTERVAL must be a number >= 100 (ms)");
  }

  // Access list: env > registry > default
  let accessListPath = process.env.TELEGRAM_ACCESS_LIST;
  if (!accessListPath) {
    const registry = loadBotsRegistry();
    accessListPath = registry[botName]?.accessList
      || resolve(homedir(), ".claude", `telegram-access-${botName}.json`);
  }

  // Group policy: how to handle messages in group chats
  // "open"         — allow all group messages (like DM behavior)
  // "allowlist"    — only allow messages from users in the access list
  // "mention-only" — only respond when bot is @mentioned or replied to (default for groups)
  const rawPolicy = process.env.TELEGRAM_GROUP_POLICY || "mention-only";
  const groupPolicy: GroupPolicy = ["open", "allowlist", "mention-only"].includes(rawPolicy)
    ? rawPolicy as GroupPolicy
    : "mention-only";
  debug(`TELEGRAM_GROUP_POLICY="${groupPolicy}"`);

  return {
    botToken,
    botName,
    pollInterval,
    accessListPath,
    groupPolicy,
  };
}
