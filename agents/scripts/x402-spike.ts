// npm run spike:x402 --prefix agents   (devnet; see scripts/spike.ts)
import { keys, PRICE, runSpike } from "./spike.ts";

const r = await runSpike();
if (!r.ready) {
  const { buyer, seller } = await keys();
  console.log(`not ready: ${r.why}`);
  console.log(`buyer  ${buyer.address}  <- devnet USDC from https://faucet.circle.com (Solana Devnet), and ~0.01 devnet SOL`);
  console.log(`seller ${seller.address}  <- also any devnet USDC from the faucet: that opens its USDC account, so no SOL is needed`);
  process.exit(2);
}
const show = (c: typeof r.answered) => JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
console.log(`price ${PRICE} base units`);
console.log(`answered:   ${show(r.answered)}`);
console.log(`unanswered: ${show(r.unanswered)}`);
const pass = r.answered.charged && r.answered.sellerDelta === PRICE && r.answered.buyerDelta === -PRICE
  && !r.unanswered.charged && r.unanswered.sellerDelta === 0n && r.unanswered.buyerDelta === 0n;
console.log(pass ? "PASS: paid call settled exactly the price; unanswered call was never settled" : "FAIL: see above");
process.exit(pass ? 0 : 1);
