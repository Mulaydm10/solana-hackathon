import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimited, withRetry } from "../src/retry.ts";

const rate = () => Object.assign(new Error("Failed to send transaction"), { cause: { context: { causeMessage: " (sig): HTTP error (429): " } } });
const noSleep = { sleep: async () => {} };

test("detects 429 anywhere in the cause chain", () => {
  assert.equal(isRateLimited(rate()), true);
  assert.equal(isRateLimited({ context: { statusCode: 429 } }), true);
  assert.equal(isRateLimited(Object.assign(new Error("tx failed"), { cause: { context: { code: 6004 } } })), false);
});

test("retries 429s then succeeds", async () => {
  let calls = 0;
  const v = await withRetry(async () => { if (++calls < 3) throw rate(); return "ok"; }, noSleep);
  assert.deepEqual([v, calls], ["ok", 3]);
});

test("never retries a program error", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("WrongStatus"); }, noSleep));
  assert.equal(calls, 1);
});

test("gives up after the attempt limit", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw rate(); }, { ...noSleep, attempts: 4 }));
  assert.equal(calls, 4);
});
