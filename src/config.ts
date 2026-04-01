import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[config:debug] ${msg}\n`); }

export type GroupPolicy = "open" | "allowlist" | "mention-only";

export interface BotEntry {
  name: string;
  token: string;
  accessListPath: string;
}

export interface Config {
  bots: BotEntry[];
  pollInterval: number;
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
  const registry = loadBotsRegistry();
  let botNames = Object.keys(registry);
  debug(`Registry bots: ${JSON.stringify(botNames)}`);

  // If TELEGRAM_BOT_NAME is set, only load that specific bot (routing by bot name)
  const envBotName = process.env.TELEGRAM_BOT_NAME;
  if (envBotName) {
    if (!registry[envBotName]) {
      throw new Error(`Bot "${envBotName}" not found in registry. Available: ${botNames.join(", ")}`);
    }
    botNames = [envBotName];
    debug(`TELEGRAM_BOT_NAME="${envBotName}" — loading only this bot`);
  }

  if (botNames.length === 0) {
    const registryPath = resolve(homedir(), ".claude", "telegram-bots.json");
    throw new Error(
      `No bots found in ${registryPath}.\n` +
      `Add at least one bot:\n` +
      `{\n  "mybot": { "token": "123456:ABC..." }\n}`
    );
  }

  const bots: BotEntry[] = botNames.map((name) => {
    const entry = registry[name];
    return {
      name,
      token: entry.token,
      accessListPath: entry.accessList || resolve(homedir(), ".claude", `telegram-access-${name}.json`),
    };
  });

  const pollInterval = parseInt(process.env.TELEGRAM_POLL_INTERVAL || "1000", 10);
  if (isNaN(pollInterval) || pollInterval < 100) {
    throw new Error("TELEGRAM_POLL_INTERVAL must be a number >= 100 (ms)");
  }

  const rawPolicy = process.env.TELEGRAM_GROUP_POLICY || "mention-only";
  const groupPolicy: GroupPolicy = ["open", "allowlist", "mention-only"].includes(rawPolicy)
    ? rawPolicy as GroupPolicy
    : "mention-only";
  debug(`TELEGRAM_GROUP_POLICY="${groupPolicy}"`);

  return { bots, pollInterval, groupPolicy };
}
