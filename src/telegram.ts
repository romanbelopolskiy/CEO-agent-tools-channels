import { debug } from "./logger.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://api.telegram.org";

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

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
  vcard?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  contact?: TelegramContact;
  reply_to_message?: TelegramMessage;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  message_thread_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  chat_instance?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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

    let data: TelegramResponse<T> | null = null;
    try {
      data = (await res.json()) as TelegramResponse<T>;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const errMsg = `Telegram API error: ${res.status} ${res.statusText}${data?.description ? `: ${data.description}` : ""}`;
      debug(`API error: ${method} -> ${errMsg}`);
      throw new Error(errMsg);
    }

    if (!data?.ok) {
      const errMsg = `Telegram API error: ${data?.description || "unknown"}`;
      debug(`API error: ${method} -> ${errMsg}`);
      throw new Error(errMsg);
    }

    debug(`API ok: ${method}`);
    return data.result;
  }

  private isParseModeError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /can't parse entities|parse entities|parse mode|entity|markdown/i.test(msg);
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
      // "callback_query" added so inbound inline-button taps reach the bridge.
      // Back-compat: requesting an extra update type changes nothing for bots
      // that never send inline keyboards — those updates simply never arrive.
      allowed_updates: ["message", "callback_query"],
    });
  }

  /**
   * Acknowledge an inline-button tap so Telegram stops the client-side spinner.
   * `text`, when provided, is shown as a brief toast to the user. Mirrors the
   * existing `request` helper used by every other Bot API method here.
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<boolean> {
    const params: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text !== undefined) params.text = text;
    return this.request<boolean>("answerCallbackQuery", params);
  }

  async deleteWebhook(dropPendingUpdates: boolean = false): Promise<boolean> {
    return this.request<boolean>("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode: string = "Markdown",
    replyMarkup?: unknown,
    messageThreadId?: number
  ): Promise<TelegramMessage> {
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) params.parse_mode = parseMode;
    // Optional custom keyboard / reply markup. Absent => omitted entirely, so
    // the request body is byte-identical to today for callers that don't use it.
    if (replyMarkup !== undefined) params.reply_markup = replyMarkup;
    if (messageThreadId !== undefined) params.message_thread_id = messageThreadId;
    try {
      return await this.request<TelegramMessage>("sendMessage", params);
    } catch (error) {
      if (parseMode && this.isParseModeError(error)) {
        debug("sendMessage parse_mode failed; retrying as plain text");
        const retry: Record<string, unknown> = { chat_id: chatId, text };
        if (replyMarkup !== undefined) retry.reply_markup = replyMarkup;
        if (messageThreadId !== undefined) retry.message_thread_id = messageThreadId;
        return this.request<TelegramMessage>("sendMessage", retry);
      }
      throw error;
    }
  }

  async sendDocument(
    chatId: number,
    filePath: string,
    caption?: string,
    parseMode: string = "Markdown",
    replyMarkup?: unknown,
    messageThreadId?: number
  ): Promise<TelegramMessage> {
    const url = `${this.baseUrl}/sendDocument`;
    debug(`API call: sendDocument(${JSON.stringify({ chatId, filePath, caption: caption ? "<caption>" : undefined })})`);

    const data = await readFile(filePath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([data]), basename(filePath));
    if (messageThreadId !== undefined) {
      form.append("message_thread_id", String(messageThreadId));
    }
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", parseMode);
    }
    // Optional reply markup, JSON-encoded per the Bot API multipart contract.
    // Absent => field omitted, so document sends are unchanged for the 11 bots.
    if (replyMarkup !== undefined) {
      form.append("reply_markup", JSON.stringify(replyMarkup));
    }

    const res = await fetch(url, { method: "POST", body: form });
    let body: TelegramResponse<TelegramMessage> | null = null;
    try {
      body = (await res.json()) as TelegramResponse<TelegramMessage>;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const errMsg = `Telegram API error: ${res.status} ${res.statusText}${body?.description ? `: ${body.description}` : ""}`;
      debug(`API error: sendDocument -> ${errMsg}`);
      if (caption && parseMode && this.isParseModeError(errMsg)) {
        debug("sendDocument caption parse_mode failed; retrying caption as plain text");
        return this.sendDocument(chatId, filePath, caption, "", replyMarkup, messageThreadId);
      }
      throw new Error(errMsg);
    }

    if (!body?.ok) {
      const errMsg = `Telegram API error: ${body?.description || "unknown"}`;
      debug(`API error: sendDocument -> ${errMsg}`);
      if (caption && parseMode && this.isParseModeError(errMsg)) {
        debug("sendDocument caption parse_mode failed; retrying caption as plain text");
        return this.sendDocument(chatId, filePath, caption, "", replyMarkup, messageThreadId);
      }
      throw new Error(errMsg);
    }
    debug("API ok: sendDocument");
    return body.result;
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    return this.request<{ file_path: string }>("getFile", { file_id: fileId });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    parseMode: string = "Markdown"
  ): Promise<TelegramMessage | boolean> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (parseMode) params.parse_mode = parseMode;
    try {
      return await this.request<TelegramMessage | boolean>("editMessageText", params);
    } catch (error) {
      if (parseMode && this.isParseModeError(error)) {
        debug("editMessageText parse_mode failed; retrying as plain text");
        return this.request<TelegramMessage | boolean>("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
        });
      }
      throw error;
    }
  }

  async sendChatAction(chatId: number, action: string = "typing"): Promise<boolean> {
    return this.request<boolean>("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `${BASE_URL}/file/bot${this.token}/${filePath}`;
    debug(`Downloading file: ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
