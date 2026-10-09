// #270 (peaq v2): the robot earns. Stub JobChain and PeaqClient (no network): happy path, resume after each failed
// step, refusals by name, a peaq failure after the release retried without paying twice, planJob, signDropOff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Address } from "@solana/kit";
import {
  canonicalDropOff, memoryLedger, planJob, runJob, signDropOff, verifyDropOff,
  type JobChain, type PeaqClient, type Settlement,
} from "../../src/index.ts";

const robotSecret = new Uint8Array(32).fill(5);
const robotPublic = ed25519.getPublicKey(robotSecret);
const DEAL = "BQ2UX41FDmdg8UyGFQQLjqW8T8GovFTiN3S9AsCFvP3x" as Address;
const refused = (reason: string) => ({ ok: false as const, reason, message: reason });

type Step = "openDeal" | "accept" | "deliver" | "release";
function stubChain(fail: Partial<Record<Step, string>> = {}) {
  const calls: string[] = [];
  const hashes: Uint8Array[] = [];
  const chain: JobChain = {
    async openDeal() { calls.push("openDeal"); return fail.openDeal ? refused(fail.openDeal) : { ok: true, signature: "open", deal: DEAL }; },
    async accept() { calls.push("accept"); return fail.accept ? refused(fail.accept) : { ok: true, signature: "accept" }; },
    async deliver(_d, h) { calls.push("deliver"); hashes.push(h); return fail.deliver ? refused(fail.deliver) : { ok: true, signature: "deliver" }; },
    async release(_d, h) { calls.push("release"); hashes.push(h); return fail.release ? refused(fail.release) : { ok: true, signature: "release" }; },
  };
  return { chain, calls, hashes, fail };
}
function stubPeaq(failFirst = 0) {
  const events: { id: bigint; s: Settlement }[] = [];
  let left = failFirst;
  const peaq: PeaqClient = {
    async submitRevenueEvent(id, s) { if (left-- > 0) return refused("PEAQ_SUBMIT_FAILED"); events.push({ id, s }); return { ok: true, txHash: "0xevent" }; },
    async submitActivityEvent() { throw new Error("jobs write a revenue event only"); },
    async queryMcr() { return refused("MCR_NOT_SERVED"); },
  };
  return { peaq, events };
}
const req = { jobId: "job-1", amount: 500_000n, km: 3, nowSecs: 1_800_000_000 };
const deps = (chain: JobChain, peaq: PeaqClient, ledger = memoryLedger()) => ({ chain, peaq, ledger, robotSecret, robotMachineId: 348n });

test("happy path: four steps in order, revenue event for the robot linked to the release", async () => {
  const c = stubChain();
  const p = stubPeaq();
  const r = await runJob(deps(c.chain, p.peaq), req);
  assert.deepEqual(r, { ok: true, deal: DEAL, releaseSig: "release", robotEventTx: "0xevent" });
  assert.deepEqual(c.calls, ["openDeal", "accept", "deliver", "release"]);
  assert.deepEqual(c.hashes[0], c.hashes[1]);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0]!.id, 348n);
  assert.equal(p.events[0]!.s.releaseSignature, "release");
  assert.equal(p.events[0]!.s.amount, 500_000n);
  assert.deepEqual(p.events[0]!.s.deliveryHash, c.hashes[0]);
});

for (const step of ["openDeal", "accept", "deliver", "release"] as const) {
  test(`resume: a refused ${step} surfaces by name, and the retry repeats only that step onward`, async () => {
    const ledger = memoryLedger();
    const p = stubPeaq();
    const bad = stubChain({ [step]: "PROGRAM_REFUSED" });
    const r1 = await runJob(deps(bad.chain, p.peaq, ledger), req);
    assert.deepEqual(r1.ok ? null : r1.reason, "PROGRAM_REFUSED");
    assert.equal(p.events.length, 0);
    const good = stubChain();
    // Even if the clock moved, the resumed run must keep one delivery hash.
    const r2 = await runJob(deps(good.chain, p.peaq, ledger), { ...req, nowSecs: req.nowSecs + 600 });
    assert.equal(r2.ok, true);
    const order: Step[] = ["openDeal", "accept", "deliver", "release"];
    assert.deepEqual(good.calls, order.slice(order.indexOf(step)));
    assert.equal(p.events.length, 1);
    if (step === "release") assert.deepEqual(good.hashes[0], Uint8Array.from(Buffer.from(ledger.all().get("job-1")!.deliveryHash!, "hex")));
  });
}

test("peaq failure after the release is recorded and retried without paying twice", async () => {
  const ledger = memoryLedger();
  const c = stubChain();
  const p = stubPeaq(1);
  const r1 = await runJob(deps(c.chain, p.peaq, ledger), req);
  assert.equal(r1.ok, false);
  assert.equal(r1.ok ? "" : r1.reason, "PEAQ_SUBMIT_FAILED");
  assert.equal(ledger.all().get("job-1")!.releaseSig, "release");
  assert.equal(ledger.all().get("job-1")!.robotEventTx, undefined);
  const r2 = await runJob(deps(c.chain, p.peaq, ledger), req);
  assert.equal(r2.ok, true);
  assert.equal(c.calls.filter((x) => x === "release").length, 1);
  assert.equal(c.calls.length, 4);
  assert.equal(p.events.length, 1);
  // A finished job is a no-op.
  await runJob(deps(c.chain, p.peaq, ledger), req);
  assert.equal(c.calls.length, 4);
  assert.equal(p.events.length, 1);
});

test("bad inputs are refused before anything is sent", async () => {
  const c = stubChain();
  const p = stubPeaq();
  const a = await runJob(deps(c.chain, p.peaq), { ...req, jobId: "" });
  const b = await runJob(deps(c.chain, p.peaq), { ...req, amount: 0n });
  const d = await runJob(deps(c.chain, p.peaq), { ...req, km: -1 });
  assert.deepEqual([a, b, d].map((x) => (x.ok ? "" : x.reason)), ["BAD_JOB_ID", "BAD_AMOUNT", "BAD_DROP_OFF"]);
  assert.equal(c.calls.length, 0);
});

test("planJob: defaults, interval, low battery, and never below lowPct", () => {
  const now = 1_800_000_000;
  const b = (levelPct: number) => ({ levelPct, updatedAt: now });
  assert.deepEqual(planJob(b(80), null, { nowSecs: now }), { take: true, km: 3 });
  assert.deepEqual(planJob(b(80), now - 4 * 3600, { nowSecs: now }), { take: true, km: 3 });
  const recent = planJob(b(80), now - 3600, { nowSecs: now });
  assert.equal(recent.take, false);
  assert.match(recent.take ? "" : recent.reason, /180 min/);
  const low = planJob(b(30), null, { nowSecs: now });
  assert.equal(low.take, false);
  assert.match(low.take ? "" : low.reason, /35%/);
  // 38% passes minPct 35 but 38 - 15 = 23 < lowPct 25
  const trip = planJob(b(38), null, { nowSecs: now });
  assert.equal(trip.take, false);
  assert.match(trip.take ? "" : trip.reason, /below 25%/);
  assert.equal(planJob(b(40), null, { nowSecs: now }).take, true);
  // custom lowPct and drain
  assert.equal(planJob(b(50), null, { nowSecs: now, lowPct: 40 }).take, false);
  assert.equal(planJob(b(50), null, { nowSecs: now, lowPct: 40, drainPct: 10, minPct: 40 }).take, true);
});

test("signDropOff: canonical JSON, hash is sha256 of it, signature verifies only for this drop-off and key", () => {
  const d = { jobId: "job-1", robotId: "348", at: 1_800_000_000, km: 3 };
  const s = signDropOff(d, robotSecret);
  assert.equal(new TextDecoder().decode(canonicalDropOff(d)), '{"at":1800000000,"jobId":"job-1","km":3,"robotId":"348"}');
  assert.deepEqual(s.deliveryHash, sha256(canonicalDropOff(d)));
  assert.equal(verifyDropOff(s.dropOff, s.signature, robotPublic), true);
  assert.equal(verifyDropOff({ ...d, km: 9 }, s.signature, robotPublic), false);
  assert.equal(verifyDropOff(d, s.signature, ed25519.getPublicKey(new Uint8Array(32).fill(6))), false);
  assert.equal(verifyDropOff(d, new Uint8Array(64), robotPublic), false);
  assert.equal(verifyDropOff({ ...d, jobId: "" }, s.signature, robotPublic), false);
});
