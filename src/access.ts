import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type Policy = "open" | "allowlist";

interface AccessData {
  policy: Policy;
  allowedUsers: number[];
  pendingPairs: Record<string, number>;
}

export class AccessControl {
  private data: AccessData;

  constructor(private filePath: string) {
    this.data = this.load();
  }

  private load(): AccessData {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as AccessData;
      } catch {
        // corrupted file, start fresh
      }
    }
    return { policy: "allowlist", allowedUsers: [], pendingPairs: {} };
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  get policy(): Policy {
    return this.data.policy;
  }

  isAllowed(userId: number): boolean {
    if (this.data.policy === "open") return true;
    return this.data.allowedUsers.includes(userId);
  }

  generatePairingCode(userId: number): string {
    // remove old codes for this user
    for (const [code, uid] of Object.entries(this.data.pendingPairs)) {
      if (uid === userId) {
        delete this.data.pendingPairs[code];
      }
    }

    // 6-char alphanumeric, no ambiguous chars (0/O, 1/l/I)
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let code = "";
    const bytes = randomBytes(6);
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }

    this.data.pendingPairs[code] = userId;
    this.save();
    return code;
  }

  pair(code: string): { success: boolean; userId?: number } {
    const userId = this.data.pendingPairs[code.toLowerCase()];
    if (userId === undefined) {
      return { success: false };
    }

    delete this.data.pendingPairs[code.toLowerCase()];

    if (!this.data.allowedUsers.includes(userId)) {
      this.data.allowedUsers.push(userId);
    }

    this.save();
    return { success: true, userId };
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

  setPolicy(policy: Policy): void {
    this.data.policy = policy;
    this.save();
  }
}
