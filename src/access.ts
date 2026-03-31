import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debug(msg: string) { if (DEBUG) process.stderr.write(`[access:debug] ${msg}\n`); }

export type Policy = "open" | "allowlist";

interface PendingPair {
  userId: number;
  chatId: number;
}

interface AccessData {
  policy: Policy;
  allowedUsers: number[];
  allowedChats: number[];
  pendingPairs: Record<string, number | PendingPair>;
}

export class AccessControl {
  private data: AccessData;

  constructor(private filePath: string) {
    debug(`Loading access data from ${filePath}`);
    this.data = this.load();
    debug(
      `Loaded: policy=${this.data.policy}, users=${this.data.allowedUsers.length}, chats=${this.data.allowedChats.length}, pending=${Object.keys(this.data.pendingPairs).length}`
    );
  }

  private load(): AccessData {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<AccessData>;
        return {
          policy: parsed.policy || "allowlist",
          allowedUsers: Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers : [],
          allowedChats: Array.isArray(parsed.allowedChats) ? parsed.allowedChats : [],
          pendingPairs: parsed.pendingPairs || {},
        };
      } catch {
        // corrupted file, start fresh
      }
    }
    return { policy: "allowlist", allowedUsers: [], allowedChats: [], pendingPairs: {} };
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  get policy(): Policy {
    return this.data.policy;
  }

  isAllowed(userId: number, chatId?: number): boolean {
    this.data = this.load();
    if (this.data.policy === "open") return true;
    if (this.data.allowedUsers.includes(userId)) return true;
    if (typeof chatId === "number" && this.data.allowedChats.includes(chatId)) return true;
    return false;
  }

  generatePairingCode(userId: number, chatId: number): string {
    this.data = this.load();

    for (const [code, entry] of Object.entries(this.data.pendingPairs)) {
      const uid = typeof entry === "number" ? entry : entry.userId;
      if (uid === userId) {
        return code;
      }
    }

    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let code = "";
    const bytes = randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }

    this.data.pendingPairs[code] = { userId, chatId };
    this.save();
    return code;
  }

  pair(code: string): { success: boolean; userId?: number; chatId?: number } {
    this.data = this.load();
    debug(`pair("${code}"): pending codes = ${JSON.stringify(Object.keys(this.data.pendingPairs))}`);
    const entry = this.data.pendingPairs[code.toLowerCase()];
    if (entry === undefined) {
      debug(`pair("${code}"): code not found`);
      return { success: false };
    }

    const userId = typeof entry === "number" ? entry : entry.userId;
    const chatId = typeof entry === "number" ? undefined : entry.chatId;
    debug(`pair("${code}"): found userId=${userId}, chatId=${chatId}`);

    delete this.data.pendingPairs[code.toLowerCase()];

    if (!this.data.allowedUsers.includes(userId)) {
      this.data.allowedUsers.push(userId);
    }

    this.save();
    debug(
      `pair("${code}"): success, allowedUsers=${JSON.stringify(this.data.allowedUsers)}, allowedChats=${JSON.stringify(this.data.allowedChats)}`
    );
    return { success: true, userId, chatId };
  }

  unpair(userId: number): boolean {
    const idx = this.data.allowedUsers.indexOf(userId);
    if (idx === -1) return false;
    this.data.allowedUsers.splice(idx, 1);
    this.save();
    return true;
  }

  listUsers(): number[] {
    return [...this.data.allowedUsers];
  }

  listChats(): number[] {
    return [...this.data.allowedChats];
  }

  setPolicy(policy: Policy): void {
    this.data.policy = policy;
    this.save();
  }
}
