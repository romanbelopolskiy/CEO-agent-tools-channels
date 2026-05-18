// docs: n/a
// owns: auto-compact gate — defers user messages while /compact runs
// touched-by: fullstack

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export const AUTO_COMPACT_THRESHOLD = 50;
const COMPACT_DONE_DELTA = 20; // ctx must drop this many points below threshold to count as "done"
const COMPACT_POLL_MS = 2_000;
const COMPACT_TIMEOUT_MS = 240_000; // 4 minutes hard cap

interface QueueState {
  compacting: boolean;
  pending: Array<() => void>;
  startedAt: number;
  startCtx: number;
}

const queues = new Map<string, QueueState>();

const HUD_STATE_DIR = path.join(os.homedir(), ".claude", "state", "hud");

export async function readCtxPercent(botName: string): Promise<number> {
  try {
    const buf = await fs.readFile(path.join(HUD_STATE_DIR, `${botName}.json`), "utf8");
    const j = JSON.parse(buf);
    const v = j?.ctx;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

function key(botName: string, chatId: number): string {
  return `${botName}:${chatId}`;
}

/**
 * Returns true if the message was deferred (caller should NOT forward now).
 * Returns false if no gating needed — caller forwards immediately.
 */
export async function maybeGate(
  botName: string,
  chatId: number,
  triggerCompact: () => void,
  deliver: () => void,
): Promise<boolean> {
  const k = key(botName, chatId);
  const ctx = await readCtxPercent(botName);
  let q = queues.get(k);

  if (q?.compacting) {
    q.pending.push(deliver);
    return true;
  }
  if (ctx < AUTO_COMPACT_THRESHOLD) return false;

  q = {
    compacting: true,
    pending: [deliver],
    startedAt: Date.now(),
    startCtx: ctx,
  };
  queues.set(k, q);
  triggerCompact();
  pollUntilDone(k, ctx);
  return true;
}

/**
 * Manual signal — kept for safety. Drains pending deliveries.
 */
export function compactFinished(botName: string, chatId: number): void {
  drain(key(botName, chatId));
}

function drain(k: string): void {
  const q = queues.get(k);
  if (!q) return;
  q.compacting = false;
  const deliveries = q.pending;
  q.pending = [];
  queues.delete(k);
  for (const d of deliveries) {
    try { d(); } catch {}
  }
}

function pollUntilDone(k: string, startCtx: number): void {
  const q = queues.get(k);
  if (!q) return;
  const [botName] = k.split(":");
  const tick = async () => {
    const cur = queues.get(k);
    if (!cur || !cur.compacting) return;
    const ctx = await readCtxPercent(botName);
    const elapsed = Date.now() - cur.startedAt;
    // Compact completed if ctx dropped clearly OR we hit the hard cap.
    if (ctx <= AUTO_COMPACT_THRESHOLD - COMPACT_DONE_DELTA || elapsed >= COMPACT_TIMEOUT_MS) {
      drain(k);
      return;
    }
    setTimeout(tick, COMPACT_POLL_MS);
  };
  setTimeout(tick, COMPACT_POLL_MS);
}
