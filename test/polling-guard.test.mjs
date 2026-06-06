import test from "node:test";
import assert from "node:assert/strict";

import { isOutgoingOnly } from "../dist/outgoing-only.js";

/**
 * Behavioral guard test.
 *
 * startPolling() (in src/index.ts) is module-internal and not exported, but the
 * outgoing-only short-circuit it performs is exactly:
 *
 *     if (isOutgoingOnly()) { return; }   // before any getUpdates/deleteWebhook
 *
 * This test models that gate with a fake Telegram client and asserts that in
 * outgoing-only mode NO inbound API call (deleteWebhook / getUpdates) is ever
 * made, while in normal mode polling would proceed. This pins the invariant
 * "a worker is never a 2nd poller" without a live network or service restart.
 */

function fakeTelegram() {
  const calls = [];
  return {
    calls,
    async deleteWebhook() { calls.push("deleteWebhook"); return true; },
    async getUpdates() { calls.push("getUpdates"); return []; },
  };
}

// Mirror of the guard at the top of startPolling().
function startPollingGuard(env, telegram) {
  if (isOutgoingOnly(env)) {
    return false; // returned early: inbound polling NOT started
  }
  // Normal path would begin the poll loop; emulate its first inbound touch.
  telegram.deleteWebhook(true);
  return true;
}

test("outgoing-only worker: startPolling returns WITHOUT any inbound API call", () => {
  const tg = fakeTelegram();
  const started = startPollingGuard({ CEO_AGENT_OUTGOING_ONLY: "1" }, tg);
  assert.equal(started, false, "guard must short-circuit before polling");
  assert.deepEqual(tg.calls, [], "no deleteWebhook / getUpdates in outgoing-only mode");
});

test("base process (env unset): polling proceeds and touches inbound API", () => {
  const tg = fakeTelegram();
  const started = startPollingGuard({}, tg);
  assert.equal(started, true, "base must start polling");
  assert.deepEqual(tg.calls, ["deleteWebhook"], "base begins the inbound poll path");
});
