// #271 (peaq v2): parametric downtime insurance. Stub InsuranceChain and PeaqClient (no network): premium table and
// rounding, every lifecycle transition, idempotence, a failure at each step keeps the state, no claim on fresh beats,
// refund after the term, the outage event value = gap seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { privateKeyToAccount } from "viem/accounts";
import {
  insuranceStep, OUTAGE_AFTER_SECS, outageEventParams, outageRawData, PREMIUM_RATE_BPS, quotePremium, createPeaqClient, signHeartbeat,
  type Heartbeat, type InsuranceChain, type Policy,
} from "../../src/index.ts";
import type { PeaqClient } from "../../src/machines/peaq.ts";

const DEAL = "BQ2UX41FDmdg8UyGFQQLjqW8T8GovFTiN3S9AsCFvP3x" as Address;
const KEY = `0x${"11".repeat(32)}` as const;
const OTHER_KEY = `0x${"22".repeat(32)}` as const;
const PAD = privateKeyToAccount(KEY).address;
const refused = (reason: string) => ({ ok: false as const, reason, message: reason });
const USDC = 1_000_000n;
const T0 = 1_800_000_000;
const DAY = 86_400;

type Step = "openPolicy" | "accept" | "payPremium" | "fileClaim" | "challenge" | "claim" | "refund";
function stubChain(fail: Partial<Record<Step, string>> = {}) {
  const calls: string[] = [];
  const hashes: Uint8Array[] = [];
  const ok = (name: Step, extra: object = {}) => { calls.push(name); return fail[name] ? refused(fail[name]!) : { ok: true as const, signature: name, ...extra }; };
  const chain: InsuranceChain = {
    async openPolicy() { return ok("openPolicy", { deal: DEAL }) as never; },
    async accept() { return ok("accept"); },
    async payPremium() { return ok("payPremium"); },
    async fileClaim(_d, h) { hashes.push(h); return ok("fileClaim"); },
    async challenge() { return ok("challenge"); },
    async claim() { return ok("claim"); },
    async refund() { return ok("refund"); },
  };
  return { chain, calls, hashes };
}
function stubPeaq(failFirst = 0) {
  const events: { id: bigint; gapSecs: number; proofHash: string; policy: string }[] = [];
  let left = failFirst;
  const peaq: PeaqClient = {
    async submitRevenueEvent() { throw new Error("no"); },
    async submitActivityEvent() { throw new Error("no"); },
    async submitOutageEvent(id, o) { if (left-- > 0) return refused("PEAQ_SUBMIT_FAILED"); events.push({ id, ...o }); return { ok: true, txHash: "0xoutage" }; },
    async queryMcr() { return refused("MCR_NOT_SERVED"); },
  };
  return { peaq, events };
}
const policy = (over: Partial<Policy> = {}): Policy => ({
  id: "pol-1", pad: PAD, coverage: USDC, premium: 20_000n, grade: "AAA", termStart: T0, termEnd: T0 + DAY, status: "quoted", ...over,
});
const beat = (sentAt: number, key = KEY): Promise<Heartbeat> => signHeartbeat("349", sentAt, key);
const deps = (chain: InsuranceChain, peaq: PeaqClient) => ({ chain, peaq, padMachineId: 349n, padAddress: PAD });
const O = (nowSecs: number, lastBeat: Heartbeat | null) => ({ nowSecs, lastBeat, reviewSecs: 600 });

test("premium table: 1 USDC for 24 h per grade", () => {
  const want: Record<string, bigint> = { AAA: 20_000n, AA: 30_000n, A: 40_000n, BBB: 60_000n, BB: 90_000n, B: 120_000n, NR: 200_000n, Provisioned: 200_000n };
  for (const g of Object.keys(PREMIUM_RATE_BPS)) {
    const q = quotePremium(USDC, g as never, DAY);
    assert.ok(q.ok);
    assert.equal(q.premium, want[g]);
    assert.equal(q.rateBps, PREMIUM_RATE_BPS[g as never]);
  }
});

test("premium rounds UP to a whole cent, scales with the term, minimum 0.01 USDC", () => {
  // 1 USDC, AAA, 12 h = 0.01 exactly
  assert.equal((quotePremium(USDC, "AAA", DAY / 2) as { premium: bigint }).premium, 10_000n);
  // 1 USDC, AAA, 13 h = 0.010833 -> 0.02
  assert.equal((quotePremium(USDC, "AAA", 13 * 3600) as { premium: bigint }).premium, 20_000n);
  // 3 USDC, BBB, 24 h = 0.18 exactly; one base unit more coverage -> 0.19
  assert.equal((quotePremium(3n * USDC, "BBB", DAY) as { premium: bigint }).premium, 180_000n);
  assert.equal((quotePremium(3n * USDC + 1n, "BBB", DAY) as { premium: bigint }).premium, 190_000n);
  // tiny coverage / short term floors at 0.01
  assert.equal((quotePremium(1_000n, "AAA", 60) as { premium: bigint }).premium, 10_000n);
  // 48 h doubles
  assert.equal((quotePremium(USDC, "A", 2 * DAY) as { premium: bigint }).premium, 80_000n);
});

test("quotePremium refuses bad input instead of throwing", () => {
  assert.equal(quotePremium(0n, "AAA", DAY).ok, false);
  assert.equal(quotePremium(-1n, "AAA", DAY).ok, false);
  assert.equal(quotePremium(USDC, "AAA", 0).ok, false);
  assert.equal(quotePremium(USDC, "AAA", 1.5).ok, false);
  assert.equal(quotePremium(USDC, "ZZZ" as never, DAY).ok, false);
  assert.equal(quotePremium(USDC, "toString" as never, DAY).ok, false);
});

test("quoted -> active in one step: open, accept, premium, each once", async () => {
  const { chain, calls } = stubChain();
  const { peaq } = stubPeaq();
  const p = await insuranceStep(deps(chain, peaq), policy(), O(T0, null));
  assert.deepEqual(calls, ["openPolicy", "accept", "payPremium"]);
  assert.equal(p.status, "active");
  assert.equal(p.deal, DEAL);
  assert.deepEqual([p.openSig, p.acceptSig, p.premiumSig], ["openPolicy", "accept", "payPremium"]);
  assert.equal(p.reason, undefined);
});

test("a failure at each opening step keeps the state and the reason; a retry resumes without repeating", async () => {
  for (const step of ["openPolicy", "accept", "payPremium"] as const) {
    const bad = stubChain({ [step]: "X_FAILED" });
    const { peaq } = stubPeaq();
    const p1 = await insuranceStep(deps(bad.chain, peaq), policy(), O(T0, null));
    assert.equal(p1.status, "quoted", step);
    assert.match(p1.reason ?? "", /X_FAILED/);
    const good = stubChain();
    const p2 = await insuranceStep(deps(good.chain, peaq), p1, O(T0 + 1, null));
    assert.equal(p2.status, "active", step);
    assert.equal(p2.reason, undefined);
    // earlier steps were not repeated
    const order: Step[] = ["openPolicy", "accept", "payPremium"];
    assert.deepEqual(good.calls, order.slice(order.indexOf(step)), step);
  }
});

test("active with fresh beats does nothing, however often it is called", async () => {
  const { chain, calls } = stubChain();
  const { peaq, events } = stubPeaq();
  const active = policy({ status: "active", deal: DEAL });
  for (const now of [T0 + 100, T0 + 3_000, T0 + OUTAGE_AFTER_SECS]) {
    const p = await insuranceStep(deps(chain, peaq), active, O(now, await beat(now - OUTAGE_AFTER_SECS)));
    assert.deepEqual(p, active);
  }
  const none = await insuranceStep(deps(chain, peaq), active, O(T0 + 5_000, null)); // no beat at all: no proof, no claim
  assert.deepEqual(none, active);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test("outage: active -> claimed with the outage hash, a peaq event whose value is the gap in seconds", async () => {
  const { chain, calls, hashes } = stubChain();
  const { peaq, events } = stubPeaq();
  const last = T0 + 1_000;
  const now = last + OUTAGE_AFTER_SECS + 1;
  const p = await insuranceStep(deps(chain, peaq), policy({ status: "active", deal: DEAL }), O(now, await beat(last)));
  assert.equal(p.status, "claimed");
  assert.deepEqual(calls, ["fileClaim"]);
  assert.equal(hashes[0]!.length, 32);
  assert.equal(p.claimSig, "fileClaim");
  assert.equal(p.outage?.gapSecs, OUTAGE_AFTER_SECS + 1);
  assert.equal(p.outage?.detectedAt, now);
  assert.equal(p.outage?.peaqEventTx, "0xoutage");
  assert.equal(p.outage?.proofHash.length, 64);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.gapSecs, OUTAGE_AFTER_SECS + 1);
  assert.equal(events[0]!.id, 349n);
  assert.equal(events[0]!.policy, "pol-1");
  assert.equal(events[0]!.proofHash, p.outage?.proofHash);
});

test("a failed claim filing keeps the policy active; no peaq event is written", async () => {
  const { chain } = stubChain({ fileClaim: "DeadlinePassed" });
  const { peaq, events } = stubPeaq();
  const before = policy({ status: "active", deal: DEAL });
  const p = await insuranceStep(deps(chain, peaq), before, O(T0 + 10_000, await beat(T0)));
  assert.equal(p.status, "active");
  assert.match(p.reason ?? "", /DeadlinePassed/);
  assert.deepEqual({ ...p, reason: undefined }, { ...before, reason: undefined });
  assert.equal(events.length, 0);
});

test("a peaq failure after filing stays claimed and the event is retried once on the next step, claim is not repeated", async () => {
  const { chain, calls } = stubChain();
  const { peaq, events } = stubPeaq(1);
  const now = T0 + 10_000;
  const p1 = await insuranceStep(deps(chain, peaq), policy({ status: "active", deal: DEAL }), O(now, await beat(T0)));
  assert.equal(p1.status, "claimed");
  assert.equal(p1.outage?.peaqEventTx, undefined);
  assert.match(p1.reason ?? "", /PEAQ_SUBMIT_FAILED/);
  const p2 = await insuranceStep(deps(chain, peaq), p1, O(now + 10, await beat(T0)));
  assert.equal(p2.status, "claimed"); // window not passed
  assert.equal(p2.outage?.peaqEventTx, "0xoutage");
  assert.equal(p2.reason, undefined);
  const p3 = await insuranceStep(deps(chain, peaq), p2, O(now + 20, await beat(T0)));
  assert.deepEqual(p3, p2);
  assert.equal(events.length, 1);
  assert.deepEqual(calls, ["fileClaim"]);
});

test("claimed: nothing before the review window, then claim -> paid, and paid is terminal", async () => {
  const { chain, calls } = stubChain();
  const { peaq } = stubPeaq();
  const now = T0 + 10_000;
  const p1 = await insuranceStep(deps(chain, peaq), policy({ status: "active", deal: DEAL }), O(now, await beat(T0)));
  const early = await insuranceStep(deps(chain, peaq), p1, O(now + 599, await beat(T0)));
  assert.equal(early.status, "claimed");
  const paid = await insuranceStep(deps(chain, peaq), early, O(now + 600, await beat(T0)));
  assert.equal(paid.status, "paid");
  assert.equal(paid.payoutSig, "claim");
  const again = await insuranceStep(deps(chain, peaq), paid, O(now + 9_999, await beat(T0)));
  assert.deepEqual(again, paid);
  assert.deepEqual(calls, ["fileClaim", "claim"]);
});

test("a failed payout keeps claimed and the reason; a retry pays once", async () => {
  const { peaq } = stubPeaq();
  const now = T0 + 10_000;
  const claimedP = await insuranceStep(deps(stubChain().chain, peaq), policy({ status: "active", deal: DEAL }), O(now, await beat(T0)));
  const p1 = await insuranceStep(deps(stubChain({ claim: "ReviewWindowOpen" }).chain, peaq), claimedP, O(now + 700, await beat(T0)));
  assert.equal(p1.status, "claimed");
  assert.match(p1.reason ?? "", /ReviewWindowOpen/);
  const good = stubChain();
  const p2 = await insuranceStep(deps(good.chain, peaq), p1, O(now + 701, await beat(T0)));
  assert.equal(p2.status, "paid");
  assert.deepEqual(good.calls, ["claim"]);
});

test("no outage by the end of the term: refund -> expired, once", async () => {
  const { chain, calls } = stubChain();
  const { peaq, events } = stubPeaq();
  const active = policy({ status: "active", deal: DEAL });
  const end = T0 + DAY;
  const before = await insuranceStep(deps(chain, peaq), active, O(end - 1, await beat(end - 60)));
  assert.equal(before.status, "active");
  const p = await insuranceStep(deps(chain, peaq), active, O(end, await beat(end - 60)));
  assert.equal(p.status, "expired");
  assert.equal(p.refundSig, "refund");
  assert.deepEqual((await insuranceStep(deps(chain, peaq), p, O(end + 1, await beat(end - 60)))), p);
  assert.deepEqual(calls, ["refund"]);
  assert.equal(events.length, 0);
});

test("an outage first seen after the term is a refund, not a claim; a failed refund keeps the state", async () => {
  const { peaq, events } = stubPeaq();
  const active = policy({ status: "active", deal: DEAL });
  const late = T0 + DAY + 10_000;
  const bad = await insuranceStep(deps(stubChain({ refund: "TooEarly" }).chain, peaq), active, O(late, await beat(T0)));
  assert.equal(bad.status, "active");
  assert.match(bad.reason ?? "", /TooEarly/);
  const good = stubChain();
  const ok = await insuranceStep(deps(good.chain, peaq), active, O(late, await beat(T0)));
  assert.equal(ok.status, "expired");
  assert.deepEqual(good.calls, ["refund"]);
  assert.equal(events.length, 0);
});

test("never throws: a chain that throws becomes a reason", async () => {
  const chain = { ...stubChain().chain, async openPolicy() { throw new Error("boom"); } } as InsuranceChain;
  const p = await insuranceStep(deps(chain, stubPeaq().peaq), policy(), O(T0, null));
  assert.equal(p.status, "quoted");
  assert.match(p.reason ?? "", /boom/);
});

test("peaq: the outage event is activity (type 1), value = gap seconds, rawData = canonical outage JSON", async () => {
  const o = { gapSecs: 4_200, proofHash: "ab".repeat(32), policy: "pol-1" };
  const r = outageEventParams(349n, o, { sourceChainId: 0 }, T0);
  assert.ok(r.ok);
  assert.equal(r.params.eventType, 1);
  assert.equal(r.params.value, 4_200);
  assert.equal(r.params.currency, "");
  assert.equal(r.params.trustLevel, 0);
  assert.equal(new TextDecoder().decode(outageRawData(o)),
    `{"gapSecs":4200,"kind":"fiducia-outage-v1","policy":"pol-1","proofHash":"${"ab".repeat(32)}"}`);
  assert.equal(outageEventParams(349n, { ...o, gapSecs: 0 }, { sourceChainId: 0 }, T0).ok, false);
  assert.equal(outageEventParams(0n, o, { sourceChainId: 0 }, T0).ok, false);

  const seen: { value: number; eventType: number }[] = [];
  const client = createPeaqClient({ rpcUrl: "x", deployment: "agung", eventRegistry: "0x0", sourceChainId: 0 }, {
    program: "p", submit: async (params) => { seen.push({ value: params.value, eventType: params.eventType }); return { txHash: "0xok" }; },
  });
  assert.deepEqual(await client.submitOutageEvent(349n, o), { ok: true, txHash: "0xok" });
  assert.deepEqual(seen, [{ value: 4_200, eventType: 1 }]);
  const failing = createPeaqClient({ rpcUrl: "x", deployment: "agung", eventRegistry: "0x0", sourceChainId: 0 }, {
    program: "p", submit: async () => { throw new Error("secret detail"); },
  });
  const f = await failing.submitOutageEvent(349n, o);
  assert.equal(f.ok, false);
  assert.ok(!JSON.stringify(f).includes("secret"));
});

test("valid proof: checked once (insurerCheck valid, stored beat), no challenge, paid after the window", async () => {
  const g = stubChain();
  const { peaq } = stubPeaq();
  const now = T0 + 10_000;
  const b = await beat(T0);
  const p1 = await insuranceStep(deps(g.chain, peaq), policy({ status: "active", deal: DEAL }), O(now, b));
  assert.deepEqual(p1.outage?.lastBeat, b);
  assert.equal(p1.outage?.insurerCheck, undefined);
  const p2 = await insuranceStep(deps(g.chain, peaq), p1, O(now + 10, b));
  assert.equal(p2.status, "claimed");
  assert.equal(p2.outage?.insurerCheck, "valid");
  const p3 = await insuranceStep(deps(g.chain, peaq), p2, O(now + 20, b));
  assert.deepEqual(p3, p2); // idempotent inside the window
  const p4 = await insuranceStep(deps(g.chain, peaq), p3, O(now + 600, b));
  assert.equal(p4.status, "paid");
  assert.deepEqual(g.calls, ["fileClaim", "claim"]);
});

async function filed(g: ReturnType<typeof stubChain>, peaq: PeaqClient, last: Heartbeat, tamper?: (p: Policy) => Policy) {
  const p = await insuranceStep(deps(g.chain, peaq), policy({ status: "active", deal: DEAL }), O(T0 + 10_000, last));
  return tamper ? tamper(p) : p;
}

test("forged proofs are challenged and never paid: another key's beat, a tampered gap, a tampered beat time", async () => {
  const forgeries: [string, Heartbeat | null, ((p: Policy) => Policy) | undefined][] = [
    ["beat signed by another key", await beat(T0, OTHER_KEY), undefined],
    ["tampered gapSecs", null, (p) => ({ ...p, outage: { ...p.outage!, gapSecs: p.outage!.gapSecs + 5_000 } })],
    ["tampered beat time", null, (p) => ({ ...p, outage: { ...p.outage!, lastBeat: { ...p.outage!.lastBeat, sentAt: T0 - 9_000 } } })],
  ];
  for (const [name, forged, tamper] of forgeries) {
    const g = stubChain();
    const { peaq } = stubPeaq();
    const p1 = await filed(g, peaq, forged ?? (await beat(T0)), tamper);
    const p2 = await insuranceStep(deps(g.chain, peaq), p1, O(T0 + 10_010, forged ?? (await beat(T0))));
    assert.equal(p2.status, "challenged", name);
    assert.equal(p2.challengeSig, "challenge", name);
    assert.equal(p2.outage?.insurerCheck, "invalid", name);
    // later steps do nothing, nothing is paid, challenge is not repeated
    const p3 = await insuranceStep(deps(g.chain, peaq), p2, O(T0 + 99_000, null));
    assert.deepEqual(p3, p2, name);
    assert.deepEqual(g.calls, ["fileClaim", "challenge"], name);
  }
});

test("a failed challenge keeps claimed + invalid, retries the challenge, and never pays", async () => {
  const bad = stubChain({ challenge: "NotChallengeable" });
  const { peaq } = stubPeaq();
  const p1 = await filed(bad, peaq, await beat(T0, OTHER_KEY));
  const p2 = await insuranceStep(deps(bad.chain, peaq), p1, O(T0 + 11_000, null)); // window long passed
  assert.equal(p2.status, "claimed");
  assert.equal(p2.outage?.insurerCheck, "invalid");
  assert.match(p2.reason ?? "", /NotChallengeable/);
  const good = stubChain();
  const p3 = await insuranceStep(deps(good.chain, peaq), p2, O(T0 + 11_001, null));
  assert.equal(p3.status, "challenged");
  assert.deepEqual(good.calls, ["challenge"]);
  assert.ok(!bad.calls.includes("claim") && !good.calls.includes("claim"));
});
