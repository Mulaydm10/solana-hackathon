import { test } from "node:test";
import assert from "node:assert/strict";
import { matchScore, parseQuery, search } from "../lib/catalogue.ts";
import { FIXTURES, fixtureRegistry } from "../lib/registry.ts";

const names = (q: Parameters<typeof search>[1]) => search(FIXTURES, q).map((l) => l.meta.name);

test("registry: list returns active listings, get finds by address or null", async () => {
  const r = fixtureRegistry();
  assert.equal((await r.list()).length, FIXTURES.length);
  assert.equal((await r.get(FIXTURES[0]!.address))?.meta.name, FIXTURES[0]!.meta.name);
  assert.equal(await r.get("nope"), null);
  const inactive = fixtureRegistry([{ ...FIXTURES[0]!, active: false }]);
  assert.deepEqual(await inactive.list(), []);
});

test("filters: kind, category, max price, minimum grade, flagged sellers, assessed only", () => {
  assert.deepEqual(names({ kind: "Service" }), ["Invoice OCR"]);
  assert.deepEqual(names({ category: "travel" }), ["Trip planner"]);
  assert.ok(names({ maxPrice: 2_500_000n }).every((n) => n !== "EU day-ahead power prices 2025"));
  assert.ok(!names({ minGrade: "B" }).includes("Container shipping rates Asia-Europe")); // grade C
  assert.ok(!names({ minGrade: "D" }).includes("Berlin bike counts")); // unassessed never meets a grade filter
  assert.ok(!names({ attestedOnly: true }).includes("Berlin bike counts"));
  assert.ok(!names({ hideFlagged: true }).includes("B2B leads, DACH")); // one buyer > 50% of volume
});

test("grade and trust come from the assessor and SellerRep, never from the seller's text", () => {
  const leads = search(FIXTURES, {}).find((l) => l.meta.name === "B2B leads, DACH")!;
  assert.match(leads.meta.description, /Grade A/); // the seller claims A...
  assert.equal(leads.report?.grade, "B"); // ...the assessor says B
  assert.deepEqual(leads.score.flags, ["CONCENTRATED"]);
  assert.ok(!names({ minGrade: "A" }).includes("B2B leads, DACH"));
  // Words in a description that repeat a grade or praise don't buy ranking either.
  assert.equal(matchScore(leads, "grade"), 1);
});

test("ranking: match, then reputation score, then price, then freshness, then address; deterministic", () => {
  const r1 = search(FIXTURES, { q: "prices" }).map((l) => l.address);
  const r2 = search([...FIXTURES].reverse(), { q: "prices" }).map((l) => l.address);
  assert.deepEqual(r1, r2);
  assert.equal(search(FIXTURES, { q: "prices" })[0]!.meta.name, "EU day-ahead power prices 2025");
  const all = search(FIXTURES, {});
  // With no words, sellers with a score come before those without one.
  const firstUnscored = all.findIndex((l) => l.score.score === null);
  assert.ok(all.slice(firstUnscored).every((l) => l.score.score === null));
});

test("parseQuery ignores anything malformed and never throws", () => {
  assert.deepEqual(parseQuery({ kind: "Admin", minGrade: "A+", maxPrice: "1e9", category: "../etc", q: ["a", "b"] }), {
    q: undefined, kind: undefined, category: undefined, maxPrice: undefined, minGrade: undefined, hideFlagged: false, attestedOnly: false,
  });
  assert.equal(parseQuery({ maxPrice: "2500000" }).maxPrice, 2_500_000n);
  assert.equal(parseQuery({ q: "x".repeat(500) }).q?.length, 200);
});
