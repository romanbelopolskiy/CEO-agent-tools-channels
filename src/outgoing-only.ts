/**
 * Worker "outgoing-only" mode for the agent-fleet model.
 *
 * A fleet has ONE Telegram poller: the permanent base supervisor. Telegram
 * allows only a single `getUpdates` consumer per bot token — a second poller on
 * the same token gets HTTP 409 Conflict. Ephemeral worker processes are LIVE
 * sessions that must be able to SEND (via `send_telegram_message` over the SSE
 * bridge) but must NEVER start their own inbound poll loop.
 *
 * The gate is the env var `CEO_AGENT_OUTGOING_ONLY`, set ONLY on worker
 * processes (alongside `CEO_AGENT_INSTANCE_ID`). When it is "1"/"true"/"yes"
 * (case-insensitive, trimmed), inbound polling is suppressed for that process.
 * Unset/empty/anything-else => normal behavior, so the base and all 11 existing
 * bots poll exactly as today.
 *
 * Outbound send is unaffected: it flows through the MCP `send_telegram_message`
 * tool, independent of polling. Multiple senders per token are allowed by
 * Telegram; multiple pollers are not.
 *
 * @param env A process-environment-like record (defaults to `process.env`).
 * @returns true when this process must NOT start an inbound poll loop.
 */
export function isOutgoingOnly(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.CEO_AGENT_OUTGOING_ONLY;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
