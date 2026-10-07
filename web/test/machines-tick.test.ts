// The robot's own tick (#253): auth, one decision per slot, at most one charge, battery and decision log, no secret out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { memoryLedger, type MandateLeft } from "@deal/agents/machines";
import { handleTick } from "../lib/machines-tick.ts";
import { POST as tickRoute } from "../app/api/machines/tick/route.ts";
import {
  DECISION_LOG, robotTick, runRobotCharge, SLOT_SECS, totals, type ChargeView, type MachineDeps, type RobotDecision, type RobotTickDeps, type StoredBattery,
} from "../lib/machines.ts";
import { createLimiter } from "../lib/demo.ts";

const SECRET = randomBytes(20).toString("hex"); // 40 chars
const keyBytes = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
const FULL = {
  DEAL_CLUSTER: "devnet", ROBOT_AGENT_KEY: keyBytes, PAD_KEY: keyBytes, MACHINE_MISSION: "Dea1Address11111111111111111111111111111111",
  PEAQ_EVENT_KEY: `0x${"ab".repeat(32)}`, PEAQ_RPC_URL: "https://peaq.example", PEAQ_DEPLOYMENT: "agung-2026-08-28", PEAQ_EVENT_REGISTRY: `0x${"1".repeat(40)}`,
  PEAQ_SOURCE_CHAIN_ID: "0", ROBOT_MACHINE_ID: "13", PAD_MACHINE_ID: "12", MACHINE_TICK_SECRET: SECRET,
};
const T0 = 1_800_000_000 - (1_800_000_000 % SLOT_SECS); // a slot boundary
const LIVE: MandateLeft = { perTxCap: 500_000n, cap: 5_000_000n, spent: 0n, live: true };

function tickDeps(o: { battery?: StoredBattery; mandate?: MandateLeft; refuse?: boolean } = {}) {
  let battery: StoredBattery | null = o.battery ?? null;
  const log: RobotDecision[] = [];
  const charges: { amount: bigint; kWh: string }[] = [];
  const d: RobotTickDeps = {
    battery: { get: async () => battery, put: async (b) => void (battery = b) },
    decisions: { list: async () => log, add: async (x) => void log.unshift(x) },
    mandate: async () => o.mandate ?? LIVE,
    charge: async (amount, kWh) => {
      charges.push({ amount, kWh });
      const id = `c${charges.length}`;
      const base = { id, at: T0, amount: "x", kWh, by: "robot" as const };
      return o.refuse ? { ...base, refused: { reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" } } : { ...base, openSig: "o", releaseSig: "r" };
    },
  };
  return { d, log, charges, battery: () => battery };
}

// ---------- auth ----------

const req = (auth?: string) => new Request("http://x/api/machines/tick", { method: "POST", headers: auth ? { authorization: auth } : {} });
const noDeps = async (): Promise<RobotTickDeps> => { throw new Error("must not be reached"); };

test("tick: 401 on a wrong, missing or different-length secret; the reply holds no secret", async () => {
  for (const a of [undefined, "Bearer nope", `Bearer ${SECRET.slice(0, -1)}x`, `Bearer ${SECRET}extra`, SECRET]) {
    const r = await handleTick(req(a), FULL, noDeps, T0);
    assert.equal(r.status, 401, String(a));
    const text = await r.text();
    assert.ok(!text.includes(SECRET));
    assert.equal((JSON.parse(text) as { reason: string }).reason, "UNAUTHORIZED");
  }
});

test("tick: 503 NOT_CONFIGURED without the secret, and without the machines env", async () => {
  const { MACHINE_TICK_SECRET: _s, ...noSecret } = FULL;
  const a = await handleTick(req(`Bearer ${SECRET}`), noSecret, noDeps, T0);
  assert.equal(a.status, 503);
  assert.equal(((await a.json()) as { reason: string }).reason, "NOT_CONFIGURED");
  const { ROBOT_AGENT_KEY: _k, ...noMachines } = FULL;
  const b = await handleTick(req(`Bearer ${SECRET}`), noMachines, noDeps, T0);
  assert.equal(b.status, 503);
  assert.ok(!(await b.text()).includes(SECRET));
});

test("tick: the real route answers 503 with no machines env and 401-before-runtime is not reachable without it", async () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(FULL)) delete process.env[k];
    const r = await tickRoute(req(`Bearer ${SECRET}`));
    assert.equal(r.status, 503);
  } finally {
    process.env = saved;
  }
});

test("tick: a short MACHINE_TICK_SECRET is a config error, not accepted", async () => {
  const r = await handleTick(req("Bearer short"), { ...FULL, MACHINE_TICK_SECRET: "short" }, noDeps, T0);
  assert.equal(r.status, 500);
});

// ---------- the decision ----------

test("tick: a full battery waits, stores the battery and logs the decision; the JSON never holds the secret", async () => {
  const t = tickDeps();
  const r = await handleTick(req(`Bearer ${SECRET}`), FULL, async () => t.d, T0 + 10);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes(SECRET));
  const j = JSON.parse(text) as { ok: boolean; decision: RobotDecision; battery: Record<string, unknown>; charge?: unknown; duplicate?: boolean };
  console.log("sample tick reply:", text);
  assert.equal(j.ok, true);
  assert.equal(j.decision.action, "wait");
  assert.equal(j.decision.by, "robot");
  assert.equal(j.battery.levelPct, 60);
  assert.equal(j.battery.simulated, true);
  assert.equal(j.charge, undefined);
  assert.equal(t.charges.length, 0);
  assert.equal(t.battery()?.lastSlot, Math.floor((T0 + 10) / SLOT_SECS));
  assert.equal(t.log.length, 1);
});

test("tick: the same slot twice is one action", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  const a = await robotTick(t.d, T0 + 5);
  const b = await robotTick(t.d, T0 + 900);
  assert.equal(a.duplicate, undefined);
  assert.equal(b.duplicate, true);
  assert.deepEqual(b.decision, a.decision);
  assert.equal(t.charges.length, 1);
  assert.equal(t.log.length, 1);
  const c = await robotTick(t.d, T0 + SLOT_SECS + 1);
  assert.equal(c.duplicate, undefined, "the next slot decides again");
});

test("tick: concurrent ticks in one slot charge once", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  const rs = await Promise.all([robotTick(t.d, T0 + 1), robotTick(t.d, T0 + 2), robotTick(t.d, T0 + 3)]);
  assert.equal(t.charges.length, 1);
  assert.equal(rs.filter((r) => r.duplicate).length, 2);
});

test("tick: a low battery charges once, whole cents, credits the battery, logs the charge id", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  const r = await robotTick(t.d, T0);
  assert.equal(t.charges.length, 1);
  assert.equal(t.charges[0]!.amount % 10_000n, 0n);
  assert.ok(t.charges[0]!.amount <= LIVE.perTxCap);
  assert.equal(r.decision.action, "charge");
  assert.equal(r.decision.chargeId, "c1");
  assert.equal(r.decision.kWh, t.charges[0]!.kWh);
  assert.ok(r.battery.levelPct > 10, "credited");
  assert.equal(r.charge?.by, "robot");
});

test("tick: a refused charge is logged with its reason and the battery is not credited", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 }, refuse: true });
  const r = await robotTick(t.d, T0);
  assert.equal(t.charges.length, 1);
  assert.equal(r.battery.levelPct, 10);
  assert.match(r.decision.reason, /OverPerTxCap/);
  assert.equal(r.decision.action, "charge");
});

test("tick: release landed but the peaq event failed: battery credited, 'peaq event pending', no re-buy next slot", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  t.d.charge = async (amount, kWh) => {
    t.charges.push({ amount, kWh });
    return { id: "c1", at: T0, amount: "x", kWh, by: "robot", openSig: "o", releaseSig: "r", refused: { reason: "PEAQ_SUBMIT_FAILED", message: "peaq event write failed" } };
  };
  const r = await robotTick(t.d, T0);
  assert.ok(r.battery.levelPct > 70, "credited");
  assert.match(r.decision.reason, /peaq event pending \(PEAQ_SUBMIT_FAILED\)/);
  assert.doesNotMatch(r.decision.reason, /^refused/);
  const next = await robotTick(t.d, T0 + SLOT_SECS);
  assert.equal(next.decision.action, "wait");
  assert.equal(t.charges.length, 1);
});

test("tick: a charge that throws is logged, not retried in the slot, battery not credited", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  t.d.charge = async () => { throw new Error("rpc down"); };
  const r = await robotTick(t.d, T0);
  assert.equal(r.battery.levelPct, 10);
  assert.match(r.decision.reason, /could not complete/);
  assert.equal((await robotTick(t.d, T0 + 60)).duplicate, true);
});

test("tick: a mandate that is not live waits", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 }, mandate: { ...LIVE, live: false } });
  assert.equal((await robotTick(t.d, T0)).decision.action, "wait");
  assert.equal(t.charges.length, 0);
});

test("tick: the decision log keeps the last 30", async () => {
  const t = tickDeps();
  const { blobDecisions } = await import("../lib/machines.ts");
  const { fileBlobs } = await import("../lib/storage.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const log = blobDecisions(fileBlobs(mkdtempSync(join(tmpdir(), "dec-"))));
  for (let i = 0; i < DECISION_LOG + 5; i++) await log.add({ at: i, action: "wait", reason: `r${i}`, by: "robot" });
  const l = await log.list();
  assert.equal(l.length, 30);
  assert.equal(l[0]!.reason, `r${DECISION_LOG + 4}`);
  void t;
});

// ---------- the internal robot charge ----------

function machineDeps() {
  const seen: { amount: bigint; reading: { priceMicroUsdc: bigint; kWh: string; nonce: string } }[] = [];
  const views: ChargeView[] = [];
  const ledger = memoryLedger();
  const d: MachineDeps = {
    limit: createLimiter(), nowSecs: () => T0, newChargeId: () => "rc1", padId: "pad:12", robotId: "robot:13", ledger,
    history: { list: async () => views, add: async (v) => void views.unshift(v) },
    charge: async (r) => { seen.push(r); await ledger.put(r.chargeId, { releaseSig: "r", openSig: "o" }); return { ok: true }; },
  };
  return { d, seen, views };
}

test("robot charge: reading priced at exactly the decided amount, kWh as decided, nonce = chargeId, by robot", async () => {
  const { d, seen } = machineDeps();
  const v = await runRobotCharge(d, 230_000n, "0.718");
  assert.equal(seen[0]!.reading.priceMicroUsdc, 230_000n);
  assert.equal(seen[0]!.reading.kWh, "0.718");
  assert.equal(seen[0]!.reading.nonce, "rc1");
  assert.equal(v.by, "robot");
  assert.equal(v.amount, "0.23");
  assert.equal(totals([v]).usdc, "0.23", "totals handle any whole-cent amount");
});

test("robot charge: a fraction of a cent or a bad kWh is refused before anything runs", async () => {
  const { d, seen } = machineDeps();
  for (const [a, k] of [[230_001n, "0.718"], [0n, "0.1"], [-5n, "0.718"], [230_000n, "0.7"]] as const) {
    const v = await runRobotCharge(d, a, k);
    assert.equal(v.refused?.reason, "BAD_AMOUNT");
  }
  assert.equal(seen.length, 0);
});

// ---------- Claude as the decision maker ----------

test("anthropicLlm: sends correct headers and body; never logs or returns the key", async () => {
  const { anthropicLlm } = await import("../lib/robot-llm.ts");
  const key = "sk-ant-v1-test-key-" + "x".repeat(60);
  const requests: RequestInit[] = [];
  const stubFetch: typeof fetch = async (url, init) => {
    requests.push(init!);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "wait" }] }), { status: 200 });
  };
  const llm = anthropicLlm(key, stubFetch);
  const result = await llm("system prompt", "user prompt");
  assert.equal(result, "wait");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  const headers = requests[0]!.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], key);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(requests[0]!.body as string) as Record<string, unknown>;
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.max_tokens, 200);
  assert.equal(body.system, "system prompt");
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages[0]?.content, "user prompt");
});

test("anthropicLlm: throws on non-2xx and never includes the key in the error message", async () => {
  const { anthropicLlm } = await import("../lib/robot-llm.ts");
  const key = "sk-ant-v1-test-key-" + "x".repeat(60);
  const stubFetch: typeof fetch = async () => new Response("Unauthorized", { status: 401 });
  const llm = anthropicLlm(key, stubFetch);
  try {
    await llm("system", "user");
    assert.fail("should have thrown");
  } catch (e) {
    const msg = String((e as Error).message);
    assert.ok(!msg.includes(key), "error message must not contain the API key");
    assert.match(msg, /401/);
  }
});

test("tick with a Claude decider: logged decision has by=claude and the decided amount", async () => {
  const { anthropicLlm } = await import("../lib/robot-llm.ts");
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  const stubFetch: typeof fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: '{"action":"charge","kWh":"1.234","reason":"cloud decision"}' }],
  }), { status: 200 });
  const llm = anthropicLlm("test-key", stubFetch);
  const { decideWithModel } = await import("@deal/agents/machines");
  t.d.decider = async (b, mandate) => {
    const telemetry = { battery: b, distanceToPadKm: 1.5, nextDeliveryKm: 3, pricePerKwhMicro: 320_000n };
    return decideWithModel(llm, telemetry, mandate, (await import("@deal/agents/machines")).DEFAULT_ROBOT);
  };
  const r = await robotTick(t.d, T0);
  assert.equal(r.decision.by, "claude");
  assert.equal(r.decision.action, "charge");
  assert.equal(typeof r.decision.amount, "string");
  assert.ok(!r.decision.reason.includes('<'), "reason must not contain unescaped HTML");
});

test("tick without a decider: logged decision has by=robot", async () => {
  const t = tickDeps({ battery: { levelPct: 10, updatedAt: T0, lastSlot: 0 } });
  const r = await robotTick(t.d, T0);
  assert.equal(r.decision.by, "robot");
});
