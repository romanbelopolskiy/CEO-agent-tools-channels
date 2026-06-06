import test from "node:test";
import assert from "node:assert/strict";

import { TelegramClient } from "../dist/telegram.js";
import {
  buildCallbackText,
  synthesizeCallbackMessage,
  CALLBACK_MARKER_PREFIX,
} from "../dist/callback-query.js";
import {
  buildInlineReplyButton,
  buildOneTimeKeyboard,
} from "../dist/reply-markup.js";

// --- getUpdates allowed_updates includes callback_query -------------------

test("getUpdates requests allowed_updates including 'message' and 'callback_query'", async () => {
  let capturedBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true, result: [] }) };
  };
  try {
    const client = new TelegramClient("TEST:token");
    await client.getUpdates(5, 1, 100);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(capturedBody, "fetch must have been called");
  assert.deepEqual(capturedBody.allowed_updates, ["message", "callback_query"]);
});

// --- answerCallbackQuery hits the right method/params ----------------------

test("answerCallbackQuery POSTs answerCallbackQuery with id (and optional text)", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  try {
    const client = new TelegramClient("TEST:token");
    await client.answerCallbackQuery("cbq-1");
    await client.answerCallbackQuery("cbq-2", "toast!");
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/answerCallbackQuery$/);
  assert.deepEqual(calls[0].body, { callback_query_id: "cbq-1" });
  assert.deepEqual(calls[1].body, { callback_query_id: "cbq-2", text: "toast!" });
});

// --- pure: buildCallbackText / synthesizeCallbackMessage -------------------

test("buildCallbackText: greppable marker with and without payload", () => {
  assert.equal(buildCallbackText("fleet:set:fullstack3"), "[button] fleet:set:fullstack3");
  assert.equal(buildCallbackText(""), CALLBACK_MARKER_PREFIX);
  assert.equal(buildCallbackText(undefined), CALLBACK_MARKER_PREFIX);
  assert.equal(buildCallbackText(null), CALLBACK_MARKER_PREFIX);
});

test("synthesizeCallbackMessage builds a routable TelegramMessage", () => {
  const cbq = {
    id: "cbq-9",
    from: { id: 186356295, is_bot: false, first_name: "Roman", username: "roman" },
    message: { message_id: 42, chat: { id: 555, type: "private" }, date: 1000 },
    data: "target:base",
  };
  const synthetic = synthesizeCallbackMessage(cbq);
  assert.ok(synthetic);
  assert.equal(synthetic.text, "[button] target:base");
  assert.equal(synthetic.chat.id, 555);
  assert.equal(synthetic.chat.type, "private");
  assert.equal(synthetic.from.id, 186356295);
  assert.equal(synthetic.message_id, 42);
});

test("synthesizeCallbackMessage returns null when no chat context (graceful ignore)", () => {
  const cbq = {
    id: "cbq-x",
    from: { id: 1, is_bot: false, first_name: "Nobody" },
    data: "x",
  };
  assert.equal(synthesizeCallbackMessage(cbq), null);
});

// --- Behavioral mirror: forward to agent + ALWAYS ack ---------------------
//
// startPolling()'s per-update block is module-internal. This mirrors its
// callback_query branch exactly: synthesize -> (if allowed) deliver via the
// same inbound path -> ALWAYS answerCallbackQuery. Pins the invariant without a
// live service.

function fakeTelegram() {
  const acked = [];
  return {
    acked,
    async answerCallbackQuery(id) { acked.push(id); return true; },
  };
}

async function handleCallbackUpdate(update, telegram, deliver, access) {
  const cbq = update.callback_query;
  const synthetic = synthesizeCallbackMessage(cbq);
  if (synthetic) {
    const uid = cbq.from?.id;
    const cid = cbq.message?.chat?.id;
    if (uid !== undefined && cid !== undefined && access.isAllowed(uid, cid)) {
      deliver(synthetic);
    }
  }
  await telegram.answerCallbackQuery(cbq.id); // always ack
}

test("callback_query: forwarded to agent AND acked when user allowed", async () => {
  const tg = fakeTelegram();
  const delivered = [];
  const access = { isAllowed: () => true };
  await handleCallbackUpdate(
    {
      update_id: 1,
      callback_query: {
        id: "ID-1",
        from: { id: 186356295, first_name: "Roman" },
        message: { message_id: 7, chat: { id: 99, type: "private" }, date: 1 },
        data: "go",
      },
    },
    tg,
    (msg) => delivered.push(msg),
    access
  );
  assert.equal(delivered.length, 1, "tap must reach the agent");
  assert.equal(delivered[0].text, "[button] go");
  assert.deepEqual(tg.acked, ["ID-1"], "spinner must be stopped via ack");
});

test("callback_query: NOT forwarded but STILL acked when user not allowed", async () => {
  const tg = fakeTelegram();
  const delivered = [];
  const access = { isAllowed: () => false };
  await handleCallbackUpdate(
    {
      update_id: 2,
      callback_query: {
        id: "ID-2",
        from: { id: 1, first_name: "Stranger" },
        message: { message_id: 8, chat: { id: 100, type: "private" }, date: 1 },
        data: "go",
      },
    },
    tg,
    (msg) => delivered.push(msg),
    access
  );
  assert.equal(delivered.length, 0, "un-paired user's tap must not reach the agent");
  assert.deepEqual(tg.acked, ["ID-2"], "ack still happens (no stuck spinner)");
});

test("callback_query: no data + no chat context -> ack only, no crash", async () => {
  const tg = fakeTelegram();
  const delivered = [];
  const access = { isAllowed: () => true };
  await handleCallbackUpdate(
    {
      update_id: 3,
      callback_query: { id: "ID-3", from: { id: 1, first_name: "X" } },
    },
    tg,
    (msg) => delivered.push(msg),
    access
  );
  assert.equal(delivered.length, 0);
  assert.deepEqual(tg.acked, ["ID-3"]);
});

// --- pure: inline button + one-time keyboard shapes -----------------------

test("buildInlineReplyButton -> valid one-button InlineKeyboardMarkup", () => {
  assert.deepEqual(buildInlineReplyButton("Подтвердить", "confirm:1"), {
    inline_keyboard: [[{ text: "Подтвердить", callback_data: "confirm:1" }]],
  });
});

test("buildOneTimeKeyboard -> ReplyKeyboardMarkup, one button per row, ephemeral", () => {
  assert.deepEqual(buildOneTimeKeyboard(["Да", "Нет", "Позже"]), {
    keyboard: [[{ text: "Да" }], [{ text: "Нет" }], [{ text: "Позже" }]],
    one_time_keyboard: true,
    resize_keyboard: true,
  });
});

test("buildOneTimeKeyboard handles empty options", () => {
  assert.deepEqual(buildOneTimeKeyboard([]), {
    keyboard: [],
    one_time_keyboard: true,
    resize_keyboard: true,
  });
});
