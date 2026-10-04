import { test } from "node:test";
import assert from "node:assert/strict";
import { freshnessBps, suggestPrice, type Comparable, type Grade, type PriceInput } from "../../core/src/index.ts";

const USDC = 1_000_000n;
const sale = (p: bigint, sizeBytes?: number): Comparable => ({ kind: "Data", price: p, sold: true, sizeBytes });
const ask = (p: bigint): Comparable => ({ kind: "Data", price: p, sold: false });

test("median of sales when there are at least 3, ignoring asking prices", () => {
  const r = suggestPrice({ kind: "Data", comparables: [sale(4n * USDC), sale(6n * USDC), sale(5n * USDC), ask(100n * USDC)] });
  assert.equal(r.mid, 5n * USDC);
  assert.match(r.reasons[0]!, /Median of 3 recent sales/);
});
test("listings and sales together when sales are few; even count takes the mean of the middle two", () => {
  const r = suggestPrice({ kind: "Data", comparables: [sale(4n * USDC), ask(6n * USDC)] });
  assert.equal(r.mid, 5n * USDC);
});
test("a seller's own listings and sales never move its own price", () => {
  const others = [sale(5n * USDC), sale(5n * USDC), sale(5n * USDC)].map((c) => ({ ...c, seller: "Other" }));
  const mine = [sale(500n * USDC), sale(500n * USDC), sale(500n * USDC), ask(900n * USDC), ask(900n * USDC)].map((c) => ({ ...c, seller: "Me" }));
  const r = suggestPrice({ kind: "Data", seller: "Me", comparables: [...others, ...mine] });
  assert.equal(r.mid, 5n * USDC);
  assert.equal(r.reasons[0], "Left out 5 of your own listings and sales.");
  // Without a seller, all six sales count and the median jumps to (5 + 500) / 2: the exclusion is what protects the price.
  assert.equal(suggestPrice({ kind: "Data", comparables: [...others, ...mine] }).mid, 252_500_000n);
  // Only own evidence: falls back to the anchor rather than the seller's own prices.
  assert.equal(suggestPrice({ kind: "Data", seller: "Me", comparables: mine }).mid, 5n * USDC);
});
test("comparables of another kind are ignored; no evidence falls back to the anchor with a wide range", () => {
  const r = suggestPrice({ kind: "Service", comparables: [sale(9n * USDC)] });
  assert.equal(r.mid, 10_000n);
  assert.equal(r.low, 6_000n);
  assert.equal(r.high, 14_000n);
  assert.equal(suggestPrice({ kind: "Team", comparables: [], anchor: 7n * USDC }).mid, 7n * USDC);
});
test("grade, freshness, reputation each move the price with a stated reason", () => {
  const r = suggestPrice({
    kind: "Data", comparables: [sale(10n * USDC), sale(10n * USDC), sale(10n * USDC)],
    assessment: { grade: "A" }, ageDays: 120, rep: { score: 95, flags: [] },
  });
  // 10 * 1.2 (A) * 0.9 (120 days: 90 past the free 30) * 1.1 (score 95)
  assert.equal(r.mid, 11_880_000n);
  assert.deepEqual(r.reasons.slice(1, 4), [
    "Assessed grade A: +20%.",
    "Newest data is 120 days old: -10%.",
    "Seller score 95/100: +10%.",
  ]);
});
test("no reputation premium while flagged; low score is discounted; no score means no change", () => {
  const base: PriceInput = { kind: "Data", comparables: [sale(10n * USDC)] };
  assert.equal(suggestPrice({ ...base, rep: { score: 95, flags: ["CONCENTRATED"] } }).mid, 10n * USDC);
  assert.equal(suggestPrice({ ...base, rep: { score: 40, flags: [] } }).mid, 9n * USDC);
  assert.equal(suggestPrice({ ...base, rep: { score: null, reason: "TOO_FEW_DEALS", flags: [] } }).mid, 10n * USDC);
});
test("size relative to comparables is clamped to 0.5x-2x; coverage never below 50%", () => {
  const comps = [sale(10n * USDC, 1_000), sale(10n * USDC, 1_000), sale(10n * USDC, 1_000)];
  assert.equal(suggestPrice({ kind: "Data", comparables: comps, assessment: { grade: "B", sizeBytes: 1_000_000 } }).mid, 20n * USDC);
  assert.equal(suggestPrice({ kind: "Data", comparables: comps, assessment: { grade: "B", sizeBytes: 10 } }).mid, 5n * USDC);
  assert.equal(suggestPrice({ kind: "Data", comparables: comps, assessment: { grade: "B", coverageBps: 1_000 } }).mid, 5n * USDC);
  assert.equal(suggestPrice({ kind: "Data", comparables: comps, assessment: { grade: "B", coverageBps: 8_000 } }).mid, 8n * USDC);
});
test("freshness: full value for 30 days, then down, never below 40%; services do not age", () => {
  assert.equal(freshnessBps(0), 10_000n);
  assert.equal(freshnessBps(30), 10_000n);
  assert.equal(freshnessBps(120), 9_000n);
  assert.equal(freshnessBps(10_000), 4_000n);
  assert.equal(freshnessBps(Number.NaN), 10_000n);
  assert.equal(suggestPrice({ kind: "Service", comparables: [], ageDays: 5_000 }).mid, 10_000n);
});

// ---- property tests (seeded, so a failure is reproducible) ----
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GRADES: Grade[] = ["A", "B", "C", "D"];
function randomInput(rnd: () => number): PriceInput {
  const n = Math.floor(rnd() * 8);
  const comparables: Comparable[] = Array.from({ length: n }, () => ({
    kind: rnd() < 0.8 ? "Data" : "Service",
    price: BigInt(1 + Math.floor(rnd() * 50_000_000)),
    sold: rnd() < 0.5,
    sizeBytes: rnd() < 0.5 ? 1 + Math.floor(rnd() * 1e7) : undefined,
  }));
  const score = rnd() < 0.3 ? null : Math.floor(rnd() * 101);
  return {
    kind: "Data",
    comparables,
    assessment: rnd() < 0.8 ? { grade: GRADES[Math.floor(rnd() * 4)]!, sizeBytes: rnd() < 0.5 ? 1 + Math.floor(rnd() * 1e7) : undefined, coverageBps: rnd() < 0.5 ? Math.floor(rnd() * 10_001) : undefined } : undefined,
    ageDays: rnd() < 0.7 ? Math.floor(rnd() * 2_000) : undefined,
    rep: rnd() < 0.7 ? (score === null ? { score: null, reason: "TOO_FEW_DEALS", flags: [] } : { score, flags: rnd() < 0.2 ? ["CONCENTRATED"] : [] }) : undefined,
  };
}

test("property: 1 <= low <= mid <= high, deterministic, and independent of comparable order (2000 cases)", () => {
  const rnd = prng(63);
  for (let i = 0; i < 2_000; i++) {
    const input = randomInput(rnd);
    const r = suggestPrice(input);
    assert.ok(1n <= r.low && r.low <= r.mid && r.mid <= r.high, `case ${i}: ${r.low} ${r.mid} ${r.high}`);
    assert.deepEqual(suggestPrice(input), r, `case ${i} not deterministic`);
    assert.deepEqual(suggestPrice({ ...input, comparables: [...input.comparables].reverse() }), r, `case ${i} order-dependent`);
    assert.ok(r.reasons.length >= 2);
  }
});
test("property: a better grade never lowers the price; older data never raises it (2000 cases)", () => {
  const rnd = prng(64);
  for (let i = 0; i < 2_000; i++) {
    const input = randomInput(rnd);
    const a = input.assessment ?? { grade: "B" as Grade };
    const mids = GRADES.map((g) => suggestPrice({ ...input, assessment: { ...a, grade: g } }).mid);
    for (let k = 1; k < 4; k++) assert.ok(mids[k - 1]! >= mids[k]!, `case ${i}: grade order ${mids}`);
    const age = Math.floor(rnd() * 1_000);
    const younger = suggestPrice({ ...input, ageDays: age }).mid;
    const older = suggestPrice({ ...input, ageDays: age + 1 + Math.floor(rnd() * 500) }).mid;
    assert.ok(older <= younger, `case ${i}: ${older} > ${younger}`);
  }
});
