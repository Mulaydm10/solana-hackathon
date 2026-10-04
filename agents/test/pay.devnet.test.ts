// Network test, opt-in like chain's DEAL_CHECK_DEVNET: AGENTS_NET=1 npm test --prefix agents
// Needs agents/.keys/buyer.json funded with devnet USDC (run `npm run spike:x402 --prefix agents` once for the address).
import { test } from "node:test";
import assert from "node:assert/strict";

const ON = process.env.AGENTS_NET === "1";

test("devnet x402: a paid call settles exactly the price; an unanswered call is never settled", { skip: !ON && "set AGENTS_NET=1", timeout: 240_000 }, async () => {
  const { PRICE, runSpike } = await import("../scripts/spike.ts");
  const r = await runSpike();
  assert.ok(r.ready, r.ready ? "" : r.why);
  assert.equal(r.answered.charged, true);
  assert.ok(r.answered.transaction);
  assert.equal(r.answered.sellerDelta, PRICE);
  assert.equal(r.answered.buyerDelta, -PRICE);
  assert.equal(r.unanswered.charged, false);
  assert.equal(r.unanswered.sellerDelta, 0n);
  assert.equal(r.unanswered.buyerDelta, 0n);
});
