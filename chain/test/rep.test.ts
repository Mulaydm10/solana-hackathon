// Seller reputation (deal_escrow v3, PLAN §2.1): written only by settle(), one count per settled
// deal, volume = what was actually paid for the work. Scoring lives in core (repScore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCreateDealInstructionAsync, getInitPolicyInstructionAsync, dealAddress } from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, USDC, hash, setup } from "./harness.ts";

const zeroish = (r: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["rep"]>>) =>
  r === null || (r.completed === 0n && r.failed === 0n && r.neutral === 0n && r.volume === 0n);

test("opening a deal creates zeroed reputation accounts; nothing counts until settlement", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  const rep = await t.rep(t.seller.address);
  assert.ok(rep && zeroish(rep));
  assert.equal(rep!.seller, t.seller.address);
  const pair = await t.pair(t.seller.address);
  assert.equal(pair!.buyer, t.buyer.address);
  assert.equal(pair!.completed, 0n);
});

test("release counts as completed with volume = the invoice actually paid", async () => {
  const t = await setup();
  const deal = await t.open({ amount: 5n * USDC });
  await t.accept(deal);
  await t.deliver(deal, 4_800_000n); // within 5% tolerance, below the order
  await t.release(deal);
  const rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.completed, 1n);
  assert.equal(rep.volume, 4_800_000n); // not the order, not the stake
  assert.equal(rep.distinctBuyers, 1n);
  assert.equal(rep.maxPairVolume, 4_800_000n);
  assert.ok(rep.lastSettledAt > 0n);
  const pair = (await t.pair(t.seller.address))!;
  assert.equal(pair.completed, 1n);
  assert.equal(pair.volume, 4_800_000n);
});

test("an invoice above the order adds only the order to volume", async () => {
  const t = await setup();
  const deal = await t.open({ amount: 5n * USDC });
  await t.accept(deal);
  await t.deliver(deal, 5_200_000n);
  t.warp(601n);
  await t.claim(deal, t.stranger);
  assert.equal((await t.rep(t.seller.address))!.volume, 5n * USDC);
});

test("a passed challenge counts as completed; the buyer's bond is not volume", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  await t.challenge(deal);
  await t.resolve(deal, true);
  const rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.completed, 1n);
  assert.equal(rep.volume, 5n * USDC);
});

test("failed: a failed verdict, and a missed deadline after accepting", async () => {
  const t = await setup();
  const a = await t.open();
  await t.accept(a);
  await t.deliver(a);
  await t.challenge(a);
  await t.resolve(a, false);
  const b = await t.open();
  await t.accept(b);
  t.warp(HOUR + 1n);
  await t.refund(b);
  const rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.failed, 2n);
  assert.equal(rep.completed, 0n);
  assert.equal(rep.distinctBuyers, 0n); // a buyer only counts after a completed deal
  assert.equal((await t.pair(t.seller.address))!.failed, 2n);
});

test("neutral: cancelled, refunded without accept, no verdict", async () => {
  const t = await setup();
  const a = await t.open();
  await t.cancel(a);
  const b = await t.open();
  t.warp(HOUR + 1n);
  await t.refund(b);
  const c = await t.open({ deadline: t.now() + 2n * HOUR });
  await t.accept(c);
  await t.deliver(c);
  await t.challenge(c);
  t.warp(601n);
  await t.timeoutRefund(c);
  const rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.neutral, 3n);
  assert.equal(rep.failed, 0n);
  assert.equal(rep.completed, 0n);
});

test("repeat deals with one buyer do not add distinct buyers; a second buyer does", async () => {
  const t = await setup();
  for (let i = 0; i < 2; i++) {
    const d = await t.open({ amount: 2n * USDC });
    await t.accept(d);
    await t.deliver(d, 2n * USDC);
    await t.release(d);
  }
  let rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.completed, 2n);
  assert.equal(rep.distinctBuyers, 1n);
  assert.equal(rep.maxPairVolume, 4n * USDC);

  // The stranger becomes a second buyer with its own policy.
  const b2 = t.stranger;
  await t.send([await getInitPolicyInstructionAsync({ buyer: b2, mint: t.mint.address, params: DEFAULT_POLICY(t.seller.address, t.approver.address) })]);
  await t.send([
    await getCreateDealInstructionAsync({
      buyer: b2, seller: t.seller.address, mint: t.mint.address, buyerToken: await t.ata(b2.address), dealId: 1n,
      amount: 1n * USDC, deadline: t.now() + HOUR, reviewSecs: 600n, resolveSecs: 600n, toleranceBps: 500,
      stakeRequired: 0n, bondBps: 0, verifier: t.verifier.address, termsHash: hash(3),
    }),
  ]);
  const d2 = await dealAddress(b2.address, 1n);
  await t.accept(d2);
  await t.deliver(d2, 1n * USDC);
  await t.release(d2, b2);
  rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.completed, 3n);
  assert.equal(rep.distinctBuyers, 2n);
  assert.equal(rep.volume, 5n * USDC);
  assert.equal(rep.maxPairVolume, 4n * USDC); // the larger pair, for the concentration check
  assert.equal((await t.pair(t.seller.address, b2.address))!.volume, 1n * USDC);
});

test("a deal opened before v3 (no reputation accounts) still settles, and is counted", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  const { sellerRepAddress, repPairAddress } = await import("../src/index.ts");
  t.wipe(await sellerRepAddress(t.seller.address));
  t.wipe(await repPairAddress(t.seller.address, t.buyer.address));
  assert.equal(await t.rep(t.seller.address), null);
  await t.release(deal);
  const rep = (await t.rep(t.seller.address))!;
  assert.equal(rep.seller, t.seller.address);
  assert.equal(rep.completed, 1n);
  assert.equal((await t.pair(t.seller.address))!.buyer, t.buyer.address);
});

test("refused settlements leave reputation untouched", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  await assert.rejects(t.release(deal, t.stranger));
  await assert.rejects(t.claim(deal, t.stranger)); // review window still open
  assert.ok(zeroish(await t.rep(t.seller.address)));
});
