import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeterministicReader, decide, hasDuplicateKeys, LISTING_FIELDS, s, type ParsedListing } from "../src/index.ts";

test("hasDuplicateKeys: same level only, through nesting, arrays, escapes and colons in values", () => {
  assert.equal(hasDuplicateKeys('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateKeys('{"a":{"b":1,"b":2}}'), true);
  assert.equal(hasDuplicateKeys('[{"a":1},{"a":2}]'), false);
  assert.equal(hasDuplicateKeys('{"a":{"a":1},"b":[{"a":1,"x":"a"}]}'), false);
  assert.equal(hasDuplicateKeys('{"a":"a","b":"a"}'), false);
  assert.equal(hasDuplicateKeys('{"a":"x\\",\\"a\\":\\"y","b":1}'), false);
  assert.equal(hasDuplicateKeys('{"k":"v: \\"k\\"","k":2}'), true);
  assert.equal(hasDuplicateKeys('{"a\\u0062":1,"ab":2}'), true);
  assert.equal(hasDuplicateKeys('{"list":[1,2,{"x":1}],"list2":[],"x":3}'), false);
});

test("schemas: strict objects, optional fields, nested lists, amounts as decimal strings", () => {
  const S = s.object({ a: s.amount({ max: 100n }), tags: s.array(s.oneOf(["x", "y"] as const), { max: 2 }), note: s.optional(s.text({ max: 5 })) });
  assert.deepEqual(S.check({ a: "7", tags: ["x"] }, "$"), { ok: true, value: { a: 7n, tags: ["x"] } });
  assert.deepEqual(S.check({ a: "7", tags: [], note: "hi" }, "$"), { ok: true, value: { a: 7n, tags: [], note: "hi" } });
  const why = (v: unknown) => { const r = S.check(v, "$"); return r.ok ? "ok" : r.error.path; };
  assert.equal(why({ a: "101", tags: [] }), "$.a");
  assert.equal(why({ a: "7", tags: ["z"] }), "$.tags[0]");
  assert.equal(why({ a: "7", tags: ["x", "y", "x"] }), "$.tags");
  assert.equal(why({ a: "7" }), "$.tags");
  assert.equal(why({ a: "7", tags: [], extra: 1 }), "$.extra");
  assert.equal(why({ a: "7", tags: [], note: "too long" }), "$.note");
});

test("reader: the value has exactly the schema's fields and typed amounts", async () => {
  const r = await createDeterministicReader().read(
    JSON.stringify({ listing: "L1st1ngAddress11111111111111111111111111111", seller: "Se11erAddress1111111111111111111111111111111", kind: "Data", price: "900000", grade: "A", name: "n", description: "d" }),
    LISTING_FIELDS,
  );
  assert.ok(r.ok);
  assert.equal(r.value.price, 900_000n);
  assert.deepEqual(Object.keys(r.value).sort(), ["description", "grade", "kind", "listing", "name", "price", "seller"]);
  assert.deepEqual(r.signals, []);
});

test("planner: cheapest acceptable listing, deterministic, never over budget or cap", () => {
  const l = (listing: string, price: bigint, grade: ParsedListing["grade"], kind: ParsedListing["kind"] = "Data"): ParsedListing =>
    ({ listing, seller: "S", kind, price, grade, name: "n", description: "d" });
  const p = { budget: 3_000_000n, maxPrice: 5_000_000n, minGrade: "B" as const, kinds: ["Data" as const] };
  assert.deepEqual(decide([l("L3", 2_000_000n, "A"), l("L1", 1_000_000n, "B"), l("L2", 1_000_000n, "A")], p), { action: "buy", listing: "L2", seller: "S", price: 1_000_000n });
  assert.equal(decide([l("L1", 4_000_000n, "A")], p).action, "none"); // over the remaining budget
  assert.equal(decide([l("L1", 1n, "C")], p).action, "none"); // grade too low
  assert.equal(decide([l("L1", 1n, "A", "Team")], p).action, "none"); // kind not allowed
  assert.equal(decide([l("L1", 1n, "A")], { ...p, blockedSellers: ["S"] }).action, "none");
  assert.equal(decide([l("L1", 0n, "A")], p).action, "none");
});
