import type { TelegramClient } from "./telegram.js";

interface PendingPermission {
  requestId: string;
  chatId: number;
  description: string;
  timestamp: number;
}

const PERMISSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages permission requests forwarded from Claude Code to Telegram.
 *
 * Flow:
 * 1. Claude Code wants to run a tool and sends a permission_request
 * 2. We forward it to the user in Telegram with a unique 5-char ID
 * 3. User replies "yes <id>" or "no <id>"
 * 4. We emit permission response back to Claude Code
 */
export class PermissionManager {
  private pending: Map<string, PendingPermission> = new Map();

  constructor(private telegram: TelegramClient) {}

  /**
   * Forward a permission request to a Telegram chat.
   * Returns the short ID used for matching the reply.
   */
  async forwardRequest(
    chatId: number,
    requestId: string,
    toolName: string,
    description: string
  ): Promise<string> {
    // generate 5-char id (no ambiguous chars: 0/O, 1/l/I)
    const chars = "abcdefghjkmnpqrstuvwxyz";
    let shortId = "";
    for (let i = 0; i < 5; i++) {
      shortId += chars[Math.floor(Math.random() * chars.length)];
    }

    this.pending.set(shortId, {
      requestId,
      chatId,
      description,
      timestamp: Date.now(),
    });

    this.cleanup();

    const msg = [
      `🔒 *Permission request*`,
      ``,
      `Tool: \`${toolName}\``,
      `Action: ${description}`,
      ``,
      `Reply \`yes ${shortId}\` or \`no ${shortId}\``,
    ].join("\n");

    await this.telegram.sendMessage(chatId, msg);
    return shortId;
  }

  /**
   * Try to match a message as a permission response.
   * Returns { requestId, approved } if matched, null otherwise.
   */
  tryMatch(
    text: string
  ): { requestId: string; approved: boolean } | null {
    const match = text
      .trim()
      .match(/^\s*(y|yes|n|no)\s+([a-hjkmnp-z]{5})\s*$/i);

    if (!match) return null;

    const approved = match[1].toLowerCase().startsWith("y");
    const shortId = match[2].toLowerCase();
    const entry = this.pending.get(shortId);

    if (!entry) return null;

    this.pending.delete(shortId);
    return { requestId: entry.requestId, approved };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.timestamp > PERMISSION_TTL_MS) {
        this.pending.delete(id);
      }
    }
  }
}
