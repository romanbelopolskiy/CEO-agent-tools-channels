/**
 * Inbound inline-button (callback_query) support.
 *
 * When a user taps an inline button under a bot message, Telegram delivers a
 * `callback_query` update (not a `message`). The bridge must (a) forward the tap
 * to the connected agent session over the SAME inbound path that normal text
 * uses, and (b) acknowledge it to Telegram so the client-side spinner stops.
 *
 * This module owns only the PURE part: turning a `callback_query` into a
 * `TelegramMessage`-shaped object that `emitChannelMessage` / `routeToSessions`
 * already know how to deliver. Side-effecting delivery + ack stay in index.ts so
 * they reuse the existing session-routing machinery.
 *
 * Back-compat: nothing here runs unless an inline button was actually sent and
 * tapped, which the 11 non-fleet bots never do.
 */
import type { TelegramCallbackQuery, TelegramMessage } from "./telegram.js";

/** Marker prefix the agent greps for to recognize an inline-button tap. */
export const CALLBACK_MARKER_PREFIX = "[button]";

/**
 * Build the inbound text the agent receives for a button tap. Simple and
 * greppable: `[button] <callback_data>`. Empty/missing data still yields a
 * stable marker (`[button]`) so the agent can detect a tap with no payload.
 */
export function buildCallbackText(data: string | undefined | null): string {
  const payload = (data ?? "").toString();
  return payload ? `${CALLBACK_MARKER_PREFIX} ${payload}` : CALLBACK_MARKER_PREFIX;
}

/**
 * Synthesize a `TelegramMessage` from a `callback_query` so it can flow through
 * the normal inbound delivery path. Reuses the originating message's chat (where
 * the button lives) and the tapping user as `from`. Returns `null` when the
 * callback_query lacks the chat context needed to route a reply (graceful
 * ignore — caller should still ack to stop the spinner).
 */
export function synthesizeCallbackMessage(
  cbq: TelegramCallbackQuery
): TelegramMessage | null {
  const chat = cbq.message?.chat;
  if (!chat || typeof chat.id !== "number") return null;

  return {
    // Reuse the underlying message id when present so status/typing keying works;
    // fall back to 0 (same as other code paths that lack a real message id).
    message_id: cbq.message?.message_id ?? 0,
    from: cbq.from,
    chat,
    date: cbq.message?.date ?? Math.floor(Date.now() / 1000),
    text: buildCallbackText(cbq.data),
    message_thread_id: cbq.message?.message_thread_id,
  };
}
