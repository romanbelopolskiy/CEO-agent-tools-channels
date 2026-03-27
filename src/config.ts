import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface Config {
  botToken: string;
  botName: string;
  pollInterval: number;
  accessListPath: string;
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
  let botToken = process.env.TELEGRAM_BOT_TOKEN;

  // If no token in env, look up by name in ~/.claude/telegram-bots.json
  if (!botToken) {
    const registry = loadBotsRegistry();
    const entry = registry[botName];
    if (entry?.token) {
      botToken = entry.token;
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

  return {
    botToken,
    botName,
    pollInterval,
    accessListPath,
  };
}
