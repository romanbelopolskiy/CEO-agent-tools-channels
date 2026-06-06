import test from "node:test";
import assert from "node:assert/strict";

import { applyInstanceTag } from "../dist/instance-tag.js";

test("instanceId undefined -> text unchanged (backward-compat)", () => {
  assert.equal(applyInstanceTag("hello", undefined), "hello");
});

test("instanceId empty string -> text unchanged", () => {
  assert.equal(applyInstanceTag("hello", ""), "hello");
});

test("instanceId whitespace-only -> text unchanged", () => {
  assert.equal(applyInstanceTag("hello", "   "), "hello");
});

test("instanceId set -> tag prepended with guillemets + trailing space", () => {
  assert.equal(
    applyInstanceTag("hello", "fullstack2#3"),
    "‹fullstack2#3› hello"
  );
  // Sanity: literal guillemet form matches too.
  assert.equal(applyInstanceTag("hello", "fullstack2#3"), "‹fullstack2#3› hello");
});

test("instanceId set + empty text -> tag with trailing space only", () => {
  assert.equal(applyInstanceTag("", "fullstack2#3"), "‹fullstack2#3› ");
});

test("instanceId is trimmed before use", () => {
  assert.equal(applyInstanceTag("hi", "  fullstack2#2  "), "‹fullstack2#2› hi");
});

test("undefined-gated result is byte-identical to original text", () => {
  const text = "some\nmulti line\ntext with ‹unicode›";
  assert.equal(applyInstanceTag(text, undefined), text);
});
