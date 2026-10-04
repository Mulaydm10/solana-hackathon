import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, describeTerms, formatAmount, termsHash, validateTerms, type DealTerms, type ValidateOpts } from "../../core/src/index.ts";

const NOW = 1_800_000_000;
const base: DealTerms = {
  template: "pay_on_delivery",
  buyer: "BuyerPubkey111",
  seller: "SellerPubkey222",
  serviceId: "translate-de-en",
  task: "Translate a 2-page contract from German to English",
  price: 2_000_000n,
  deadline: NOW + 3600,
  reviewSecs: 600,
};
const opts: ValidateOpts = { now: NOW, budgetRemaining: 20_000_000n };
const reason = (t: Partial<DealTerms>, o = opts) => {
  const r = validateTerms({ ...base, ...t }, o);
  return r.ok ? "ok" : r.reason;
};

test("valid terms pass", () => assert.equal(reason({}), "ok"));
test("price equal to budget passes", () => assert.equal(reason({ price: 20_000_000n }), "ok"));
test("unknown template", () => assert.equal(reason({ template: "subscription" as never }), "UNKNOWN_TEMPLATE"));
test("zero price", () => assert.equal(reason({ price: 0n }), "ZERO_PRICE"));
test("over budget", () => assert.equal(reason({ price: 20_000_001n }), "OVER_BUDGET"));
test("self deal", () => assert.equal(reason({ seller: base.buyer }), "SELF_DEAL"));
test("deadline now is in the past", () => assert.equal(reason({ deadline: NOW }), "DEADLINE_IN_PAST"));
test("deadline too far", () => assert.equal(reason({ deadline: NOW + 31 * 86_400 }), "DEADLINE_TOO_FAR"));
test("custom max deadline", () =>
  assert.equal(reason({ deadline: NOW + 120 }, { ...opts, maxDeadlineSecs: 60 }), "DEADLINE_TOO_FAR"));
test("negative review window", () => assert.equal(reason({ reviewSecs: -1 }), "BAD_REVIEW_WINDOW"));
test("fractional review window", () => assert.equal(reason({ reviewSecs: 1.5 }), "BAD_REVIEW_WINDOW"));

test("hash is stable across key order and 32 bytes", () => {
  const shuffled = Object.fromEntries(Object.entries(base).reverse()) as DealTerms;
  assert.deepEqual(termsHash(shuffled), termsHash(base));
  assert.equal(termsHash(base).length, 32);
  assert.equal(canonicalJson(base).includes('"price":"2000000"'), true);
});
test("hash changes when a term changes", () =>
  assert.notDeepEqual(termsHash(base), termsHash({ ...base, price: 2_000_001n })));

test("formatAmount", () => {
  assert.equal(formatAmount(2_000_000n, 6), "2");
  assert.equal(formatAmount(2_500_000n, 6), "2.5");
  assert.equal(formatAmount(10_000n, 6), "0.01");
});
test("describeTerms names price, refund and review window", () => {
  const s = describeTerms(base, { decimals: 6, symbol: "USDC" });
  assert.match(s, /You pay 2 USDC into escrow/);
  assert.match(s, /refunded/);
  assert.match(s, /10 minutes/);
});

test("hash is pinned to a known vector (implementation-independent)", () => {
  const hex = Buffer.from(termsHash({ ...base, deadline: 1_800_003_600 })).toString("hex");
  assert.equal(hex, "c617535da90d283077d05b5cbd7d06636e47abc7c553193fe5083a7f2177e8ad");
});

test("core/src has no Node built-in imports (browser-safe)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../core/src/", import.meta.url);
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /from "node:/, f);
});
