// /machines (#229, peaq track): fixed amounts, rate limits, fail-closed config, the simulate-first client (an
// over-limit charge is refused by the program and nothing is sent), storage and totals. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROGRAM_ERRORS, toRefusal, type DealClient } from "@deal/chain";
import { memoryLedger, type ChargeRecord } from "@deal/agents/machines";
import { parseEnv, requireEnv } from "../lib/env.ts";
import { createLimiter } from "../lib/demo.ts";
import {
  blobHistory, blobLedger, MACHINE_LIMITS, meterKwh, runMachineCharge, simulateFirst, simulationErrorCode, totals, type ChargeHistory, type ChargeView, type MachineDeps,
} from "../lib/machines.ts";
import { fileBlobs } from "../lib/storage.ts";
import { POST as chargeRoute } from "../app/api/machines/charge/route.ts";
import { GET as statusRoute } from "../app/api/machines/status/route.ts";

const code = (name: string) => 6000 + PROGRAM_ERRORS.indexOf(name);
const keyBytes = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
const FULL = {
  DEAL_CLUSTER: "devnet", ROBOT_AGENT_KEY: keyBytes, PAD_KEY: keyBytes, MACHINE_MISSION: "Dea1Address11111111111111111111111111111111",
  PEAQ_EVENT_KEY: `0x${"ab".repeat(32)}`, PEAQ_RPC_URL: "https://peaq.example", PEAQ_DEPLOYMENT: "agung-2026-08-28", PEAQ_EVENT_REGISTRY: `0x${"1".repeat(40)}`,
  PEAQ_SOURCE_CHAIN_ID: "5", ROBOT_MACHINE_ID: "13", PAD_MACHINE_ID: "12",
};

// ---------- config ----------

test("machines: fail closed unless every machine variable is set, and devnet only", () => {
  assert.equal(requireEnv(parseEnv(FULL), "machines").ok, true);
  for (const k of Object.keys(FULL).filter((k) => k !== "DEAL_CLUSTER")) {
    const r = requireEnv(parseEnv({ ...FULL, [k]: undefined }), "machines");
    assert.equal(r.ok, false, `${k} missing should refuse`);
    assert.equal(!r.ok && r.body.reason, "NOT_CONFIGURED");
  }
  const local = requireEnv(parseEnv({ ...FULL, DEAL_CLUSTER: "localnet" }), "machines");
  assert.equal(!local.ok && local.body.message, "the machine demo runs on devnet only");
  assert.equal(parseEnv({ ...FULL, PEAQ_EVENT_KEY: "abc" }).ok, false, "a malformed peaq key is a config error");
});

test("machines: the routes answer 503 NOT_CONFIGURED without the machine variables, and leak nothing", async () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(FULL)) delete process.env[k];
    const c = await chargeRoute(new Request("http://x/api/machines/charge", { method: "POST", body: JSON.stringify({ amount: "0.40" }) }));
    assert.equal(c.status, 503);
    assert.equal(((await c.json()) as { reason: string }).reason, "NOT_CONFIGURED");
    const s = await statusRoute();
    assert.equal(s.status, 503);
  } finally {
    process.env = saved;
  }
});

// ---------- the charge request ----------

function deps(o: { outcome?: "ok" | "refused"; ledger?: ReturnType<typeof memoryLedger> } = {}) {
  const ledger = o.ledger ?? memoryLedger();
  const seen: { amount: bigint; reading: { priceMicroUsdc: bigint; nonce: string; kWh: string } }[] = [];
  const views: ChargeView[] = [];
  const history: ChargeHistory = { list: async () => views, add: async (v) => void views.unshift(v) };
  let n = 0;
  const d: MachineDeps = {
    limit: createLimiter(), nowSecs: () => 1_800_000_000, newChargeId: () => `c${++n}`, padId: "pad:12", robotId: "robot:13", ledger, history,
    charge: async (req) => {
      seen.push(req);
      if (o.outcome === "refused") return { ok: false, reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" };
      const rec: ChargeRecord = { deal: "Dea1Address11111111111111111111111111111111" as ChargeRecord["deal"], openSig: "o", acceptSig: "a", deliverSig: "d", releaseSig: "r", deliveryHash: "ff", padEventTx: "0xp", robotEventTx: "0xr" };
      await ledger.put(req.chargeId, rec);
      return { ok: true };
    },
  };
  return { d, seen, views };
}

test("machines: only 0.40 and 0.60 are accepted; anything else is refused before anything runs", async () => {
  const { d, seen } = deps();
  for (const amount of ["0.50", "1", 0.4, "", undefined, "0.40 "]) {
    const r = await runMachineCharge(d, "1.1.1.1", { amount });
    assert.equal(!r.ok && r.reason, "BAD_AMOUNT", String(amount));
  }
  assert.equal(seen.length, 0);
});

test("machines: 0.40 runs one charge with a meter reading priced at exactly that amount", async () => {
  const { d, seen, views } = deps();
  const r = await runMachineCharge(d, "1.1.1.1", { amount: "0.40" });
  assert.ok(r.ok);
  assert.equal(seen[0]!.amount, 400_000n);
  assert.equal(seen[0]!.reading.priceMicroUsdc, 400_000n);
  assert.equal(seen[0]!.reading.nonce, "c1", "the charge id is the reading's nonce");
  assert.equal(r.charge.amount, "0.40");
  assert.equal(r.charge.releaseSig, "r");
  assert.equal(r.charge.refused, undefined);
  assert.equal(views.length, 1);
});

test("machines: a refused charge is a normal result with the program's reason and no transaction", async () => {
  const { d } = deps({ outcome: "refused" });
  const r = await runMachineCharge(d, "1.1.1.1", { amount: "0.60" });
  assert.ok(r.ok);
  assert.deepEqual(r.charge.refused, { reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" });
  assert.equal(r.charge.openSig, undefined);
});

test("machines: per-IP and daily limits", async () => {
  const { d } = deps();
  for (let i = 0; i < MACHINE_LIMITS.chargesPerIpPerHour; i++) assert.ok((await runMachineCharge(d, "9.9.9.9", { amount: "0.40" })).ok);
  const r = await runMachineCharge(d, "9.9.9.9", { amount: "0.40" });
  assert.equal(!r.ok && r.reason, "RATE_LIMITED");
  assert.equal(!r.ok && r.status, 429);
  const day = deps();
  let last;
  for (let i = 0; i <= MACHINE_LIMITS.chargesPerDay; i++) last = await runMachineCharge(day.d, `10.0.0.${i % 250}.${Math.floor(i / 250)}`, { amount: "0.40" });
  assert.equal(last && !last.ok && last.reason, "DAILY_CAP");
});

// ---------- simulate first ----------

function fakeInner() {
  const sent: unknown[] = [];
  const inner: DealClient = { rpc: {} as DealClient["rpc"], sendTransaction: async (ixs) => (sent.push(ixs), { context: { signature: "sig" } }) };
  return { inner, sent };
}

test("simulate first: a program refusal in simulation is never sent, and comes back by name (OverPerTxCap)", async () => {
  const { inner, sent } = fakeInner();
  const c = simulateFirst(inner, async () => ({ InstructionError: [1, { Custom: code("OverPerTxCap") }] }));
  const err = await c.sendTransaction([]).then(() => null, (e: unknown) => e);
  assert.equal(sent.length, 0, "nothing was sent");
  assert.deepEqual(toRefusal(err), { ok: false, reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" });
});

test("simulate first: a passing simulation is sent once; a non-program failure is not sent either", async () => {
  const ok = fakeInner();
  assert.deepEqual(await simulateFirst(ok.inner, async () => null).sendTransaction([]), { context: { signature: "sig" } });
  assert.equal(ok.sent.length, 1);
  const bad = fakeInner();
  const err = await simulateFirst(bad.inner, async () => "AccountNotFound").sendTransaction([]).then(() => null, (e: unknown) => e);
  assert.equal(bad.sent.length, 0);
  assert.equal(toRefusal(err).reason, "CHAIN_ERROR");
  assert.equal(simulationErrorCode({ InstructionError: [0, { Custom: 6011 }] }), 6011);
  assert.equal(simulationErrorCode({ InstructionError: [0, "InvalidAccountData"] }), undefined);
});

// ---------- storage and totals ----------

test("storage: charge records by safe id only; history is newest first, de-duplicated and capped", async () => {
  const blobs = fileBlobs(mkdtempSync(join(tmpdir(), "machines-")));
  const ledger = blobLedger(blobs);
  await ledger.put("c1", { openSig: "o" });
  assert.deepEqual(await ledger.get("c1"), { openSig: "o" });
  assert.equal(await ledger.get("c2"), undefined);
  await assert.rejects(ledger.put("../x", {}), TypeError);
  const h = blobHistory(blobs, 3);
  const v = (id: string): ChargeView => ({ id, at: 1, amount: "0.40", kWh: "1.250" });
  for (const id of ["a", "b", "c", "d", "c"]) await h.add(v(id));
  assert.deepEqual((await h.list()).map((x) => x.id), ["c", "d", "b"]);
});

test("totals: only released charges count as paid; refusals and peaq events are counted", () => {
  const t = totals([
    { id: "1", at: 1, amount: "0.40", kWh: "1.250", releaseSig: "r", padEventTx: "p", robotEventTx: "q" },
    { id: "2", at: 1, amount: "0.40", kWh: "1.250", releaseSig: "r", padEventTx: "p" },
    { id: "3", at: 1, amount: "0.60", kWh: "1.875", refused: { reason: "OverPerTxCap", message: "" } },
    { id: "4", at: 1, amount: "0.40", kWh: "1.250", openSig: "o", refused: { reason: "RPC_UNAVAILABLE", message: "" } },
  ]);
  assert.deepEqual(t, { charges: 2, refused: 1, kWh: "2.500", usdc: "0.80", peaqEvents: 3 });
  assert.equal(meterKwh(400_000n), "1.250");
  assert.equal(meterKwh(600_000n), "1.875");
});
