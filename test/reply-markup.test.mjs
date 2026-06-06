import test from "node:test";
import assert from "node:assert/strict";

import { buildReplyMarkup } from "../dist/reply-markup.js";

test("absent keyboard + absent reply_markup -> undefined (byte-identical send)", () => {
  assert.equal(buildReplyMarkup(undefined, undefined), undefined);
});

test("malformed inputs -> undefined (no markup attached)", () => {
  assert.equal(buildReplyMarkup(null, null), undefined);
  assert.equal(buildReplyMarkup("nope", undefined), undefined);
  assert.equal(buildReplyMarkup(42, undefined), undefined);
  assert.equal(buildReplyMarkup([], undefined), undefined); // empty grid
  assert.equal(buildReplyMarkup([["ok"], [1]], undefined), undefined); // non-string cell
});

test("keyboard grid -> ReplyKeyboardMarkup with fleet defaults", () => {
  const out = buildReplyMarkup(
    [["база", "fullstack2", "fullstack3"], ["fullstack4", "fullstack5"]],
    undefined
  );
  assert.deepEqual(out, {
    keyboard: [
      [{ text: "база" }, { text: "fullstack2" }, { text: "fullstack3" }],
      [{ text: "fullstack4" }, { text: "fullstack5" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  });
});

test("reply_markup passthrough object is returned untouched", () => {
  const remove = { remove_keyboard: true };
  assert.equal(buildReplyMarkup(undefined, remove), remove);

  const inline = { inline_keyboard: [[{ text: "X", callback_data: "x" }]] };
  assert.equal(buildReplyMarkup(undefined, inline), inline);
});

test("reply_markup passthrough wins over keyboard when both supplied", () => {
  const passthrough = { remove_keyboard: true };
  const out = buildReplyMarkup([["база"]], passthrough);
  assert.equal(out, passthrough);
});

test("array reply_markup is NOT treated as passthrough (only plain objects)", () => {
  // An array is not a valid Telegram reply_markup object; ignore it and fall
  // through to keyboard handling (here keyboard is absent => undefined).
  assert.equal(buildReplyMarkup(undefined, [["x"]]), undefined);
});
