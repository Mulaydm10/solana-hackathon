// Hire-a-team plumbing (#73): team blueprints, the /api/missions routes (server-only token, strict input),
// the wallet transaction builder, and event rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { blueprintHash, validateBlueprint, DEFAULT_LIMITS } from "@deal/core";
import { createNoopSigner, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { getRevokeMandateInstruction } from "@deal/chain";
import { FIXTURES } from "../lib/registry.ts";
import { TEAM_BLUEPRINTS } from "../lib/teams.ts";
import { transactionBytes } from "../lib/wallet-tx.ts";
import { POST as prepare } from "../app/api/missions/prepare/route.ts";
import { GET as status } from "../app/api/missions/[mission]/route.ts";
import { POST as start } from "../app/api/missions/[mission]/start/route.ts";
import { describeEvent } from "../app/missions/mission-view.tsx";

const BUYER = "Buyer1111111111111111111111111111111111111";
const MISSION = "Mission111111111111111111111111111111111111";
const TOKEN = "s".repeat(40);

test("every hireable team's blueprint is valid and hashes to its listing's on-chain content hash", () => {
  for (const [listing, bp] of Object.entries(TEAM_BLUEPRINTS)) {
    assert.ok(validateBlueprint(bp, { limits: DEFAULT_LIMITS, capabilities: ["market:read", "booking:quote", "booking:pay"] }).ok, listing);
    const fixture = FIXTURES.find((f) => f.address === listing)!;
    assert.equal(Buffer.from(blueprintHash(bp)).toString("hex"), fixture.contentHash);
  }
});

async function withService(fn: (url: string, seen: { auth: string[]; bodies: unknown[] }) => Promise<void>) {
  const seen = { auth: [] as string[], bodies: [] as unknown[] };
  const srv = createServer((req, res) => {
    seen.auth.push(req.headers.authorization ?? "");
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (b) seen.bodies.push(JSON.parse(b));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url?.endsWith("/prepare") ? { ok: true, mission: MISSION, token: "never-forwarded?" } : { ok: true, state: "running", events: [] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const saved = { u: process.env.MISSION_SERVICE_URL, t: process.env.MISSION_SERVICE_TOKEN };
  process.env.MISSION_SERVICE_URL = url;
  process.env.MISSION_SERVICE_TOKEN = TOKEN;
  try {
    await fn(url, seen);
  } finally {
    process.env.MISSION_SERVICE_URL = saved.u;
    process.env.MISSION_SERVICE_TOKEN = saved.t;
    if (saved.u === undefined) delete process.env.MISSION_SERVICE_URL;
    if (saved.t === undefined) delete process.env.MISSION_SERVICE_TOKEN;
    srv.close();
  }
}

const post = (body: unknown) => new Request("http://site/api/missions/prepare", { method: "POST", body: JSON.stringify(body) });
const params = (mission: string) => ({ params: Promise.resolve({ mission }) });

test("without the mission service configured, the routes refuse with NOT_CONFIGURED", async () => {
  delete process.env.MISSION_SERVICE_URL;
  delete process.env.MISSION_SERVICE_TOKEN;
  const r = await prepare(post({}));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { reason: string }).reason, "NOT_CONFIGURED");
});

test("prepare: strict input, the blueprint comes from the site, the token goes only to the service", async () => {
  await withService(async (_url, seen) => {
    assert.equal((await prepare(post({ team: "x", goal: "g" }))).status, 400);
    assert.equal((await prepare(post({ team: "UnknownTeam1111111111111111111111111111111", goal: "A goal", budget: "1000000", buyer: BUYER }))).status, 404);
    const r = await prepare(post({ team: "9sA4TripPlannerTeamListingAddr4444444444444", goal: "Plan Bali", budget: "10000000", buyer: BUYER, blueprint: { evil: true } }));
    assert.equal(r.status, 200);
    const sent = seen.bodies[0] as { blueprint: { name: string; roles: { cap: string }[] }; budget: string };
    assert.equal(sent.blueprint.name, "Trip planner"); // the site's blueprint, not the caller's
    assert.equal(sent.blueprint.roles[0]!.cap, "5000000");
    assert.deepEqual(seen.auth, [`Bearer ${TOKEN}`]);
    assert.ok(!JSON.stringify(await r.json()).includes(TOKEN));
  });
});

test("status and start: address-checked, passed through", async () => {
  await withService(async (_url, seen) => {
    assert.equal((await status(new Request("http://site"), params("../../etc"))).status, 400);
    assert.equal((await status(new Request("http://site"), params(MISSION))).status, 200);
    assert.equal((await start(new Request("http://site", { method: "POST" }), params(MISSION))).status, 200);
    assert.ok(seen.auth.every((a) => a === `Bearer ${TOKEN}`));
  });
});

test("wallet transactions: built from generated builders, paid by the buyer, signed by nobody until the wallet does", async () => {
  const [b, m, d] = await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()));
  const buyer = createNoopSigner(b!.address);
  const ix = getRevokeMandateInstruction({ buyer, mission: m!.address, mandate: d!.address });
  const bytes = transactionBytes(buyer.address, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n }, [ix]);
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], buyer.address); // fee payer
  assert.ok(Object.values(tx.signatures).every((s) => s === null)); // nothing signed here
});

test("mission events are rendered by code; worker output is quoted, never interpreted", () => {
  assert.match(describeEvent({ type: "spend", role: "researcher", amount: "1000000", payee: "SeLLer111", ok: false, reason: "PayeeNotAllowed" }), /refused by the chain \(PayeeNotAllowed\)/);
  assert.equal(describeEvent({ type: "result", role: "writer", output: "<script>x</script>" }), "writer reported: “<script>x</script>”");
});
