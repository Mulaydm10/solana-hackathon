import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { judge } from "../src/verifier.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const task = "Translate my supplier contract from German to English";
const good = "Supplier contract (English translation): The supplier agrees to deliver the goods within 30 days.";

test("passes an on-topic delivery whose bytes match the on-chain hash", () => {
  assert.deepEqual(judge(task, good, h(good)), { ok: true, reasons: [] });
});

test("fails when the bytes are not what the seller committed on chain", () => {
  assert.deepEqual(judge(task, good, h(good + " ")).reasons, ["HASH_MISMATCH"]);
});

test("fails junk, too-short and off-topic deliveries", () => {
  const junk = "[junk] placeholder output, not the requested work at all.";
  assert.ok(judge(task, junk, h(junk)).reasons.includes("MARKED_JUNK"));
  assert.ok(judge(task, "ok", h("ok")).reasons.includes("TOO_SHORT"));
  const off = "Here is a lovely poem about mountains and rivers in springtime weather.";
  assert.ok(judge(task, off, h(off)).reasons.includes("OFF_TOPIC"));
});
