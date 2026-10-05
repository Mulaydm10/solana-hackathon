// Demo buyer for judges (#183) and the model key's absence from mission API responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { sha256Hex } from "@deal/core";
import { approveDemo, createLimiter, DEMO_LIMITS, releaseDemo, startDemo, type DemoDeps, type TeamOffer } from "../lib/demo.ts";
import { demoAvailable, parseEnv } from "../lib/env.ts";
import { TRIP_PLANNER } from "../lib/teams.ts";
import { POST as prepare } from "../app/api/missions/prepare/route.ts";
import { GET as status } from "../app/api/missions/[mission]/route.ts";
import { POST as start } from "../app/api/missions/[mission]/start/route.ts";
import { POST as demoStart } from "../app/api/demo/missions/route.ts";
import { POST as demoApprove } from "../app/api/demo/missions/[mission]/approve/route.ts";
import { POST as demoRelease } from "../app/api/demo/missions/[mission]/release/route.ts";

const FAKE_MODEL_KEY = "sk-ant-FAKE-" + "Zq7".repeat(16);
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const addr = async () => (await generateKeyPairSigner()).address;

type Sent = string[][];

async function fakeDeps(o: { buyer?: KeyPairSigner; policy?: { periodBudget: bigint; maxPrice: bigint } | null; missionBuyer?: string | null; budgetFromService?: string } = {}) {
  const buyer = o.buyer ?? (await generateKeyPairSigner());
  const [seller, listing, mint, verifier, agentA, agentB, payee, mission] = (await Promise.all(Array.from({ length: 8 }, addr))) as [Address, Address, Address, Address, Address, Address, Address, Address];
  const sent: Sent = [];
  const serviceCalls: { path: string; body?: unknown }[] = [];
  const plan = JSON.stringify({ mission, stage: 0, name: "Research", roles: ["researcher"], cap: "2000000", goal: "g" });
  const team: TeamOffer = { listing, seller, price: 1_000_000n, contentHash: hex(1), blueprint: TRIP_PLANNER };
  const deps: DemoDeps = {
    buyer, mint: mint as Address, limit: createLimiter(), nowSecs: () => 1_800_000_000,
    send: async (ixs) => { sent.push(ixs.map((i) => i.programAddress)); return `sig${sent.length}`; },
    service: async (path, body) => {
      serviceCalls.push({ path, body });
      if (path === "/missions/prepare") {
        const b = body as { buyer: string; budget: string };
        return {
          status: 200,
          body: {
            ok: true, mission, buyer: b.buyer, digest: hex(3), terms: { hash: hex(2) }, plans: [{ stage: 0, plan, planHash: sha256Hex(plan) }],
            createParams: { missionId: "1", budget: o.budgetFromService ?? b.budget, termsHash: hex(2), stageCaps: ["2000000"], expiresAt: "1800003600", verifier },
            roles: [agentA, agentB].map((agent, i) => ({ role: i ? "writer" : "researcher", agent, mandate: { agent, roleHash: hex(4 + i), cap: "1000000", perTxCap: "1000000", payees: [payee], stageMask: 1 << i, expiresAt: "1800003600" } })),
          },
        };
      }
      if (path.endsWith("/start")) return { status: 202, body: { ok: true, state: "running" } };
      return { status: 200, body: { ok: true, buyer: buyer.address, digest: hex(3), plans: [{ stage: 0, plan, planHash: sha256Hex(plan) }], events: [{ type: "delivered", deliverableHash: hex(9) }] } };
    },
    policy: async () => (o.policy === undefined ? null : o.policy),
    missionBuyer: async () => (o.missionBuyer === undefined ? buyer.address : o.missionBuyer),
    feeDeal: async (deal) => ({ deal, buyer: buyer.address, seller: seller as Address, mint: mint as Address, status: "Delivered", deliveryHash: hex(9), listing: listing as Address }),
    team: async () => team,
  };
  return { deps, sent, serviceCalls, mission, buyer };
}

test("demo start: the demo budget is fixed, the policy is created small if missing, mission + fee deal + mandates are signed", async () => {
  const { deps, sent, serviceCalls } = await fakeDeps();
  const r = await startDemo(deps, "1.1.1.1", "  3 days in Lisbon for two  ");
  assert.ok(r.ok, JSON.stringify(r));
  const prep = serviceCalls.find((c) => c.path === "/missions/prepare")!.body as { budget: string; buyer: string; goal: string };
  assert.equal(prep.budget, DEMO_LIMITS.budget.toString());
  assert.equal(prep.buyer, deps.buyer.address);
  assert.equal(prep.goal, "3 days in Lisbon for two");
  assert.equal(sent.length, 3); // policy; mission + fee deal (one transaction); mandates
  assert.equal(sent[1]!.length, 2);
  assert.ok(serviceCalls.some((c) => c.path.endsWith("/start") && (c.body as { feeDeal: string }).feeDeal === (r as { feeDeal: string }).feeDeal));
});

test("demo start: refuses a large on-chain policy, a service that changed the budget or buyer, bad goals, and too many starts", async () => {
  const big = await fakeDeps({ policy: { periodBudget: 1_000n * 1_000_000n, maxPrice: 1_000_000n } });
  assert.equal((await startDemo(big.deps, "ip", "3 days in Lisbon") as { reason: string }).reason, "DEMO_POLICY_TOO_LARGE");
  assert.equal(big.sent.length, 0);
  const sneaky = await fakeDeps({ budgetFromService: "999000000" });
  assert.equal((await startDemo(sneaky.deps, "ip", "3 days in Lisbon") as { reason: string }).reason, "PREPARE_MISMATCH");
  assert.equal(sneaky.sent.length, 1); // only the small policy; nothing for the mission
  const { deps } = await fakeDeps({ policy: { periodBudget: DEMO_LIMITS.policyPerDay, maxPrice: DEMO_LIMITS.policyMaxPrice } });
  assert.equal((await startDemo(deps, "ip", "x") as { reason: string }).reason, "BAD_GOAL");
  assert.equal((await startDemo(deps, "ip", "y".repeat(DEMO_LIMITS.goalMax + 1)) as { reason: string }).reason, "BAD_GOAL");
  for (let i = 0; i < DEMO_LIMITS.missionsPerIpPerHour; i++) assert.ok((await startDemo(deps, "9.9.9.9", "3 days in Rome")).ok);
  const limited = await startDemo(deps, "9.9.9.9", "3 days in Rome");
  assert.equal((limited as { status: number; reason: string }).status, 429);
  assert.ok((await startDemo(deps, "8.8.8.8", "3 days in Rome")).ok); // another client is not limited by the first
});

test("demo approve and release act only on missions and deals the demo buyer created", async () => {
  const own = await fakeDeps();
  const a = await approveDemo(own.deps, "ip", own.mission, 0);
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(own.sent.length, 1);
  assert.equal((await approveDemo(own.deps, "ip", own.mission, 5) as { reason: string }).reason, "NO_SUCH_STAGE");
  assert.equal((await approveDemo(own.deps, "ip", "../x", 0) as { reason: string }).reason, "BAD_REQUEST");
  const rel = await releaseDemo(own.deps, "ip", own.mission, own.mission);
  assert.ok(rel.ok, JSON.stringify(rel));

  const other = await fakeDeps({ missionBuyer: await addr() });
  const r = await approveDemo(other.deps, "ip", other.mission, 0);
  assert.deepEqual([(r as { status: number }).status, (r as { reason: string }).reason], [403, "NOT_A_DEMO_MISSION"]);
  assert.equal((await releaseDemo(other.deps, "ip", other.mission, other.mission) as { reason: string }).reason, "NOT_A_DEMO_MISSION");
  assert.equal(other.sent.length, 0);
  const gone = await fakeDeps({ missionBuyer: null });
  assert.equal((await approveDemo(gone.deps, "ip", gone.mission, 0) as { reason: string }).reason, "NO_MISSION");
});

test("the demo is offered only with DEMO_BUYER_KEY and the mission service, and only on devnet", async () => {
  const key = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
  const svc = { MISSION_SERVICE_URL: "http://127.0.0.1:1", MISSION_SERVICE_TOKEN: "t".repeat(40) };
  assert.equal(demoAvailable(parseEnv({ ...svc })), false); // no key: the "Try the demo" button is hidden
  assert.equal(demoAvailable(parseEnv({ DEMO_BUYER_KEY: key })), false);
  assert.equal(demoAvailable(parseEnv({ ...svc, DEMO_BUYER_KEY: key })), true);
  assert.equal(demoAvailable(parseEnv({ ...svc, DEMO_BUYER_KEY: key, DEAL_CLUSTER: "localnet" })), false);
  assert.equal(demoAvailable(parseEnv({ ...svc, DEMO_BUYER_KEY: "not a key" })), false);
});

/** A mission service stub that records what it was sent and echoes it back (the worst case for leaks). */
async function withEchoService(fn: (seen: string[]) => Promise<void>) {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push(`${req.url} ${JSON.stringify(req.headers)} ${b}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, state: "running", events: [], mission: "Mission1111111111111111111111111111111111111", echo: { url: req.url, body: b } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const keys = ["MISSION_SERVICE_URL", "MISSION_SERVICE_TOKEN", "ANTHROPIC_API_KEY", "DEMO_BUYER_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.MISSION_SERVICE_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  process.env.MISSION_SERVICE_TOKEN = "s".repeat(48);
  process.env.ANTHROPIC_API_KEY = FAKE_MODEL_KEY;
  // A real (throwaway) ed25519 keypair in the Solana 64-byte format: seed then public key.
  const kp = generateKeyPairSync("ed25519");
  const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  process.env.DEMO_BUYER_KEY = JSON.stringify([...seed, ...pub]);
  try {
    await fn(seen);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    srv.close();
  }
}

test("the model key (and the demo buyer key) never appear in the missions prepare/start/status or demo route responses", async () => {
  await withEchoService(async (seen) => {
    const M = "Mission1111111111111111111111111111111111111";
    const buyer = await addr();
    const params = { params: Promise.resolve({ mission: M }) };
    const responses = [
      await prepare(new Request("http://site/api/missions/prepare", { method: "POST", body: JSON.stringify({ team: "9sA4TripPlannerTeamListingAddr4444444444444", goal: "Plan Lisbon", budget: "1000000", buyer }) })),
      await prepare(new Request("http://site/api/missions/prepare", { method: "POST", body: "{}" })),
      await start(new Request("http://site", { method: "POST", body: JSON.stringify({ feeDeal: buyer }) }), params),
      await status(new Request("http://site"), params),
      await status(new Request("http://site"), { params: Promise.resolve({ mission: "bad" }) }),
      // Demo routes on their refusal paths (no chain is reached from a test).
      await demoStart(new Request("http://site", { method: "POST", body: JSON.stringify({ goal: "x" }) })),
      await demoApprove(new Request("http://site", { method: "POST", body: JSON.stringify({ stage: 0 }) }), { params: Promise.resolve({ mission: "../x" }) }),
      await demoRelease(new Request("http://site", { method: "POST", body: JSON.stringify({ feeDeal: "x" }) }), { params: Promise.resolve({ mission: "../x" }) }),
    ];
    const bodies = await Promise.all(responses.map(async (r) => `${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`));
    assert.equal(responses[0]!.status, 200);
    assert.equal(responses[5]!.status, 400);
    const demoKey = process.env.DEMO_BUYER_KEY!;
    for (const text of [...bodies, ...seen]) {
      assert.ok(!text.includes(FAKE_MODEL_KEY) && !text.includes("Zq7Zq7"), `model key leaked: ${text.slice(0, 200)}`);
      assert.ok(!text.includes(demoKey), "demo key leaked");
    }
  });
});

test("demo routes refuse without DEMO_BUYER_KEY (the button is hidden then)", async () => {
  const saved = process.env.DEMO_BUYER_KEY;
  delete process.env.DEMO_BUYER_KEY;
  try {
    const r = await demoStart(new Request("http://site", { method: "POST", body: JSON.stringify({ goal: "3 days in Lisbon" }) }));
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { reason: string }).reason, "NOT_CONFIGURED");
  } finally {
    if (saved !== undefined) process.env.DEMO_BUYER_KEY = saved;
  }
});
