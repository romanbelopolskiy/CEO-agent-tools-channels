/**
 * Live status message system for Telegram.
 *
 * Implements: specs/ceo-tools-telegram-live-status-tz.md
 *
 * One Telegram status message per incoming task. Created on task start,
 * edited (not spammed) on each runtime event, finalized on task finish.
 *
 * Architecture:
 *   StatusManager                — task lifecycle (create / update / finalize)
 *   renderStatus()              — event → human-readable text
 *   Throttle: 1s debounce + text dedupe + forced flush on finish/fail
 */

import type { TelegramClient, TelegramMessage } from "./telegram.js";
import { debug, log } from "./logger.js";
import { STATUS_DEBOUNCE_MS, STATUS_GC_MAX_AGE_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerbosityMode = "silent" | "status" | "verbose";

export interface AgentRuntimeEvent {
  type:
    | "task_started"
    | "thinking_started"
    | "thinking_updated"
    | "thinking_finished"
    | "command_started"
    | "command_finished"
    | "tool_started"
    | "tool_finished"
    | "permission_request"
    | "api_error"
    | "retrying"
    | "task_finished"
    | "task_failed";
  taskId: string;
  botName?: string;
  chatId?: number;
  text?: string;
  command?: string;
  exitCode?: number;
  tool?: string;
  preview?: string;
  ok?: boolean;
  code?: number;
  message?: string;
  requestId?: string;
  description?: string;
  reason?: string;
  summary?: string;
  error?: string;
}

export interface TaskStatusState {
  taskId: string;
  botName: string;
  chatId: number;
  sourceMessageId: number;
  statusMessageId?: number;
  model?: string;
  effort?: string;
  mode: VerbosityMode;
  lastRenderedText?: string;
  lastRenderAt?: number;
  startedAt: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function renderStatus(
  event: AgentRuntimeEvent,
  _state: TaskStatusState
): string {
  switch (event.type) {
    case "task_failed":
      return event.error ? `\`\`\`\n${truncate(event.error, 3500)}\n\`\`\`` : "⏳";
    default:
      return "⏳";
  }
}

// ---------------------------------------------------------------------------
// Should we show this event in the given verbosity mode?
// ---------------------------------------------------------------------------

const STATUS_EVENTS = new Set<AgentRuntimeEvent["type"]>([
  "task_started",
  "thinking_started",
  "command_started",
  "tool_started",
  "permission_request",
  "api_error",
  "retrying",
  "task_finished",
  "task_failed",
]);

const VERBOSE_ONLY_EVENTS = new Set<AgentRuntimeEvent["type"]>([
  "thinking_updated",
  "thinking_finished",
  "command_finished",
  "tool_finished",
]);

function shouldShow(event: AgentRuntimeEvent, mode: VerbosityMode): boolean {
  if (mode === "silent") return false;
  if (mode === "verbose") return true;
  // mode === "status"
  return STATUS_EVENTS.has(event.type);
}

// ---------------------------------------------------------------------------
// StatusManager
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = STATUS_DEBOUNCE_MS;
const TERMINAL_EVENTS = new Set(["task_finished", "task_failed"]);

export class StatusManager {
  private tasks = new Map<string, TaskStatusState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private pendingEvents = new Map<string, AgentRuntimeEvent>();

  constructor(private getClient: (botName: string) => TelegramClient | undefined) {}

  // --- public API -----------------------------------------------------------

  /** Called when a new user message arrives. Returns taskId. */
  async startTask(opts: {
    taskId: string;
    botName: string;
    chatId: number;
    sourceMessageId: number;
    mode: VerbosityMode;
    model?: string;
    effort?: string;
  }): Promise<void> {
    const state: TaskStatusState = {
      taskId: opts.taskId,
      botName: opts.botName,
      chatId: opts.chatId,
      sourceMessageId: opts.sourceMessageId,
      mode: opts.mode,
      model: opts.model,
      effort: opts.effort,
      startedAt: Date.now(),
    };
    this.tasks.set(opts.taskId, state);

    if (state.mode === "silent") return;

    const event: AgentRuntimeEvent = {
      type: "task_started",
      taskId: opts.taskId,
      botName: opts.botName,
      chatId: opts.chatId,
    };
    await this.createStatusMessage(state, event);
  }

  /** Push an event for a running task. Debounced. */
  emitEvent(event: AgentRuntimeEvent): void {
    const state = this.tasks.get(event.taskId);
    if (!state) {
      debug(`event for unknown taskId ${event.taskId}, ignoring`);
      return;
    }
    if (!shouldShow(event, state.mode)) return;

    // task_finished: keep the last CLI frame as-is, just mark done.
    if (event.type === "task_finished") {
      this.cancelTimer(event.taskId);
      state.finishedAt = Date.now();
      return;
    }

    // task_failed: render the error, cancel timers.
    if (event.type === "task_failed") {
      this.cancelTimer(event.taskId);
      this.flushEvent(event, state);
      state.finishedAt = Date.now();
      return;
    }

    // No rendering for non-terminal events — the /status-feed override
    // (raw CLI stdout) is the source of truth while the task is running.
    return;

    // Otherwise debounce: store the latest event, schedule a flush.
    this.pendingEvents.set(event.taskId, event);
    if (!this.timers.has(event.taskId)) {
      const timer = setTimeout(() => {
        this.timers.delete(event.taskId);
        const pending = this.pendingEvents.get(event.taskId);
        if (pending) {
          this.pendingEvents.delete(event.taskId);
          const st = this.tasks.get(event.taskId);
          if (st) this.flushEvent(pending, st);
        }
      }, DEBOUNCE_MS);
      this.timers.set(event.taskId, timer);
    }
  }

  /** Convenience: emit task_finished. Usually called when agent sends its reply. */
  finishTask(taskId: string, summary?: string): void {
    this.emitEvent({ type: "task_finished", taskId, summary });
  }

  /** Convenience: emit task_failed. */
  failTask(taskId: string, error: string): void {
    this.emitEvent({ type: "task_failed", taskId, error });
  }

  /** Find an active (non-finished) task by chatId and botName, most recent first. */
  findTaskByChatId(chatId: number, botName: string): TaskStatusState | undefined {
    let best: TaskStatusState | undefined;
    for (const [, s] of this.tasks) {
      if (s.chatId !== chatId) continue;
      if (s.botName !== botName) continue;
      if (s.finishedAt) continue;
      if (!best || s.startedAt > best.startedAt) best = s;
    }
    return best;
  }

  /** Find the most recent active task across all chats.
   *  Used when a tool call doesn't carry chat_id in its args. */
  findMostRecentActiveTask(): TaskStatusState | undefined {
    let best: TaskStatusState | undefined;
    for (const [, s] of this.tasks) {
      if (!s.finishedAt && (!best || s.startedAt > best.startedAt)) {
        best = s;
      }
    }
    return best;
  }

  /** Clean old finished tasks (>10 min) to avoid memory leak. */
  gc(): void {
    const cutoff = Date.now() - STATUS_GC_MAX_AGE_MS;
    for (const [id, s] of this.tasks) {
      if (s.finishedAt && s.finishedAt < cutoff) {
        this.tasks.delete(id);
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private async createStatusMessage(
    state: TaskStatusState,
    event: AgentRuntimeEvent
  ): Promise<void> {
    const client = this.getClient(state.botName);
    if (!client) return;

    const text = renderStatus(event, state);
    try {
      const sent = await client.sendMessage(state.chatId, text);
      state.statusMessageId = (sent as TelegramMessage).message_id;
      state.lastRenderedText = text;
      state.lastRenderAt = Date.now();
      debug(`status msg created: ${state.statusMessageId}`);
    } catch (err) {
      log(`failed to create status msg: ${err}`);
    }
  }

  private async flushEvent(
    event: AgentRuntimeEvent,
    state: TaskStatusState
  ): Promise<void> {
    const client = this.getClient(state.botName);
    if (!client || !state.statusMessageId) return;

    const text = renderStatus(event, state);

    // Dedupe: skip if text is identical to last.
    if (text === state.lastRenderedText) {
      debug(`dedupe: skipping identical status update for ${state.taskId}`);
      return;
    }

    try {
      await client.editMessageText(state.chatId, state.statusMessageId, text);
      state.lastRenderedText = text;
      state.lastRenderAt = Date.now();
      debug(`status msg edited: ${state.statusMessageId}`);
    } catch (err) {
      log(`failed to edit status msg ${state.statusMessageId}: ${err}`);
    }
  }

  private cancelTimer(taskId: string): void {
    const t = this.timers.get(taskId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(taskId);
    }
    this.pendingEvents.delete(taskId);
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export function loadTelemetryConfig(agentDir: string): {
  mode: VerbosityMode;
  model?: string;
  effort?: string;
} {
  const defaults = { mode: "status" as VerbosityMode };
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const file = path.join(agentDir, ".claude-tg.json");
    if (!fs.existsSync(file)) return defaults;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      mode: (["silent", "status", "verbose"].includes(raw.telegramTelemetry)
        ? raw.telegramTelemetry
        : "status") as VerbosityMode,
      model: raw.model,
      effort: raw.effort,
    };
  } catch {
    return defaults;
  }
}
