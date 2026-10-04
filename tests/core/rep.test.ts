import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRep, repScore, type RepCounts } from "../../core/src/index.ts";

const base: RepCounts = { completed: 20, failed: 0, neutral: 3, volume: 20_000_000n, distinctBuyers: 5, maxPairVolume: 5_000_000n };
const score = (r: Partial<RepCounts>) => repScore({ ...base, ...r });

test("no score below 10 completed deals", () => {
  assert.deepEqual(score({ completed: 9 }), { score: null, reason: "TOO_FEW_DEALS", flags: [] });
});
test("no score below 3 distinct buyers", () => {
  assert.deepEqual(score({ distinctBuyers: 2 }), { score: null, reason: "TOO_FEW_BUYERS", flags: [] });
});
test("too few deals is reported before too few buyers", () => {
  assert.equal((score({ completed: 1, distinctBuyers: 1 }) as { reason: string }).reason, "TOO_FEW_DEALS");
});
test("exactly 10 deals and 3 buyers is scored", () => {
  const r = score({ completed: 10, distinctBuyers: 3 });
  assert.equal(typeof r.score, "number");
});
test("more evidence scores higher at the same success rate", () => {
  const few = score({ completed: 10, failed: 0 }).score!;
  const many = score({ completed: 200, failed: 0 }).score!;
  assert.ok(many > few, `${many} > ${few}`);
  assert.equal(few, 72);
  assert.equal(many, 98);
});
test("failures lower the score; neutral outcomes do not", () => {
  assert.ok(score({ failed: 5 }).score! < score({}).score!);
  assert.equal(score({ neutral: 500 }).score, score({ neutral: 0 }).score);
});
test("CONCENTRATED when one buyer is more than half the volume, even before a score exists", () => {
  assert.deepEqual(score({ maxPairVolume: 10_000_001n }).flags, ["CONCENTRATED"]);
  assert.deepEqual(score({ maxPairVolume: 10_000_000n }).flags, []);
  const early = score({ completed: 2, volume: 100n, maxPairVolume: 100n });
  assert.equal(early.score, null);
  assert.deepEqual(early.flags, ["CONCENTRATED"]);
});
test("HIGH_FAILURE above 20% failed", () => {
  assert.deepEqual(score({ completed: 20, failed: 6 }).flags, ["HIGH_FAILURE"]);
  assert.deepEqual(score({ completed: 20, failed: 5 }).flags, []);
});
test("accepts the chain view shape (numbers and decimal strings)", () => {
  const view = { completed: 12, failed: 1, neutral: 0, volume: "12000000", distinctBuyers: 4, maxPairVolume: "3000000", lastSettledAt: 1 };
  assert.equal(typeof repScore(view).score, "number");
});
test("zero volume never flags CONCENTRATED", () => assert.deepEqual(score({ volume: 0n, maxPairVolume: 0n }).flags, []));
test("score stays within 0-100 and is monotone in completed deals", () => {
  let prev = -1;
  for (let c = 10; c <= 400; c += 13) {
    const s = score({ completed: c, failed: 3 }).score!;
    assert.ok(s >= 0 && s <= 100);
    assert.ok(s >= prev, `completed=${c}`);
    prev = s;
  }
});
test("describeRep is plain words", () => {
  assert.equal(describeRep(score({ completed: 3 })), "no score yet (fewer than 10 completed deals)");
  assert.match(describeRep(score({ maxPairVolume: 20_000_000n })), /^score \d+\/100; warning: one buyer is over half of the volume$/);
});
