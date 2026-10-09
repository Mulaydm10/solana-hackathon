import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { choosePad, choosePadWithModel, fleetRules, robotMandate, type PadOffer } from "../../src/machines/index.ts";

const A = "PadAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const B = "PadBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const C = "PadCccccccccccccccccccccccccccccccccccccccc" as Address;
const ROBOT = "RobotRrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" as Address;
const offer = (role: string, id: number, address: Address, price: bigint, score: number, grade: PadOffer["grade"], online = true): PadOffer =>
  ({ role, machineId: BigInt(id), address, pricePerKwhMicro: price, online, score, grade });
const allowed = [A, B, C];

test("eligibility: offline and non-payee pads are skipped", () => {
  const offers = [offer("pad", 349, A, 100_000n, 100, "AAA", false), offer("pad2", 350, B, 500_000n, 80, "A"), offer("pad3", 351, "Other1111111111111111111111111111111111111" as Address, 100_000n, 100, "AAA")];
  const c = choosePad(offers, { allowedPayees: allowed });
  assert.ok(c.ok);
  if (c.ok) { assert.equal(c.pad.role, "pad2"); assert.equal(c.by, "robot"); }
});

test("nobody eligible is a result with a reason, not a throw", () => {
  const c = choosePad([offer("pad", 349, A, 100_000n, 100, "AAA", false)], { allowedPayees: allowed });
  assert.equal(c.ok, false);
  if (!c.ok) assert.match(c.reason, /no eligible pad.*1 offline/);
  assert.equal(choosePad([], { allowedPayees: allowed }).ok, false);
  assert.equal(choosePad([offer("pad", 349, A, 1n, 1, "A")], { allowedPayees: [] }).ok, false);
});

test("formula: price x (1 + (100 - score) / 200), integer micro rounded up", () => {
  const eff = (price: bigint, score: number, grade: PadOffer["grade"]) => {
    const c = choosePad([offer("p", 1, A, price, score, grade)], { allowedPayees: allowed });
    assert.ok(c.ok);
    return c.ok ? c.effectivePriceMicro : 0n;
  };
  assert.equal(eff(320_000n, 100, "AAA"), 320_000n);
  assert.equal(eff(320_000n, 80, "A"), 352_000n);   // x1.10
  assert.equal(eff(320_000n, 0, "B"), 480_000n);    // x1.50
  assert.equal(eff(333_333n, 77, "A"), 371_667n);   // 371 666.5 rounded up
});

test("grade multipliers: Provisioned x1.25, NR x1.5, rounded up", () => {
  const c1 = choosePad([offer("p", 1, A, 320_000n, 0, "Provisioned")], { allowedPayees: allowed });
  const c2 = choosePad([offer("p", 1, A, 320_000n, 0, "NR")], { allowedPayees: allowed });
  const c3 = choosePad([offer("p", 1, A, 333_333n, 0, "Provisioned")], { allowedPayees: allowed });
  assert.ok(c1.ok && c2.ok && c3.ok);
  if (c1.ok && c2.ok && c3.ok) {
    assert.equal(c1.effectivePriceMicro, 400_000n);
    assert.equal(c2.effectivePriceMicro, 480_000n);
    assert.equal(c3.effectivePriceMicro, 416_667n); // 416 666.25 rounded up
  }
});

test("a cheaper but unproven pad can lose to a dearer graded one", () => {
  const c = choosePad([offer("cheap", 349, A, 300_000n, 0, "Provisioned"), offer("good", 350, B, 340_000n, 95, "AAA")], { allowedPayees: allowed });
  assert.ok(c.ok);
  if (c.ok) { assert.equal(c.pad.role, "good"); assert.match(c.reason, /340|0\.3/); assert.match(c.reason, /grade AAA/); assert.match(c.reason, /online/); }
});

test("tie goes to the lower machineId", () => {
  const c = choosePad([offer("hi", 351, A, 300_000n, 100, "AAA"), offer("lo", 350, B, 300_000n, 100, "AAA")], { allowedPayees: allowed });
  assert.ok(c.ok);
  if (c.ok) assert.equal(c.pad.role, "lo");
});

const offers = [offer("pad", 349, A, 300_000n, 100, "AAA"), offer("pad2", 350, B, 250_000n, 60, "BBB"), offer("pad3", 351, C, 200_000n, 90, "AA", false)];
const say = (o: unknown) => async () => JSON.stringify(o);

test("model happy path: picks an eligible role, amount recomputed in code, reason quotes the model", async () => {
  const c = await choosePadWithModel(say({ role: "pad2", reason: "Cheapest online." }), offers, { allowedPayees: allowed });
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.by, "claude");
    assert.equal(c.pad.role, "pad2");
    assert.equal(c.effectivePriceMicro, 300_000n); // 250000 x 1.2
    assert.match(c.reason, /^chose pad2 at 0\.250 USDC\/kWh/);
    assert.match(c.reason, /Claude: "Cheapest online\."$/);
  }
});

test("model picks an ineligible role (offline / unknown): rule decides, by simulated", async () => {
  for (const role of ["pad3", "ghost"]) {
    const c = await choosePadWithModel(say({ role, reason: "x" }), offers, { allowedPayees: allowed });
    assert.ok(c.ok);
    if (c.ok) { assert.equal(c.by, "simulated"); assert.equal(c.pad.role, "pad"); assert.match(c.reason, /^Simulated AI: /); }
  }
});

test("model garbage, duplicate keys, extra fields, non-string: rule decides", async () => {
  for (const raw of ["not json", "[]", '{"role":"pad","role":"pad2","reason":"x"}', '{"role":"pad2","reason":"x","amount":"9"}', '{"role":7,"reason":"x"}', '{"role":"pad2"}']) {
    const c = await choosePadWithModel(async () => raw, offers, { allowedPayees: allowed });
    assert.ok(c.ok && c.by === "simulated", raw);
  }
  const c = await choosePadWithModel((async () => 42) as never, offers, { allowedPayees: allowed });
  assert.ok(c.ok && c.by === "simulated");
});

test("model throws or rejects: rule decides, never throws", async () => {
  const c = await choosePadWithModel(async () => { throw new Error("boom"); }, offers, { allowedPayees: allowed });
  assert.ok(c.ok && c.by === "simulated" && c.pad.role === "pad");
});

test("nobody eligible: the model is not asked", async () => {
  let asked = false;
  const c = await choosePadWithModel(async () => { asked = true; return "{}"; }, offers, { allowedPayees: [] });
  assert.equal(c.ok, false);
  assert.equal(asked, false);
});

test("setup: several pads become the mandate's payee list; the single pad still works", () => {
  const base = { robot: ROBOT, cap: 2_000_000n, perCharge: 500_000n, expiresAt: 1_800_000_000 };
  assert.deepEqual(robotMandate({ ...base, pads: [A, B, C] }).payees, [A, B, C]);
  assert.deepEqual(robotMandate({ ...base, pad: A }).payees, [A]);
  const one = fleetRules({ ...base, pad: A });
  assert.equal((one.doc as Record<string, unknown>).pad, A);
  const many = fleetRules({ ...base, pads: [A, B] });
  assert.deepEqual((many.doc as Record<string, unknown>).pads, [A, B]);
  assert.notDeepEqual(one.hash, many.hash);
  assert.throws(() => robotMandate(base), /pad/);
});
