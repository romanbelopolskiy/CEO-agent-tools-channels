/**
 * Fleet sender-ID tagging for ephemeral worker processes.
 *
 * In the agent-fleet model, a permanent base supervisor (the only Telegram
 * poller) may spawn up to 5 ephemeral worker processes per task. Each worker
 * tags its outgoing Telegram messages / document captions with its instance id
 * so Roman can tell which worker spoke.
 *
 * BACKWARD-COMPAT (HARD): the tag is injected IFF a non-empty instanceId is
 * passed in (the caller reads `process.env.CEO_AGENT_INSTANCE_ID`, which is set
 * ONLY on worker processes). When the env var is unset/empty/whitespace, this
 * function returns the text byte-for-byte unchanged — so the 12 existing bots
 * behave EXACTLY as today.
 *
 * We deliberately do NOT fall back to BOT_NAME (or any other env var) for
 * gating. Existing bots already have a name set, so a BOT_NAME fallback would
 * make ALL of them start tagging at once — a fleet-wide regression. Gating on
 * CEO_AGENT_INSTANCE_ID alone keeps the new behavior strictly opt-in to
 * worker processes.
 *
 * Tag rendering: prepend "‹<instance_id>› " (U+2039 / U+203A guillemets with a
 * trailing space) to the message text.
 *
 * @param text       The message text or document caption to (maybe) tag.
 * @param instanceId The worker instance id, e.g. "fullstack2#3", or undefined.
 * @returns The tagged text when instanceId is a non-empty (trimmed) string;
 *          otherwise the original text unchanged.
 */
export function applyInstanceTag(
  text: string,
  instanceId: string | undefined
): string {
  if (typeof instanceId === "string" && instanceId.trim().length > 0) {
    return "‹" + instanceId.trim() + "› " + text;
  }
  return text;
}
