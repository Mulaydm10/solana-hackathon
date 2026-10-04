/**
 * Steps 4-6 of the seller chain (PLAN §4.1) and the sale step that follows.
 *   price   -> core `suggestPrice`, fed by the assessment (grade, size, coverage, freshness); the seller may
 *              choose any price, and both the suggestion and the choice go on the listing page
 *   draft   -> the deal-terms template for the listing, checked by core `validateTerms`, hashed for
 *              `Listing.terms_template_hash`
 *   publish -> seller's USDC account (x402 `exact` never creates it, #88), `create_listing` (seller signs),
 *              encrypted custody for Data, then `attest_listing` (assessor signs) with the report hash
 *   sell    -> on a funded deal: `submit_delivery` with the content hash FIRST, then the sealed key (#97), so a
 *              buyer can never hold the data while the deal still looks undelivered
 * Chain calls are injected (wired to @deal/chain `listings.*` and `deals.*` by the caller), as custody does.
 */
import {
  canonicalize, sha256Bytes, suggestPrice, validateListingMeta, validateTerms, metaHash,
  type Comparable, type Json, type ListingMeta, type PriceSuggestion, type RepScore,
} from "@deal/core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Ok, Refused } from "../broker/broker.ts";
import type { Custody } from "../custody/custody.ts";
import type { AssessmentReport } from "./assess.ts";

const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

// ---- price

export function price(report: AssessmentReport, o: { comparables: readonly Comparable[]; rep?: RepScore; seller?: string; decimals?: number; symbol?: string }): PriceSuggestion {
  const q = report.quality;
  return suggestPrice({
    kind: report.kind,
    assessment: { grade: report.grade, sizeBytes: report.sizeBytes, ...(q ? { coverageBps: 10_000 - q.nullBps } : {}) },
    comparables: o.comparables,
    rep: o.rep,
    ageDays: q?.ageDays,
    seller: o.seller,
    decimals: o.decimals,
    symbol: o.symbol,
  });
}

// ---- draft

export type TermsTemplate = {
  template: "pay_on_delivery";
  seller: string;
  /** The listing (or the seller's listing id before it exists). */
  serviceId: string;
  task: string;
  /** Token base units. */
  price: bigint;
  /** Seconds from the buyer's purchase to the delivery deadline. */
  deliveryWindowSecs: number;
  reviewSecs: number;
};

const DRAFT_BUYER = "draft-buyer"; // placeholder: a template has no buyer yet, and must not equal the seller

/** A template the escrow will accept, or the reason it would not. */
export function draftTerms(t: TermsTemplate, now: number): Ok<{ template: TermsTemplate; templateHash: Uint8Array }> | Refused {
  const r = validateTerms(
    { template: t.template, buyer: DRAFT_BUYER, seller: t.seller, serviceId: t.serviceId, task: t.task, price: t.price, deadline: now + t.deliveryWindowSecs, reviewSecs: t.reviewSecs },
    { now, budgetRemaining: t.price },
  );
  if (!r.ok) return refuse(r.reason, "these terms would be refused by the escrow");
  return { ok: true, template: t, templateHash: sha256Bytes(canonicalize(t as unknown as Json)) };
}

// ---- publish

export type ChainListingDeps = {
  /** Idempotent: creates the seller's token account for the listing's mint if missing. */
  ensureTokenAccount(owner: string): Promise<void>;
  /** create_listing, signed by the seller. */
  createListing(p: {
    listingId: bigint; kind: ListingMeta["kind"]; price: bigint;
    contentHash: Uint8Array; metaHash: Uint8Array; termsTemplateHash: Uint8Array; assessor: string;
  }): Promise<Ok<{ listing: string }> | Refused>;
  /** attest_listing, signed by the assessor. */
  attest(p: { listing: string; contentHash: Uint8Array; reportHash: Uint8Array }): Promise<Ok<object> | Refused>;
  /** Where the encrypted data goes (local disk for the demo, Vercel Blob when deployed; PLAN §13). */
  storeCiphertext?(listing: string, ciphertext: Uint8Array): Promise<void>;
};

export type PublishInput = {
  seller: string;
  listingId: bigint;
  meta: unknown;
  /** The price the seller chose (any; the suggestion is shown next to it). */
  price: bigint;
  report: AssessmentReport;
  reportHash: Uint8Array;
  template: TermsTemplate;
  assessor: string;
  /** Data listings: the bytes, encrypted into custody. */
  data?: Uint8Array;
  /** The seller saw the personal-data warning and confirmed. */
  confirmedPii?: boolean;
};

export type Published = Ok<{ listing: string; contentHash: Uint8Array; metaHash: Uint8Array; termsTemplateHash: Uint8Array; reportHash: Uint8Array }>;

export async function publish(p: PublishInput, deps: ChainListingDeps, custody?: Custody): Promise<Published | Refused> {
  if (p.report.needsConfirmation && !p.confirmedPii) return refuse("PII_NOT_CONFIRMED", "the assessment found personal data; the seller must confirm before publishing");
  const meta = validateListingMeta(p.meta);
  if (!meta.ok) return refuse(meta.reason, "the listing metadata is not valid");
  if (meta.value.kind !== p.report.kind) return refuse("KIND_MISMATCH", "the metadata and the assessment are for different kinds");
  if (p.price <= 0n) return refuse("ZERO_PRICE", "a listing needs a price");
  if (p.template.price !== p.price || p.template.seller !== p.seller) return refuse("TEMPLATE_MISMATCH", "the terms template must carry the listing's seller and price");
  const contentHash = hexToBytes(p.report.contentHash);
  if (p.report.kind === "Data") {
    if (!p.data || !custody || !deps.storeCiphertext) return refuse("NO_CUSTODY", "a data listing needs its bytes, custody and storage");
  }
  const termsTemplateHash = sha256Bytes(canonicalize(p.template as unknown as Json));
  const mh = metaHash(meta.value);

  await deps.ensureTokenAccount(p.seller);
  const created = await deps.createListing({ listingId: p.listingId, kind: meta.value.kind, price: p.price, contentHash, metaHash: mh, termsTemplateHash, assessor: p.assessor });
  if (!created.ok) return created;
  if (p.report.kind === "Data") {
    const stored = custody!.store(created.listing, p.data!);
    if (bytesToHex(stored.contentHash) !== p.report.contentHash) return refuse("CONTENT_CHANGED", "the data differs from what was assessed");
    await deps.storeCiphertext!(created.listing, stored.ciphertext);
  }
  const attested = await deps.attest({ listing: created.listing, contentHash, reportHash: p.reportHash });
  if (!attested.ok) return attested;
  return { ok: true, listing: created.listing, contentHash, metaHash: mh, termsTemplateHash, reportHash: p.reportHash };
}

// ---- sell (after a buyer funds a deal from a Data listing)

export type SellDeps = {
  /** submit_delivery, signed by the seller, with the delivery hash = the listing's content hash. */
  submitDelivery(deal: string, deliveryHash: Uint8Array, invoiceAmount: bigint): Promise<Ok<object> | Refused>;
};

/**
 * Delivery first, key second: once `submit_delivery` is on chain the buyer can no longer refund for
 * non-delivery, and only then does custody release the key (it re-reads the deal: Delivered, this buyer,
 * this listing).
 */
export async function sell(
  r: { listing: string; deal: string; buyer: string; contentHash: Uint8Array; price: bigint },
  custody: Custody,
  deps: SellDeps,
): Promise<Ok<{ sealedKey: Uint8Array }> | Refused> {
  const delivered = await deps.submitDelivery(r.deal, r.contentHash, r.price);
  if (!delivered.ok) return delivered;
  return custody.releaseKey({ listing: r.listing, deal: r.deal, buyer: r.buyer });
}
