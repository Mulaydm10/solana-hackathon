// Listing registry (deal_escrow v3, PLAN §2.2): listings, attestation by an independent assessor,
// deals opened from a listing, and the DealLink delivery check for Data listings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import {
  ListingKind,
  dealAddress,
  fetchListing,
  fetchMaybeDealLink,
  fetchMaybeListing,
  findLinkPda,
  findListingPda,
  getAttestListingInstruction,
  getCloseListingInstruction,
  getCreateDealInstructionAsync,
  getCreateListingInstructionAsync,
  getSubmitDeliveryInstructionAsync,
  getUpdateListingInstruction,
  PROGRAM_ERRORS,
} from "../src/index.ts";
import { HOUR, USDC, hash, programErrorCode, setup } from "./harness.ts";

const code = (name: string) => 6000 + PROGRAM_ERRORS.indexOf(name);
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => programErrorCode(e));

async function market() {
  const t = await setup();
  const assessor = await generateKeyPairSigner();
  t.client.svm.airdrop(assessor.address, 1_000_000_000n as never);
  let nextListing = 1n;
  let nextDeal = 100n;
  const list = async (o: { kind?: ListingKind; price?: bigint; content?: Uint8Array; assessorAddr?: Address; seller?: typeof t.seller } = {}) => {
    const seller = o.seller ?? t.seller;
    const listingId = nextListing++;
    await t.send([
      await getCreateListingInstructionAsync({
        seller, mint: t.mint.address, listingId, kind: o.kind ?? ListingKind.Data, price: o.price ?? 5n * USDC,
        contentHash: o.content ?? hash(20), metaHash: hash(21), termsTemplateHash: hash(22),
        assessor: o.assessorAddr ?? assessor.address,
      }),
    ]);
    return (await findListingPda({ seller: seller.address, listingId }))[0];
  };
  const attest = async (listing: Address, content = hash(20), by = assessor) =>
    t.send([getAttestListingInstruction({ assessor: by, listing, contentHash: content, reportHash: hash(30) })]);
  const update = async (listing: Address, u: { price?: bigint; active?: boolean; contentHash?: Uint8Array; metaHash?: Uint8Array }, by = t.seller) =>
    t.send([
      getUpdateListingInstruction({
        seller: by, listing, price: u.price ?? null, active: u.active ?? null, contentHash: u.contentHash ?? null, metaHash: u.metaHash ?? null,
      }),
    ]);
  /** Buyer opens a deal from a listing (or passes only a link, to test the refusal). */
  const openFrom = async (listing: Address | undefined, o: { amount?: bigint; linkOnly?: boolean } = {}) => {
    const dealId = nextDeal++;
    const deal = await dealAddress(t.buyer.address, dealId);
    const [link] = await findLinkPda({ deal });
    await t.send([
      await getCreateDealInstructionAsync({
        buyer: t.buyer, seller: t.seller.address, mint: t.mint.address, buyerToken: await t.ata(t.buyer.address), dealId,
        amount: o.amount ?? 5n * USDC, deadline: t.now() + HOUR, reviewSecs: 600n, resolveSecs: 600n, toleranceBps: 500,
        stakeRequired: 0n, bondBps: 0, verifier: t.verifier.address, termsHash: hash(7),
        listing: o.linkOnly ? undefined : listing, link,
      }),
    ]);
    return deal;
  };
  return { t, assessor, list, attest, update, openFrom };
}

test("create_listing: independent assessor, non-zero content and price; starts unattested", async () => {
  const { t, list, assessor } = await market();
  assert.equal(await errOf(list({ assessorAddr: t.seller.address })), code("AssessorNotIndependent"));
  assert.equal(await errOf(list({ content: new Uint8Array(32) })), code("BadListing"));
  assert.equal(await errOf(list({ price: 0n })), code("ZeroAmount"));
  const l = await list({ kind: ListingKind.Service, price: 3n * USDC });
  const x = (await fetchListing(t.client.rpc, l)).data;
  assert.equal(x.seller, t.seller.address);
  assert.equal(x.assessor, assessor.address);
  assert.equal(x.kind, ListingKind.Service);
  assert.equal(x.price, 3n * USDC);
  assert.equal(x.assessedAt, 0n);
  assert.equal(x.active, true);
  assert.equal(x.sales, 0n);
});

test("attest_listing: only the assessor, only for the content it saw", async () => {
  const { t, list, attest } = await market();
  const l = await list();
  assert.equal(await errOf(attest(l, hash(20), t.seller as never)), code("NotAssessor"));
  assert.equal(await errOf(attest(l, hash(99))), code("ListingMismatch"));
  await attest(l);
  const x = (await fetchListing(t.client.rpc, l)).data;
  assert.deepEqual([...x.reportHash], [...hash(30)]);
  assert.ok(x.assessedAt > 0n);
});

test("update_listing: price and availability keep the attestation; changing what is sold clears it", async () => {
  const { t, list, attest, update } = await market();
  const l = await list();
  await attest(l);
  await update(l, { price: 6n * USDC, active: false });
  let x = (await fetchListing(t.client.rpc, l)).data;
  assert.equal(x.price, 6n * USDC);
  assert.equal(x.active, false);
  assert.ok(x.assessedAt > 0n);
  await update(l, { metaHash: hash(40) });
  x = (await fetchListing(t.client.rpc, l)).data;
  assert.equal(x.assessedAt, 0n);
  await attest(l);
  await update(l, { contentHash: hash(41) });
  x = (await fetchListing(t.client.rpc, l)).data;
  assert.equal(x.assessedAt, 0n);
  assert.deepEqual([...x.reportHash], [...new Uint8Array(32)]);
  assert.equal(await errOf(update(l, { price: 1n }, t.stranger)), code("Unauthorized"));
});

test("open from a listing: must be active, attested and match seller, mint and price", async () => {
  const { t, list, attest, update, openFrom } = await market();
  const l = await list();
  assert.equal(await errOf(openFrom(l)), code("ListingNotAttested"));
  await attest(l);
  assert.equal(await errOf(openFrom(l, { amount: 4n * USDC })), code("ListingMismatch"));
  await update(l, { active: false });
  assert.equal(await errOf(openFrom(l)), code("ListingInactive"));
  await update(l, { active: true });
  // Another seller's listing cannot be used for a deal with this seller.
  const other = await list({ seller: t.stranger });
  await attest(other);
  assert.equal(await errOf(openFrom(other)), code("ListingMismatch"));
  // A link without a listing is refused.
  assert.equal(await errOf(openFrom(l, { linkOnly: true })), code("ListingMismatch"));
  const deal = await openFrom(l);
  const link = await fetchMaybeDealLink(t.client.rpc, (await findLinkPda({ deal }))[0]);
  assert.ok(link.exists);
  assert.equal(link.data.listing, l);
  assert.deepEqual([...link.data.expectedDeliveryHash], [...hash(20)]);
});

test("Data listing: the delivery must be exactly the listed content; a completed sale is counted", async () => {
  const { t, list, attest, openFrom } = await market();
  const l = await list();
  await attest(l);
  const deal = await openFrom(l);
  await t.accept(deal);
  assert.equal(await errOf(t.deliver(deal, 5n * USDC, t.seller, hash(21))), code("NotListedContent"));
  await t.deliver(deal, 5n * USDC, t.seller, hash(20));
  await t.release(deal, t.buyer, hash(20));
  assert.equal((await fetchListing(t.client.rpc, l)).data.sales, 1n);
});

test("Service listing: any delivery hash; a refund is not a sale", async () => {
  const { t, list, attest, openFrom } = await market();
  const l = await list({ kind: ListingKind.Service });
  await attest(l);
  const a = await openFrom(l);
  await t.accept(a);
  await t.deliver(a, 5n * USDC, t.seller, hash(55));
  await t.release(a, t.buyer, hash(55));
  const b = await openFrom(l);
  t.warp(HOUR + 1n);
  await t.refund(b);
  assert.equal((await fetchListing(t.client.rpc, l)).data.sales, 1n);
});

test("closing a listing never strands open deals; the delivery check survives the close", async () => {
  const { t, list, attest, openFrom } = await market();
  const l = await list();
  await attest(l);
  const deal = await openFrom(l);
  await t.accept(deal);
  await t.send([getCloseListingInstruction({ seller: t.seller, listing: l })]);
  assert.equal((await fetchMaybeListing(t.client.rpc, l)).exists, false);
  assert.equal(await errOf(t.deliver(deal, 5n * USDC, t.seller, hash(21))), code("NotListedContent"));
  await t.deliver(deal, 5n * USDC, t.seller, hash(20));
  const before = await t.balance(t.seller.address);
  await t.release(deal, t.buyer, hash(20));
  assert.equal((await t.balance(t.seller.address)) - before, 5n * USDC);
});

test("the delivery check cannot be dodged by passing another account as the link", async () => {
  const { t, list, attest, openFrom } = await market();
  const l = await list();
  await attest(l);
  const deal = await openFrom(l);
  await t.accept(deal);
  const fake = (await generateKeyPairSigner()).address;
  const r = await errOf(
    t.send([await getSubmitDeliveryInstructionAsync({ seller: t.seller, deal, link: fake, deliveryHash: hash(21), invoiceAmount: 5n * USDC })]),
  );
  assert.equal(r, 2006); // Anchor ConstraintSeeds
});

test("plain deals (no listing) are unaffected", async () => {
  const { t } = await market();
  const deal = await t.open();
  await t.accept(deal);
  await t.deliver(deal, 5n * USDC, t.seller, hash(77));
  await t.release(deal, t.buyer, hash(77));
  assert.equal((await t.deal(deal)).status, 4); // Released
});
