const BASE_URL = "https://api.telegram.org";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[telegram-api:debug] ${msg}\n`); }

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramClient {
  private baseUrl: string;

  constructor(private token: string) {
    this.baseUrl = `${BASE_URL}/bot${token}`;
  }

  private async request<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    debug(`API call: ${method}(${params ? JSON.stringify(params) : ""})`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    });

    if (!res.ok) {
      const errMsg = `Telegram API error: ${res.status} ${res.statusText}`;
      debug(`API error: ${method} -> ${errMsg}`);
      throw new Error(errMsg);
    }

    const data = (await res.json()) as TelegramResponse<T>;
    if (!data.ok) {
      const errMsg = `Telegram API error: ${data.description || "unknown"}`;
      debug(`API error: ${method} -> ${errMsg}`);
      throw new Error(errMsg);
    }

    debug(`API ok: ${method}`);
    return data.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe");
  }

  async getUpdates(
    offset?: number,
    timeout: number = 1,
    limit?: number
  ): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      limit,
      allowed_updates: ["message"],
    });
  }

  async deleteWebhook(dropPendingUpdates: boolean = false): Promise<boolean> {
    return this.request<boolean>("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode: string = "Markdown"
  ): Promise<TelegramMessage> {
    return this.request<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  }
}
