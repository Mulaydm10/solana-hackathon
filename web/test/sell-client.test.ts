// #137: the sell form reads every /api/sell/* reply as a refusal it can show, including non-JSON errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DATA_BYTES } from "../lib/sell.ts";
import { MAX_UPLOAD_BYTES, readReply, tooLarge } from "../lib/sell-tx.ts";

test("readReply: JSON passes through; a plain-text 413 is a clear size refusal, not a parse error", async () => {
  assert.deepEqual(await readReply(Response.json({ ok: false, reason: "BAD_DATA", message: "m" }, { status: 413 })), { ok: false, reason: "BAD_DATA", message: "m" });
  const big = await readReply(new Response("Request Entity Too Large", { status: 413 }));
  assert.equal(big.reason, "TOO_LARGE");
  assert.match(String(big.message), /at most 10 MB/);
  const other = await readReply(new Response("<html>Bad Gateway</html>", { status: 502 }));
  assert.deepEqual([other.ok, other.reason], [false, "HTTP_502"]);
});

test("the browser's upload limit is the server's, and its message names it", () => {
  assert.equal(MAX_UPLOAD_BYTES, MAX_DATA_BYTES);
  assert.match(tooLarge(11_500_017), /11\.0 MB.*at most 10 MB/);
});
