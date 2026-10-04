// Runs the compiled deal_escrow program in LiteSVM (in-process; no validator, no network, no Rust).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, generateKeyPairSigner, lamports, type Address, type TransactionSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS,
  DealStatus,
  PROGRAM_SO,
  dealAddress,
  fetchDeal,
  getClaimInstructionAsync,
  getCreateDealInstructionAsync,
  getRefundInstructionAsync,
  getReleaseInstructionAsync,
  getSubmitDeliveryInstruction,
} from "../src/index.ts";

const USDC = 1_000_000n; // 6 decimals
const PRICE = 2n * USDC;
const HOUR = 3600n;

async function setup() {
  const client = await createClient()
    .use(generatedSigner())
    .use(litesvm())
    .use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);

  const buyer = client.payer;
  const seller = await generateKeyPairSigner();
  const stranger = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  client.svm.airdrop(seller.address, lamports(1_000_000_000n));
  client.svm.airdrop(stranger.address, lamports(1_000_000_000n));

  await client.sendTransaction(
    await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }),
  );
  await client.sendTransaction(
    await getMintToATAInstructionPlanAsync({
      payer: buyer, owner: buyer.address, mint: mint.address, mintAuthority: buyer, amount: 100n * USDC, decimals: 6,
    }),
  );
  await client.sendTransaction([
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: seller.address, mint: mint.address }),
  ]);
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const balance = async (owner: Address) => (await fetchToken(client.rpc, await ata(owner))).data.amount;
  const now = () => client.svm.getClock().unixTimestamp;
  const warp = (secs: bigint) => {
    const clock = client.svm.getClock();
    clock.unixTimestamp = clock.unixTimestamp + secs;
    client.svm.setClock(clock);
    client.svm.expireBlockhash();
  };

  let nextId = 1n;
  async function lock(opts: { amount?: bigint; deadline?: bigint; reviewSecs?: bigint } = {}) {
    const dealId = nextId++;
    await client.sendTransaction([
      await getCreateDealInstructionAsync({
        buyer, seller: seller.address, mint: mint.address, buyerToken: await ata(buyer.address),
        dealId, amount: opts.amount ?? PRICE, deadline: opts.deadline ?? now() + HOUR,
        reviewSecs: opts.reviewSecs ?? 600n, termsHash: new Uint8Array(32).fill(7),
      }),
    ]);
    return dealAddress(buyer.address, dealId);
  }
  const deliver = async (deal: Address, by: TransactionSigner = seller) =>
    client.sendTransaction([getSubmitDeliveryInstruction({ seller: by, deal, deliveryHash: new Uint8Array(32).fill(9) })]);
  const release = async (deal: Address, by: TransactionSigner = buyer) =>
    client.sendTransaction([
      await getReleaseInstructionAsync({ buyer: by, deal, mint: mint.address, sellerToken: await ata(seller.address) }),
    ]);
  const refund = async (deal: Address) =>
    client.sendTransaction([
      await getRefundInstructionAsync({ deal, mint: mint.address, buyerToken: await ata(buyer.address) }),
    ]);
  const claim = async (deal: Address, by: TransactionSigner = seller) =>
    client.sendTransaction([
      await getClaimInstructionAsync({ seller: by, deal, mint: mint.address, sellerToken: await ata(seller.address) }),
    ]);
  const status = async (deal: Address) => (await fetchDeal(client.rpc, deal)).data.status;

  return { client, buyer, seller, stranger, balance, now, warp, lock, deliver, release, refund, claim, status };
}

/** Custom program error code carried anywhere in a Kit error's cause chain. */
function programErrorCode(e: unknown): number | undefined {
  for (let cur = e as { context?: { code?: unknown }; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (typeof cur.context?.code === "number") return cur.context.code;
  }
  return undefined;
}
const ERROR_CODES = {
  ZeroAmount: 6000, DeadlineInPast: 6001, BadReviewWindow: 6002, SelfDeal: 6003, WrongStatus: 6004,
  DeadlinePassed: 6005, DeadlineNotReached: 6006, ReviewWindowOpen: 6007, Unauthorized: 6008,
} as const;

/** Assert the transaction fails; with `name`, that it fails with exactly that program error. */
async function rejects(p: Promise<unknown>, name?: keyof typeof ERROR_CODES) {
  await assert.rejects(p, (e: unknown) => {
    if (name) assert.equal(programErrorCode(e), ERROR_CODES[name], `expected ${name}`);
    return true;
  });
}

test("lock moves the price into escrow and records the deal", async () => {
  const t = await setup();
  const deal = await t.lock();
  assert.equal(await t.balance(t.buyer.address), 98n * USDC);
  const d = (await fetchDeal(t.client.rpc, deal)).data;
  assert.equal(d.status, DealStatus.Funded);
  assert.equal(d.amount, PRICE);
  assert.equal(d.seller, t.seller.address);
  assert.deepEqual([...d.termsHash], new Array(32).fill(7));
});

test("deliver then release pays the seller", async () => {
  const t = await setup();
  const deal = await t.lock();
  await t.deliver(deal);
  assert.equal(await t.status(deal), DealStatus.Delivered);
  await t.release(deal);
  assert.equal(await t.status(deal), DealStatus.Released);
  assert.equal(await t.balance(t.seller.address), PRICE);
  t.client.svm.expireBlockhash();
  await rejects(t.release(deal), "WrongStatus");
});

test("refund is refused before the deadline and works after it", async () => {
  const t = await setup();
  const deal = await t.lock();
  await rejects(t.refund(deal), "DeadlineNotReached");
  t.warp(HOUR + 1n);
  await t.refund(deal);
  assert.equal(await t.status(deal), DealStatus.Refunded);
  assert.equal(await t.balance(t.buyer.address), 100n * USDC);
  assert.equal(await t.balance(t.seller.address), 0n);
});

test("late delivery is refused", async () => {
  const t = await setup();
  const deal = await t.lock();
  t.warp(HOUR + 1n);
  await rejects(t.deliver(deal), "DeadlinePassed");
});

test("delivered deal cannot be refunded", async () => {
  const t = await setup();
  const deal = await t.lock();
  await t.deliver(deal);
  t.warp(HOUR + 1n);
  await rejects(t.refund(deal), "WrongStatus");
});

test("seller claims only after the buyer's review window", async () => {
  const t = await setup();
  const deal = await t.lock({ reviewSecs: 600n });
  await t.deliver(deal);
  await rejects(t.claim(deal), "ReviewWindowOpen");
  t.warp(601n);
  await t.claim(deal);
  assert.equal(await t.status(deal), DealStatus.Claimed);
  assert.equal(await t.balance(t.seller.address), PRICE);
});

test("only the parties can act", async () => {
  const t = await setup();
  const deal = await t.lock();
  await rejects(t.deliver(deal, t.stranger), "Unauthorized");
  await t.deliver(deal);
  await rejects(t.release(deal, t.stranger), "Unauthorized");
  t.warp(601n);
  await rejects(t.claim(deal, t.stranger), "Unauthorized");
});

test("bad terms are refused at lock", async () => {
  const t = await setup();
  await rejects(t.lock({ amount: 0n }), "ZeroAmount");
  await rejects(t.lock({ deadline: t.now() }), "DeadlineInPast");
  await rejects(t.lock({ reviewSecs: -1n }), "BadReviewWindow");
});
