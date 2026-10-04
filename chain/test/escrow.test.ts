// deal_escrow v2, every path, against the compiled program in LiteSVM. Each refusal asserts the
// exact program error, and each settlement asserts who ended up with which tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DealStatus, getClaimInstructionAsync, repPairAddress, sellerRepAddress } from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, NONE, USDC, hash, rejects, setup } from "./harness.ts";

test("happy path: open, accept with stake, deliver, release pays the invoice and returns the stake", async () => {
  const t = await setup();
  const [b0, s0] = [await t.balance(t.buyer.address), await t.balance(t.seller.address)];
  const deal = await t.open();
  assert.equal((await t.deal(deal)).status, DealStatus.Open);
  await t.accept(deal);
  assert.equal(await t.vaultBalance(deal), 6n * USDC); // order 5 + stake 1
  await t.deliver(deal);
  await t.release(deal);
  assert.equal((await t.deal(deal)).status, DealStatus.Released);
  assert.equal(await t.balance(t.buyer.address), b0 - 5n * USDC);
  assert.equal(await t.balance(t.seller.address), s0 + 5n * USDC);
  assert.equal(await t.vaultBalance(deal), 0n);
  await rejects(t.release(deal), "WrongStatus");
});

test("invoice match: under-invoice within tolerance pays the invoice and refunds the rest", async () => {
  const t = await setup();
  const b0 = await t.balance(t.buyer.address);
  const deal = await t.open({ amount: 10n * USDC, toleranceBps: 500 });
  await t.accept(deal);
  await t.deliver(deal, 9_600_000n); // 4% under
  await t.release(deal);
  assert.equal(await t.balance(t.buyer.address), b0 - 9_600_000n);
});

test("invoice match: over-invoice within tolerance is capped at the order amount", async () => {
  const t = await setup();
  const s0 = await t.balance(t.seller.address);
  const deal = await t.open({ amount: 10n * USDC, toleranceBps: 500 });
  await t.accept(deal);
  await t.deliver(deal, 10_400_000n);
  await t.release(deal);
  assert.equal(await t.balance(t.seller.address), s0 + 10n * USDC);
});

test("invoice outside tolerance, zero invoice and empty delivery are refused", async () => {
  const t = await setup();
  const deal = await t.open({ amount: 10n * USDC, toleranceBps: 500 });
  await t.accept(deal);
  await rejects(t.deliver(deal, 9_000_000n), "InvoiceMismatch");
  await rejects(t.deliver(deal, 0n), "InvoiceMismatch");
  await rejects(t.deliver(deal, 10n * USDC, t.seller, hash(0)), "EmptyDelivery");
});

test("release must name the delivered hash", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  await rejects(t.release(deal, t.buyer, hash(8)), "DeliveryMismatch");
});

test("policy: allowlist, max price, period budget (fail closed)", async () => {
  const t = await setup();
  await rejects(t.open({ seller: t.stranger.address }), "SellerNotAllowed");
  await rejects(t.open({ amount: 21n * USDC, approver: t.approver }), "OverMaxPrice");
  for (let i = 0; i < 5; i++) await t.open({ amount: 10n * USDC }); // 50 of 50
  await rejects(t.open({ amount: 1n * USDC }), "OverPeriodBudget");
  t.warp(86_400n);
  await t.open({ amount: 1n * USDC }); // new period
});

test("policy: above the approval threshold needs the approver's signature", async () => {
  const t = await setup();
  await rejects(t.open({ amount: 15n * USDC }), "ApprovalRequired");
  await rejects(t.open({ amount: 15n * USDC, approver: t.stranger }), "ApprovalRequired");
  await t.open({ amount: 15n * USDC, approver: t.approver });
});

test("policy: no approver configured means large amounts are refused", async () => {
  const t = await setup({ policy: (s) => DEFAULT_POLICY(s, NONE) });
  await rejects(t.open({ amount: 15n * USDC, approver: t.approver }), "ApprovalRequired");
});

test("policy: only the buyer can change it", async () => {
  const t = await setup();
  await rejects(t.updatePolicy({ ...DEFAULT_POLICY(t.stranger.address, t.stranger.address), allowAnySeller: true }, t.stranger));
});

test("cancel before accept refunds fully and credits the budget; not after accept", async () => {
  const t = await setup();
  const b0 = await t.balance(t.buyer.address);
  const deal = await t.open({ amount: 10n * USDC });
  await rejects(t.cancel(deal, t.stranger), "Unauthorized");
  await t.cancel(deal);
  assert.equal((await t.deal(deal)).status, DealStatus.Cancelled);
  assert.equal(await t.balance(t.buyer.address), b0);
  for (let i = 0; i < 5; i++) await t.open({ amount: 10n * USDC }); // the full 50 is available again
  await rejects(t.open({ amount: 1n * USDC }), "OverPeriodBudget");
  const accepted = await t.open({ amount: 0n }).catch(() => null);
  assert.equal(accepted, null);
  const t2 = await setup();
  const d2 = await t2.open();
  await t2.accept(d2);
  await rejects(t2.cancel(d2), "WrongStatus");
});

test("only the named seller can accept or deliver", async () => {
  const t = await setup();
  const deal = await t.open();
  await rejects(t.accept(deal, t.stranger), "Unauthorized");
  await t.accept(deal);
  await rejects(t.deliver(deal, 5n * USDC, t.stranger), "Unauthorized");
});

test("missed deadline after accept: anyone refunds, the stake is slashed to the buyer", async () => {
  const t = await setup();
  const [b0, s0] = [await t.balance(t.buyer.address), await t.balance(t.seller.address)];
  const deal = await t.open();
  await t.accept(deal);
  await rejects(t.refund(deal), "DeadlineNotReached");
  t.warp(HOUR + 1n);
  await rejects(t.deliver(deal), "DeadlinePassed");
  await t.refund(deal);
  assert.equal(await t.balance(t.buyer.address), b0 + 1n * USDC);
  assert.equal(await t.balance(t.seller.address), s0 - 1n * USDC);
});

test("never accepted: refund after the deadline returns the order only", async () => {
  const t = await setup();
  const b0 = await t.balance(t.buyer.address);
  const deal = await t.open();
  t.warp(HOUR + 1n);
  await rejects(t.accept(deal), "DeadlinePassed");
  await t.refund(deal);
  assert.equal(await t.balance(t.buyer.address), b0);
});

test("buyer silence: anyone triggers the claim after the review window, funds go to the seller", async () => {
  const t = await setup();
  const s0 = await t.balance(t.seller.address);
  const deal = await t.open({ reviewSecs: 600n });
  await t.accept(deal);
  await t.deliver(deal);
  await rejects(t.claim(deal), "ReviewWindowOpen");
  t.warp(600n);
  await t.claim(deal, t.stranger);
  assert.equal(await t.balance(t.seller.address), s0 + 5n * USDC);
});

test("challenge needs a verifier and must be inside the review window", async () => {
  const t = await setup();
  const noVerifier = await t.open({ verifier: NONE });
  await t.accept(noVerifier);
  await t.deliver(noVerifier);
  await rejects(t.challenge(noVerifier), "NoVerifier");
  const late = await t.open();
  await t.accept(late);
  await t.deliver(late);
  t.warp(600n);
  await rejects(t.challenge(late), "ReviewWindowClosed");
});

test("verifier must be independent of buyer and seller", async () => {
  const t = await setup();
  await rejects(t.open({ verifier: t.seller.address }), "VerifierNotIndependent");
  await rejects(t.open({ verifier: t.buyer.address }), "VerifierNotIndependent");
});

test("challenge upheld: buyer gets order + bond back and the seller's stake", async () => {
  const t = await setup();
  const [b0, s0] = [await t.balance(t.buyer.address), await t.balance(t.seller.address)];
  const deal = await t.open({ bondBps: 1000 });
  await t.accept(deal);
  await t.deliver(deal);
  await t.challenge(deal);
  assert.equal(await t.vaultBalance(deal), 6_500_000n); // 5 + stake 1 + bond 0.5
  await rejects(t.resolve(deal, false, t.stranger), "NotVerifier");
  await rejects(t.resolve(deal, false, t.seller), "NotVerifier");
  await t.resolve(deal, false);
  assert.equal((await t.deal(deal)).status, DealStatus.VerifiedFail);
  assert.equal(await t.balance(t.buyer.address), b0 + 1n * USDC);
  assert.equal(await t.balance(t.seller.address), s0 - 1n * USDC);
});

test("challenge rejected: seller gets the invoice, the stake and the buyer's bond", async () => {
  const t = await setup();
  const [b0, s0] = [await t.balance(t.buyer.address), await t.balance(t.seller.address)];
  const deal = await t.open({ bondBps: 1000 });
  await t.accept(deal);
  await t.deliver(deal);
  await t.challenge(deal);
  await t.resolve(deal, true);
  assert.equal((await t.deal(deal)).status, DealStatus.VerifiedPass);
  assert.equal(await t.balance(t.buyer.address), b0 - 5_500_000n);
  assert.equal(await t.balance(t.seller.address), s0 + 5_500_000n);
});

test("no verdict in time: anyone refunds order + bond, the seller keeps the stake; late verdict refused", async () => {
  const t = await setup();
  const [b0, s0] = [await t.balance(t.buyer.address), await t.balance(t.seller.address)];
  const deal = await t.open({ resolveSecs: 600n });
  await t.accept(deal);
  await t.deliver(deal);
  await t.challenge(deal);
  await rejects(t.timeoutRefund(deal), "ResolveWindowOpen");
  t.warp(601n);
  await rejects(t.resolve(deal, true), "ResolveWindowClosed");
  await t.timeoutRefund(deal);
  assert.equal((await t.deal(deal)).status, DealStatus.NoVerdict);
  assert.equal(await t.balance(t.buyer.address), b0);
  assert.equal(await t.balance(t.seller.address), s0);
});

test("a caller cannot redirect a payout to their own token account", async () => {
  const t = await setup();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal);
  t.warp(600n);
  await rejects(
    t.send([
      await getClaimInstructionAsync({
        actor: t.stranger, deal, policy: t.policy, mint: t.mint.address,
        buyerToken: await t.ata(t.buyer.address), sellerToken: await t.ata(t.stranger.address),
        sellerRep: await sellerRepAddress(t.seller.address, t.mint.address), repPair: await repPairAddress(t.seller.address, t.buyer.address, t.mint.address),
      }),
    ]),
  );
  assert.equal((await t.deal(deal)).status, DealStatus.Delivered);
});

test("bad terms are refused at open", async () => {
  const t = await setup();
  await rejects(t.open({ amount: 0n }), "ZeroAmount");
  await rejects(t.open({ deadline: t.now() }), "DeadlineInPast");
  await rejects(t.open({ deadline: t.now() + 31n * 86_400n }), "DeadlineTooFar");
  await rejects(t.open({ toleranceBps: 2_001 }), "BadTolerance");
  await rejects(t.open({ bondBps: 5_001 }), "BadBond");
  await rejects(t.open({ resolveSecs: 10n }), "BadResolveWindow");
});
