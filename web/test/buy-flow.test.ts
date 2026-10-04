// Buy-flow transaction builders (#111): pure, no RPC or wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNoopSigner, type Address } from "@solana/kit";
import { getCreateDealInstructionDataDecoder, getInitPolicyInstructionDataDecoder, getSubmitDeliveryInstructionDataDecoder, findLinkPda } from "@deal/chain";
import { base58Encode, canonicalJson, sha256Hex } from "@deal/core";
import { randomBytes } from "node:crypto";

const addr = () => base58Encode(randomBytes(32)) as Address;
import { acceptIx, buyIx, deliverIx, policyIx, purchaseTerms, type ListingForSale } from "../lib/buy-flow.ts";

const BUYER = createNoopSigner(addr());
const SELLER = createNoopSigner(addr());
const MINT = "91TuVptwV9MjAowMtrLQB3Qs5VmMWA5uzxng1NcJH6iX"; // the local demo mint: nothing assumes Circle USDC
const VERIFIER = addr();
const HASH = "ab".repeat(32);
const listing: ListingForSale = { address: addr(), seller: SELLER.address, kind: "Data", mint: MINT, price: 6_000_000n, contentHash: HASH, name: "EU power prices" };
const why = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("budget: refuses nonsense; any seller or an allowlist; no co-signer is ever needed", async () => {
  assert.equal(why(await policyIx(BUYER, MINT as Address, { periodBudget: 0n, maxPrice: 1n, allowedSellers: null })), "BAD_BUDGET");
  assert.equal(why(await policyIx(BUYER, MINT as Address, { periodBudget: 5n, maxPrice: 6n, allowedSellers: null })), "BAD_BUDGET");
  assert.equal(why(await policyIx(BUYER, MINT as Address, { periodBudget: 5n, maxPrice: 5n, allowedSellers: [] })), "BAD_ALLOWLIST");
  const r = await policyIx(BUYER, MINT as Address, { periodBudget: 50_000_000n, maxPrice: 10_000_000n, allowedSellers: [SELLER.address] });
  assert.ok(r.ok);
  const p = getInitPolicyInstructionDataDecoder().decode(r.ix.data!).params;
  assert.equal(p.allowAnySeller, false);
  assert.deepEqual(p.allowedSellers, [SELLER.address]);
  assert.equal(p.approvalThreshold, 50_000_000n);
  assert.equal(p.approver, BUYER.address);
});

test("buy: binds the listing, its content hash and the terms; refuses another token and team listings", async () => {
  assert.equal(why(await buyIx(BUYER, { ...listing, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, { mint: MINT, verifier: VERIFIER, now: 1_800_000_000 })), "MINT_MISMATCH");
  assert.equal(why(await buyIx(BUYER, { ...listing, kind: "Team" }, { mint: MINT, verifier: VERIFIER, now: 1_800_000_000 })), "TEAM_LISTING");
  const r = await buyIx(BUYER, listing, { mint: MINT, verifier: VERIFIER, now: 1_800_000_000, dealId: 7n });
  assert.ok(r.ok);
  const d = getCreateDealInstructionDataDecoder().decode(r.ix.data!);
  assert.equal(d.amount, 6_000_000n);
  assert.equal(hex(d.listingContentHash), HASH);
  assert.equal(d.verifier, VERIFIER);
  // The terms posted to the site hash to exactly the deal's on-chain terms hash.
  assert.equal(hex(d.termsHash), sha256Hex(r.terms));
  assert.equal(r.terms, canonicalJson(purchaseTerms(BUYER.address, listing, 1_800_000_000 + 24 * 3_600)));
  const accounts = r.ix.accounts!.map((a) => a.address);
  assert.ok(accounts.includes(listing.address as Address));
  assert.ok(accounts.includes((await findLinkPda({ deal: r.deal }))[0]));
});

test("seller: accept only an Open deal; a Data delivery is always the listing's content hash", async () => {
  const deal = { deal: addr(), mint: MINT, status: "Funded", amount: "6000000", expectedDeliveryHash: HASH };
  assert.equal(why(await acceptIx(SELLER, deal)), "NOT_OPEN");
  assert.ok((await acceptIx(SELLER, { ...deal, status: "Open" })).ok);
  assert.equal(why(await deliverIx(SELLER, { ...deal, status: "Open" })), "NOT_FUNDED");
  const r = await deliverIx(SELLER, deal, "cd".repeat(32)); // a different hash typed in is ignored for Data
  assert.ok(r.ok);
  assert.equal(hex(getSubmitDeliveryInstructionDataDecoder().decode(r.ix.data!).deliveryHash), HASH);
  // A Service delivery names its own hash, and must name one.
  assert.equal(why(await deliverIx(SELLER, { ...deal, expectedDeliveryHash: "" })), "NO_DELIVERY_HASH");
  assert.ok((await deliverIx(SELLER, { ...deal, expectedDeliveryHash: "" }, "cd".repeat(32))).ok);
});
