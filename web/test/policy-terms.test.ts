// The budget policy the hire page creates is the one shown and edited (#144), and it can't be one the hire then fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import { DEFAULT_POLICY, policyParams } from "../app/hire/policy-terms.ts";

test("policy terms: the shown defaults, edits, seller restriction and checks against this hire", async () => {
  const [b, s, p] = await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address));
  const need = { budget: 10_000_000n, fee: 3_000_000n };
  const d = policyParams(DEFAULT_POLICY, b!, need, [s!]);
  assert.ok(d.ok);
  assert.deepEqual([d.params.periodBudget, d.params.maxPrice, d.params.allowAnySeller, d.params.allowedSellers], [100_000_000n, 50_000_000n, true, []]);

  const r = policyParams({ perDay: "20", maxPrice: "5", anySeller: false }, b!, need, [s!, p!, s!]);
  assert.ok(r.ok);
  assert.deepEqual([r.params.periodBudget, r.params.maxPrice, r.params.allowedSellers], [20_000_000n, 5_000_000n, [s, p]]);

  const no = (f: Partial<typeof DEFAULT_POLICY>) => { const x = policyParams({ ...DEFAULT_POLICY, ...f }, b!, need, [s!]); return !x.ok && x.message; };
  assert.match(String(no({ perDay: "x" })), /Enter/);
  assert.match(String(no({ perDay: "10", maxPrice: "20" })), /can't be more/);
  assert.match(String(no({ maxPrice: "2" })), /team fee \(3\.00 USDC\)/);
  assert.match(String(no({ perDay: "12", maxPrice: "5" })), /plus the team fee \(13\.00 USDC\)/);
  const many = policyParams({ ...DEFAULT_POLICY, anySeller: false }, b!, need, Array.from({ length: 9 }, (_, i) => `S${i}`));
  assert.ok(!many.ok && /at most 8/.test(many.message));
});
