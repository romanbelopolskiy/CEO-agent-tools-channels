export interface Config {
  botToken: string;
  botName: string;
  pollInterval: number;
  accessListPath: string;
}

export function loadConfig(): Config {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required. Get one from @BotFather in Telegram."
    );
  }

  const pollInterval = parseInt(
    process.env.TELEGRAM_POLL_INTERVAL || "1000",
    10
  );
  if (isNaN(pollInterval) || pollInterval < 100) {
    throw new Error("TELEGRAM_POLL_INTERVAL must be a number >= 100 (ms)");
  }

  return {
    botToken,
    botName: process.env.TELEGRAM_BOT_NAME || "telegram",
    pollInterval,
    accessListPath: process.env.TELEGRAM_ACCESS_LIST || "./access.json",
  };
}
