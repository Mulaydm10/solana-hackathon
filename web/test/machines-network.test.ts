// Machines v2 (#273): tick order, a failing step not stopping the next, the power route, the v1 fallback and the status
// shape. Chain, peaq, log reading and storage are all stubbed; nothing touches a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLedger, signHeartbeat, type Heartbeat, type InsuranceChain, type JobChain, type MachineEvent, type PeaqClient } from "@deal/agents/machines";
import {
  blobNetworkStore, networkPrelude, parseNetworkEnv, routeCharge, setPadPower, verifiedBeats, type NetworkConfig, type NetworkDeps, type PadCfg,
} from "../lib/machines-network.ts";
import { networkStatus } from "../lib/machines-network-status.ts";
import { withNetwork } from "../lib/machines-network-server.ts";
import { handlePower } from "../lib/machines-power.ts";
import { robotTick, SLOT_SECS, type MachineDeps, type RobotDecision, type RobotTickDeps, type StoredBattery, type ChargeView } from "../lib/machines.ts";
import { fileBlobs } from "../lib/storage.ts";
import { POST as powerRoute } from "../app/api/machines/power/route.ts";

const T0 = 1_800_000_000 - (1_800_000_000 % SLOT_SECS);
const SECRET = randomBytes(20).toString("hex");
const A = ["So11111111111111111111111111111111111111112", "Sysvar1111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111"];
const peaqKey = () => `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
const keyArr = () => JSON.stringify(Array.from(randomBytes(64)));

type Rig = ReturnType<typeof rig>;
async function rig(o: { failScores?: boolean; failOpenPolicy?: boolean; failJob?: boolean; battery?: StoredBattery; events?: Record<string, MachineEvent[]>; llm?: NetworkDeps["llm"] } = {}) {
  const log: string[] = [];
  const keys = { pad: peaqKey(), pad2: peaqKey(), pad3: peaqKey() };
  const pads: PadCfg[] = [];
  const prices = { pad: 320_000n, pad2: 280_000n, pad3: 300_000n };
  for (const [i, role] of (["pad", "pad2", "pad3"] as const).entries()) {
    const beat = await signHeartbeat("1", 0, keys[role]);
    pads.push({ role, name: role, machineId: BigInt(100 + i), address: A[i]! as PadCfg["address"], peaqAddress: beat.address, pricePerKwhMicro: prices[role] });
  }
  const cfg: NetworkConfig = { pads, insurer: A[3]! as NetworkConfig["insurer"], verifier: A[3]! as NetworkConfig["verifier"], shop: A[3]! as NetworkConfig["shop"], mission: A[3]! as NetworkConfig["mission"] };
  const store = blobNetworkStore(fileBlobs(mkdtempSync(join(tmpdir(), "net-"))));
  let battery: StoredBattery | null = o.battery ?? null;
  const peaq: PeaqClient = {
    submitRevenueEvent: async () => { log.push("peaq.revenue"); return { ok: true, txHash: "0xrev" }; },
    submitActivityEvent: async () => ({ ok: true, txHash: "0xact" }),
    submitOutageEvent: async () => ({ ok: true, txHash: "0xout" }),
    queryMcr: async () => ({ ok: false, reason: "MCR_NOT_SERVED", message: "x" }),
  };
  const insChain = (role: string): InsuranceChain => ({
    openPolicy: async () => { log.push(`ins.open.${role}`); return o.failOpenPolicy ? { ok: false, reason: "SimulatedRefusal", message: "no" } : { ok: true, signature: `open-${role}`, deal: A[0] as never }; },
    accept: async () => { log.push(`ins.accept.${role}`); return { ok: true, signature: "acc" }; },
    payPremium: async () => { log.push(`ins.premium.${role}`); return { ok: true, signature: "prem" }; },
    fileClaim: async () => ({ ok: true, signature: "claim" }), challenge: async () => ({ ok: true, signature: "ch" }),
    claim: async () => ({ ok: true, signature: "pay" }), refund: async () => ({ ok: true, signature: "ref" }),
  });
  const jobChain: JobChain = {
    openDeal: async (id) => { log.push(`job.open.${id}`); return o.failJob ? { ok: false, reason: "ShopBroke", message: "no" } : { ok: true, signature: "jo", deal: A[1] as never }; },
    accept: async () => ({ ok: true, signature: "ja" }), deliver: async () => ({ ok: true, signature: "jd" }), release: async () => ({ ok: true, signature: "jr" }),
  };
  const nd: NetworkDeps = {
    cfg, robotMachineId: 7n, store, battery: { get: async () => battery, put: async (b) => void (battery = b) },
    signBeat: async (pad, t) => { log.push(`beat.${pad.role}`); return signHeartbeat(pad.machineId.toString(), t, keys[pad.role as keyof typeof keys]); },
    insuranceDeps: (pad) => ({ chain: insChain(pad.role), peaq, padMachineId: pad.machineId, padAddress: pad.peaqAddress }),
    job: { chain: jobChain, peaq, ledger: memoryLedger(), robotSecret: randomBytes(32), robotMachineId: 7n },
    headBlock: async () => { log.push("head"); if (o.failScores) throw new Error("rpc down"); return 1_000_000n; },
    readEvents: async (id) => { log.push(`events.${id}`); return { ok: true, events: o.events?.[id.toString()] ?? [], toBlock: 1_000_000n }; },
    allowedPayees: async () => pads.map((p) => p.address),
    ...(o.llm ? { llm: o.llm } : {}),
  };
  const decisions: RobotDecision[] = [];
  const charges: { amount: bigint; kWh: string; pad?: string }[] = [];
  const tick: RobotTickDeps = {
    battery: nd.battery, decisions: { list: async () => decisions, add: async (x) => void decisions.unshift(x) },
    mandate: async () => ({ perTxCap: 500_000n, cap: 5_000_000n, spent: 0n, live: true }),
    charge: async (amount, kWh, _by, pad) => {
      charges.push({ amount, kWh, pad }); log.push(`charge.${pad}`);
      return { id: "c1", at: T0, amount: "x", kWh, by: "robot", pad, openSig: "o", releaseSig: "r" } satisfies ChargeView;
    },
    prelude: (now) => networkPrelude(nd, now),
    route: (dec, mandate) => routeCharge(nd, dec, mandate),
  };
  return { nd, tick, log, store, cfg, decisions, charges, battery: () => battery, keys };
}

function events(machineId: bigint, role: "good" | "none", now: number): MachineEvent[] {
  if (role === "none") return [];
  const out: MachineEvent[] = [];
  for (let d = 0; d < 20; d++) {
    for (const [k, type, value] of [[0, 0, 20n], [1, 1, 0n]] as const) {
      out.push({ machineId, index: BigInt(d * 2 + k), eventType: type, value, timestamp: now - d * 86_400 - 3600 * (k + 1), txHash: "0x1", block: 1n });
    }
  }
  return out;
}

// ---------- the order, and a failure that does not stop the rest ----------

test("tick: scores, heartbeats, insurance, job in that order, then the charge goes to the chosen pad", async () => {
  const r = await rig();
  const a = await robotTick(r.tick, T0);
  const rep = a.network as { steps: { step: string; ok: boolean; detail?: string }[] };
  assert.deepEqual(rep.steps.map((s) => s.step), ["scores", "heartbeats", "insurance", "job"]);
  assert.ok(rep.steps.every((s) => s.ok), JSON.stringify(rep.steps));
  const idx = (p: string) => r.log.findIndex((x) => x.startsWith(p));
  assert.ok(idx("head") < idx("beat.") && idx("beat.") < idx("ins.open") && idx("ins.open") < idx("job.open"));
  assert.ok(r.log.includes("job.open.job-" + T0), "job ids carry the job- prefix");
  // job drained the simulated battery by 15 points and the robot waited (45 % is above the 25 % low mark)
  assert.equal(Math.round(r.battery()!.levelPct), 45);
  assert.equal(a.decision.action, "wait");
  // second tick: robot is low now; no job (too low), insurance already active, the charge goes to the cheapest pad
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0 + SLOT_SECS, lastSlot: Math.floor(T0 / SLOT_SECS) });
  const b = await robotTick(r.tick, T0 + SLOT_SECS);
  assert.equal(b.decision.action, "charge");
  assert.equal(b.decision.chosenPad, "pad2", "lowest effective price among online pads (all Provisioned: x1.25)");
  assert.match(b.decision.choiceReason ?? "", /lowest effective price/);
  assert.equal(b.decision.choiceBy, "robot");
  assert.equal(r.charges.at(-1)!.pad, "pad2");
  assert.equal(r.charges.at(-1)!.amount % 10_000n, 0n);
  assert.ok(r.log.lastIndexOf("charge.pad2") > r.log.lastIndexOf("beat.pad3"), "the charge is the last step");
  assert.equal(r.log.filter((x) => x.startsWith("ins.open")).length, 3, "one policy per pad, none re-quoted while active");
});

test("tick: a failing step is recorded and the next steps still run", async () => {
  const r = await rig({ failScores: true, failOpenPolicy: true });
  const a = await robotTick(r.tick, T0);
  const steps = (a.network as { steps: { step: string; ok: boolean; detail?: string }[] }).steps;
  assert.equal(steps[0]!.ok, false);
  assert.match(steps[0]!.detail!, /rpc down/);
  assert.equal(steps[1]!.ok, true, "heartbeats still ran");
  assert.equal(steps[2]!.ok, false);
  assert.match(steps[2]!.detail!, /SimulatedRefusal/);
  assert.equal(steps[3]!.ok, true, "the job still ran");
  assert.ok(r.log.some((x) => x.startsWith("job.open")));
  assert.ok(a.decision, "the robot still decided");
});

test("tick: a failing job stays pending and resumes on the next tick; a prelude that throws does not stop the robot", async () => {
  const r = await rig({ failJob: true });
  const a = await robotTick(r.tick, T0);
  const job = (a.network as { steps: { step: string; ok: boolean; detail?: string }[] }).steps[3]!;
  assert.equal(job.ok, false);
  assert.equal((await r.store.jobs()).pending?.id, `job-${T0}`);
  const t2 = { ...r.tick, prelude: async () => { throw new Error("boom"); } };
  const b = await robotTick(t2, T0 + SLOT_SECS);
  assert.deepEqual(b.network, { error: "the network steps could not run" });
  assert.ok(b.decision);
});

test("tick: scores come from the peaq logs, are cached, and set the premium by the pad's grade", async () => {
  const r = await rig({ events: { "101": events(101n, "good", T0) } });
  await robotTick(r.tick, T0);
  const cache = await r.store.scores();
  assert.equal(cache!.scores.pad2!.grade, "AAA");
  assert.equal(cache!.scores.pad!.grade, "Provisioned");
  const pols = await r.store.policies();
  const p2 = pols.find((p) => p.pad === r.cfg.pads[1]!.address)!;
  const p1 = pols.find((p) => p.pad === r.cfg.pads[0]!.address)!;
  assert.equal(p2.grade, "AAA");
  assert.equal(p2.premium, "20000", "1 USDC x 2 % per day, whole cents");
  assert.equal(p1.premium, "200000", "Provisioned: 20 %");
  assert.equal(p2.status, "active");
  // scores are read once per tick: one head read, one getLogs call set per machine
  assert.equal(r.log.filter((x) => x === "head").length, 1);
  assert.equal(r.log.filter((x) => x.startsWith("events.")).length, 4, "robot and three pads, once each");
});

test("tick: an offline pad signs no heartbeat and is not insured or chosen", async () => {
  const r = await rig();
  await setPadPower(r.store, r.cfg, { pad: "pad2", online: false });
  await robotTick(r.tick, T0);
  assert.ok(!r.log.includes("beat.pad2"));
  assert.ok(r.log.includes("beat.pad") && r.log.includes("beat.pad3"));
  assert.equal(r.log.filter((x) => x === "ins.open.pad2").length, 0);
  assert.equal((await verifiedBeats(r.store, r.cfg.pads[1]!)).length, 0);
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0 + SLOT_SECS, lastSlot: 0 });
  const b = await robotTick(r.tick, T0 + SLOT_SECS);
  assert.equal(b.decision.chosenPad, "pad3", "pad2 is cheapest but offline");
});

test("tick: no eligible pad means the robot waits and says why", async () => {
  const r = await rig();
  for (const p of r.cfg.pads) await setPadPower(r.store, r.cfg, { pad: p.role, online: false });
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0, lastSlot: 0 });
  const b = await robotTick(r.tick, T0);
  assert.equal(b.decision.action, "wait");
  assert.match(b.decision.reason, /no eligible pad/);
  assert.equal(r.charges.length, 0);
});

test("choice: Claude may choose among the eligible pads but the amount is priced in code at that pad", async () => {
  const llm = async () => '{"role":"pad3","reason":"best uptime"}';
  const r = await rig({ llm });
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0, lastSlot: 0 });
  const b = await robotTick(r.tick, T0);
  assert.equal(b.decision.chosenPad, "pad3");
  assert.equal(b.decision.choiceBy, "claude");
  assert.match(b.decision.choiceReason!, /best uptime/);
  const c = r.charges[0]!;
  const milli = (c.amount * 1000n) / 300_000n;
  assert.ok(BigInt(c.kWh.replace(".", "")) <= milli + 1n, "kWh x pad3's price does not exceed the amount");
  assert.equal(c.amount % 10_000n, 0n);
  assert.ok(c.amount <= 500_000n, "capped by the mandate's per-charge limit");
});

test("heartbeats: stored beats are verified on read; a forged one is ignored", async () => {
  const r = await rig();
  await robotTick(r.tick, T0);
  const pad = r.cfg.pads[0]!;
  const good = (await verifiedBeats(r.store, pad))[0]!;
  const forged: Heartbeat = { ...good, sentAt: good.sentAt + 5 };
  await r.store.addBeat(pad.role, forged);
  assert.equal((await verifiedBeats(r.store, pad)).length, 1);
});

// ---------- env, fallback, status ----------

function fullEnv(r: Rig extends Promise<infer T> ? T : never): Record<string, string | undefined> {
  const k = (n: number) => JSON.stringify(Array.from({ length: 64 }, (_, i) => (i + n) % 256));
  return {
    PAD_KEY: k(1), PAD2_KEY: k(2), PAD3_KEY: k(3), INSURER_KEY: k(4), SHOP_KEY: k(5),
    PAD_PEAQ_KEYS: JSON.stringify(r.keys), INSURANCE_VERIFIER: A[3],
    MACHINE_NETWORK: JSON.stringify({
      pads: r.cfg.pads.map((p) => ({ role: p.role, machineId: p.machineId.toString(), address: p.address, peaqAddress: p.peaqAddress, pricePerKwhMicro: p.pricePerKwhMicro.toString() })),
      insurer: A[3], verifier: A[3], shop: A[3], mission: A[3],
    }),
  };
}

test("env: all v2 variables parse; each missing part is named (never a value) and means v1", async () => {
  const r = await rig();
  const env = fullEnv(r);
  assert.equal(parseNetworkEnv(env).ok, true);
  for (const [name, part] of [["PAD2_KEY", "pads"], ["INSURER_KEY", "insurance"], ["INSURANCE_VERIFIER", "insurance"], ["SHOP_KEY", "shop"], ["PAD_PEAQ_KEYS", "heartbeats"], ["MACHINE_NETWORK", "network"]] as const) {
    const p = parseNetworkEnv({ ...env, [name]: undefined });
    assert.equal(p.ok, false, name);
    if (!p.ok) assert.ok(p.missing.some((m) => m.part === part && m.vars.includes(name)), name);
  }
  const bad = parseNetworkEnv({ ...env, SHOP_KEY: "[1,2,3]" });
  assert.equal(!bad.ok && JSON.stringify(bad.missing).includes("1,2,3"), false, "no value in the answer");
});

test("v1 fallback: without the v2 variables the tick deps come back untouched", async () => {
  const base = { sentinel: true } as unknown as RobotTickDeps;
  const out = await withNetwork(base, {} as never, {} as never, {});
  assert.equal(out, base, "same object: no prelude, no route, v1 behaviour");
  assert.equal(base.prelude, undefined);
});

test("v1 fallback: a v1 tick through robotTick has no network section and no pad choice", async () => {
  const r = await rig();
  const { prelude: _p, route: _r, ...v1 } = r.tick;
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0, lastSlot: 0 });
  const a = await robotTick(v1, T0);
  assert.equal(a.network, undefined);
  assert.equal(a.decision.chosenPad, undefined);
  assert.equal(a.decision.action, "charge");
});

// ---------- the power route ----------

const V1ENV = {
  DEAL_CLUSTER: "devnet", ROBOT_AGENT_KEY: keyArr(), PAD_KEY: keyArr(), MACHINE_MISSION: A[3],
  PEAQ_EVENT_KEY: `0x${"ab".repeat(32)}`, PEAQ_RPC_URL: "https://peaq.example", PEAQ_DEPLOYMENT: "agung-2026-08-28", PEAQ_EVENT_REGISTRY: `0x${"1".repeat(40)}`,
  PEAQ_SOURCE_CHAIN_ID: "0", ROBOT_MACHINE_ID: "13", PAD_MACHINE_ID: "12", MACHINE_TICK_SECRET: SECRET,
};
const post = (body: unknown, auth?: string) => new Request("http://x/api/machines/power", { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) });

test("power: 401 without the secret (constant-time compare), 503 when not configured, 400 on bad input, 200 sets the switch", async () => {
  const r = await rig();
  const env = { ...V1ENV, ...fullEnv(r) };
  const stores = () => r.store;
  for (const a of [undefined, "Bearer nope", `Bearer ${SECRET}x`, SECRET]) {
    const res = await handlePower(post({ pad: "pad2", online: false }, a), env, stores);
    assert.equal(res.status, 401, String(a));
    assert.ok(!(await res.text()).includes(SECRET));
  }
  const { MACHINE_TICK_SECRET: _s, ...noSecret } = env;
  assert.equal((await handlePower(post({ pad: "pad2", online: false }, `Bearer ${SECRET}`), noSecret, stores)).status, 503);
  assert.equal((await handlePower(post({ pad: "pad2", online: false }, `Bearer ${SECRET}`), V1ENV, stores)).status, 503, "v2 not configured");
  const { ROBOT_AGENT_KEY: _k, ...noMachines } = env;
  assert.equal((await handlePower(post({}, `Bearer ${SECRET}`), noMachines, stores)).status, 503);
  const auth = `Bearer ${SECRET}`;
  assert.equal((await handlePower(post({ pad: "robot", online: false }, auth), env, stores)).status, 400);
  assert.equal((await handlePower(post({ pad: "pad2", online: "no" }, auth), env, stores)).status, 400);
  const ok = await handlePower(post({ pad: "pad2", online: false }, auth), env, stores);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, pad: "pad2", online: false });
  assert.equal((await r.store.power()).pad2, false);
  await handlePower(post({ pad: "pad2", online: true }, auth), env, stores);
  assert.equal((await r.store.power()).pad2, true);
});

test("power: the real route answers 503 with no machines env", async () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(V1ENV)) delete process.env[k];
    assert.equal((await powerRoute(post({ pad: "pad", online: true }, `Bearer ${SECRET}`))).status, 503);
  } finally {
    process.env = saved;
  }
});

// ---------- the status shape ----------

/** The shape of a JSON value: object keys recursively, arrays by their first element, scalars by type. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? "null" : typeof v;
}

test("status: the v2 additions have the shape of web/test/fixtures/machines-status-v2.json", async () => {
  const r = await rig({ events: { "101": events(101n, "good", T0) } });
  await robotTick(r.tick, T0);
  await r.nd.battery.put({ levelPct: 10, updatedAt: T0 + SLOT_SECS, lastSlot: 0 });
  await robotTick(r.tick, T0 + SLOT_SECS);
  const history: ChargeView[] = [{ id: "c1", at: T0, amount: "0.40", kWh: "1.200", releaseSig: "r", openSig: "o", pad: "pad2" }];
  const s = await networkStatus(r.store, r.cfg, history, T0 + SLOT_SECS + 60);
  const fx = JSON.parse(readFileSync(new URL("./fixtures/machines-status-v2.json", import.meta.url), "utf8")) as Record<string, unknown>;
  for (const k of ["v2", "network", "scores", "insurance", "earnings"] as const) {
    const live = shape(s[k]) as Record<string, unknown>;
    const want = shape(fx[k]) as Record<string, unknown>;
    // optional keys (signatures that exist only after a step) may be absent in one and present in the other
    const strip = (x: unknown): unknown => (Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([kk]) => !/Sig$|^deal$|^outage$|^reason$|^peaqEventTx$|^insurerCheck$|^simulated$/.test(kk)).map(([kk, vv]) => [kk, strip(vv)])) : x);
    assert.deepEqual(strip(live), strip(want), k);
  }
  assert.deepEqual(Object.keys(fx).sort(), ["battery", "decisions", "deployment", "earnings", "explorerTx", "history", "insurance", "machines", "mission", "network", "ok", "rules", "scores", "totals", "v2"]);
  const d = (fx.decisions as RobotDecision[]).find((x) => x.chosenPad);
  assert.ok(d && d.choiceReason && d.choiceBy, "the fixture carries a decision with its pad choice");
  // spot checks on the live values
  assert.equal(s.network.length, 3);
  assert.equal(s.network[1]!.pricePerKwh, "0.28");
  assert.equal(s.network[1]!.grade, "AAA");
  assert.equal(s.network[0]!.online, true);
  assert.equal(s.insurance.policies[0]!.coverage, "1.00");
  assert.ok("robot" in s.scores);
  assert.equal(s.earnings.jobs, 1);
  assert.equal(s.earnings.earned, "0.30");
  assert.equal(s.earnings.spentOnEnergy, "0.40");
  assert.equal(s.earnings.net, "-0.10");
  assert.ok(s.earnings.recent[0]!.id.startsWith("job-"));
  console.log("sample status.network[1]:", JSON.stringify(s.network[1]));
});

test("status: an outage is simulated and labelled: policy claimed with the outage proof", async () => {
  const r = await rig();
  await robotTick(r.tick, T0);
  await setPadPower(r.store, r.cfg, { pad: "pad3", online: false });
  const later = T0 + 3 * SLOT_SECS; // 90 minutes of silence, past the 65-minute outage threshold
  const rep = await networkPrelude(r.nd, later);
  assert.ok(rep.steps.every((s) => s.ok), JSON.stringify(rep.steps));
  const p = (await r.store.policies()).find((x) => x.pad === r.cfg.pads[2]!.address)!;
  assert.equal(p.status, "claimed");
  assert.equal(p.outage!.peaqEventTx, "0xout");
  const s = await networkStatus(r.store, r.cfg, [], later);
  const v = s.insurance.policies.find((x) => x.pad === "pad3")!;
  assert.equal(v.status, "claimed");
  assert.equal(v.outage?.simulated, true);
  assert.equal(s.network[2]!.online, false);
});

// ---------- the real wiring (signers and chains are built; nothing is sent) ----------

test("wiring: with every v2 variable set the tick gets prelude, route and a per-pad charge path; a key that does not match its address is refused", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const kp = async () => { const seed = randomBytes(32); const b = Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]); return { b, arr: JSON.stringify(Array.from(b)), address: (await createKeyPairSignerFromBytes(b)).address as string }; };
  const [robot, pad, pad2, pad3, insurer, shop] = await Promise.all([kp(), kp(), kp(), kp(), kp(), kp()]);
  const keys = { pad: peaqKey(), pad2: peaqKey(), pad3: peaqKey() };
  const net = (padAddr: string) => ({
    pads: [["pad", pad.address, "12"], ["pad2", pad2.address, "14"], ["pad3", pad3.address, "15"]].map(([role, address, id], i) => ({ role, machineId: id, address: role === "pad" ? padAddr : address, peaqAddress: `0x${(i + 1).toString(16).repeat(40)}`, pricePerKwhMicro: "300000" })),
    insurer: insurer.address, verifier: A[3], shop: shop.address, mission: A[3],
  });
  const raw = (padAddr: string) => ({
    PAD_KEY: pad.arr, PAD2_KEY: pad2.arr, PAD3_KEY: pad3.arr, INSURER_KEY: insurer.arr, SHOP_KEY: shop.arr, PAD_PEAQ_KEYS: JSON.stringify(keys),
    INSURANCE_VERIFIER: A[3], MACHINE_NETWORK: JSON.stringify(net(padAddr)), DEAL_MACHINES_DIR: mkdtempSync(join(tmpdir(), "wire-")),
  });
  const env = { ROBOT_AGENT_KEY: robot.arr, PEAQ_RPC_URL: "https://peaq.example", PEAQ_EVENT_REGISTRY: `0x${"1".repeat(40)}` } as never;
  const rt = { ctx: {}, peaq: {}, deps: { ledger: memoryLedger() }, battery: { get: async () => null, put: async () => undefined }, robotMachineId: 13n, robot: robot.address, mission: A[3] } as never;
  const base = { battery: {}, decisions: {}, mandate: async () => ({}), charge: async () => ({}) } as unknown as RobotTickDeps;
  const wired = await withNetwork(base, rt, env, raw(pad.address));
  assert.equal(typeof wired.prelude, "function");
  assert.equal(typeof wired.route, "function");
  const mismatch = await withNetwork(base, rt, env, raw(A[0]!));
  assert.equal(mismatch, base, "a key that is not the network's pad falls back to v1");
});
