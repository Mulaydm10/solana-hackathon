// redisBlobs (#311): GET/SET over Upstash's REST API, base64 values, names checked, errors surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redisBlobs } from "../lib/storage.ts";

function stub() {
  const db = new Map<string, string>(); const calls: string[][] = [];
  const f = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
    assert.equal(init.headers.authorization, "Bearer t0k");
    const cmd = JSON.parse(init.body) as string[]; calls.push(cmd);
    const result = cmd[0] === "GET" ? (db.get(cmd[1]!) ?? null) : (db.set(cmd[1]!, cmd[2]!), "OK");
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, db, calls };
}
const NAME = "machines/4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM.json";

test("redisBlobs: write then read returns the same bytes, stored as base64 under the prefix", async () => {
  const s = stub(); const b = redisBlobs("https://x.upstash.io", "t0k", "machines", s.f);
  const bytes = new TextEncoder().encode('{"a":1}');
  await b.write(NAME, bytes);
  assert.deepEqual(await b.read(NAME), bytes);
  assert.equal(s.calls[0]![1], `machines/${NAME}`);
  assert.equal(s.db.get(`machines/${NAME}`), Buffer.from(bytes).toString("base64"));
});

test("redisBlobs: a missing key reads as null; bad names and a non-https url are refused", async () => {
  const s = stub(); const b = redisBlobs("https://x.upstash.io", "t0k", "machines", s.f);
  assert.equal(await b.read(NAME), null);
  await assert.rejects(() => b.read("../etc/passwd"));
  assert.throws(() => redisBlobs("http://x.upstash.io", "t0k", "machines", s.f));
});

test("redisBlobs: a service error surfaces (never read as empty)", async () => {
  const f = (async () => new Response(JSON.stringify({ error: "WRONGPASS" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(() => redisBlobs("https://x.upstash.io", "bad", "machines", f).read(NAME), /redis GET failed/);
});
