/**
 * Optional reply_markup (custom keyboard) support for send_telegram_message.
 *
 * Two accepted input shapes, both OPTIONAL and backward-compatible. When NEITHER
 * is supplied, this helper returns `undefined` and the send path is byte-for-byte
 * identical to today — protecting the 11 bots that never pass a keyboard.
 *
 *   1) Convenience form `keyboard: string[][]` — a grid of button labels. We wrap
 *      it into a Telegram `ReplyKeyboardMarkup` with sensible fleet defaults
 *      (`resize_keyboard: true`, `is_persistent: true`). This is the form the
 *      fleet base uses to render the persistent target-picker
 *      `[база] [fullstack2] … [fullstack5]`.
 *
 *   2) Passthrough form `reply_markup: object` — any valid Telegram reply markup
 *      object (`ReplyKeyboardMarkup`, `ReplyKeyboardRemove`, `InlineKeyboardMarkup`,
 *      `ForceReply`). Passed through to the Bot API untouched. This keeps the door
 *      open for inline keyboards / keyboard removal without further code changes.
 *
 * If BOTH are supplied, the explicit `reply_markup` passthrough wins (it is the
 * lower-level, more expressive form); `keyboard` is ignored in that case.
 *
 * @param keyboard    Optional grid of button label strings (string[][]).
 * @param replyMarkup Optional raw Telegram reply-markup object (passthrough).
 * @returns A reply-markup object to attach to the send call, or `undefined`
 *          when neither input was provided (byte-identical passthrough).
 */
export function buildReplyMarkup(
  keyboard: unknown,
  replyMarkup: unknown
): Record<string, unknown> | undefined {
  // Passthrough form wins when present and a plain object.
  if (isPlainObject(replyMarkup)) {
    return replyMarkup as Record<string, unknown>;
  }

  // Convenience form: a grid of label strings -> ReplyKeyboardMarkup.
  if (isStringGrid(keyboard)) {
    const rows = (keyboard as string[][]).map((row) =>
      row.map((label) => ({ text: label }))
    );
    return {
      keyboard: rows,
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  // Neither provided (or malformed) -> no markup; keep today's behavior.
  return undefined;
}

/**
 * Build a one-button `InlineKeyboardMarkup` (a button that lives UNDER a
 * message and, when tapped, fires a `callback_query` back to the bridge rather
 * than sending a chat message). Pure / side-effect free.
 *
 * @param label        Button caption shown to the user.
 * @param callbackData Opaque string echoed back in `callback_query.data` on tap
 *                     (Telegram limit: 1–64 bytes; not enforced here).
 * @returns `{ inline_keyboard: [[{ text, callback_data }]] }`.
 */
export function buildInlineReplyButton(
  label: string,
  callbackData: string
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [[{ text: label, callback_data: callbackData }]],
  };
}

/**
 * Build an ephemeral quick-reply `ReplyKeyboardMarkup` from a flat list of
 * options, one button per row. `one_time_keyboard: true` makes it disappear
 * after a single tap; `resize_keyboard: true` keeps it compact. Pure /
 * side-effect free. Tapping a button sends that option's text as a normal
 * message (not a callback_query).
 *
 * @param options Button labels; each becomes its own row.
 * @returns A `ReplyKeyboardMarkup` object.
 */
export function buildOneTimeKeyboard(options: string[]): {
  keyboard: Array<Array<{ text: string }>>;
  one_time_keyboard: true;
  resize_keyboard: true;
} {
  return {
    keyboard: options.map((label) => [{ text: label }]),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
}

/** True for a non-null, non-array object literal. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** True for a non-empty `string[][]` where every cell is a string. */
function isStringGrid(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.every((cell) => typeof cell === "string")
    )
  );
}
