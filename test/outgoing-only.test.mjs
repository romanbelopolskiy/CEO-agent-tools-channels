import test from "node:test";
import assert from "node:assert/strict";

import { isOutgoingOnly } from "../dist/outgoing-only.js";

test("env unset -> false (base + 11 bots poll normally)", () => {
  assert.equal(isOutgoingOnly({}), false);
});

test("empty / whitespace -> false", () => {
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "" }), false);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "   " }), false);
});

test('"1" / "true" / "yes" (any case) -> true (worker: no inbound poll)', () => {
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "1" }), true);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "true" }), true);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "TRUE" }), true);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "Yes" }), true);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "  1 " }), true);
});

test("unrelated values -> false (only explicit truthy tokens enable it)", () => {
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "0" }), false);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "false" }), false);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "no" }), false);
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: "off" }), false);
});

test("non-string value -> false", () => {
  // Defensive: a non-string slips to false rather than throwing.
  assert.equal(isOutgoingOnly({ CEO_AGENT_OUTGOING_ONLY: undefined }), false);
});
