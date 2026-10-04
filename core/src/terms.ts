/**
 * `core/` is pure: no network, no chain SDK, no clock, no `process.env`, no Node built-ins, so it
 * runs unchanged in the browser (web lane) and in a bundled npm package (mcp lane).
 * Time enters as a `now` argument (unix seconds). See `contracts/core.md`.
 */
import { sha256 } from "@noble/hashes/sha2.js";

export type TemplateId = "pay_on_delivery";
export const TEMPLATES: readonly TemplateId[] = ["pay_on_delivery"];

/** Filled-in deal template. The AI produces this; the buyer approves it; the program enforces it. */
export type DealTerms = {
  template: TemplateId;
  /** Opaque principal ids (base58 pubkeys in practice). */
  buyer: string;
  seller: string;
  serviceId: string;
  /** What the seller must deliver, in plain words. */
  task: string;
  /** Token base units (USDC: 6 decimals). */
  price: bigint;
  /** Unix seconds. No delivery by then -> refund. */
  deadline: number;
  /** Seconds the buyer has to review a delivery; silence after that = acceptance. */
  reviewSecs: number;
};

export type TermsRefusal =
  | "UNKNOWN_TEMPLATE"
  | "ZERO_PRICE"
  | "OVER_BUDGET"
  | "DEADLINE_IN_PAST"
  | "DEADLINE_TOO_FAR"
  | "SELF_DEAL"
  | "BAD_REVIEW_WINDOW";

export type Result<T, E> = { ok: true; value: T } | { ok: false; reason: E };

export type ValidateOpts = {
  now: number;
  budgetRemaining: bigint;
  /** Longest allowed deal, seconds from `now`. Default 30 days. */
  maxDeadlineSecs?: number;
};

const DAY = 86_400;

export function validateTerms(terms: DealTerms, opts: ValidateOpts): Result<DealTerms, TermsRefusal> {
  const fail = (reason: TermsRefusal) => ({ ok: false as const, reason });
  if (!TEMPLATES.includes(terms.template)) return fail("UNKNOWN_TEMPLATE");
  if (terms.price <= 0n) return fail("ZERO_PRICE");
  if (terms.price > opts.budgetRemaining) return fail("OVER_BUDGET");
  if (terms.buyer === terms.seller) return fail("SELF_DEAL");
  if (!Number.isInteger(terms.deadline) || terms.deadline <= opts.now) return fail("DEADLINE_IN_PAST");
  if (terms.deadline - opts.now > (opts.maxDeadlineSecs ?? 30 * DAY)) return fail("DEADLINE_TOO_FAR");
  if (!Number.isInteger(terms.reviewSecs) || terms.reviewSecs < 0 || terms.reviewSecs > 30 * DAY) {
    return fail("BAD_REVIEW_WINDOW");
  }
  return { ok: true, value: terms };
}

/** Canonical JSON: sorted keys, bigint as decimal string. Same terms -> same bytes. */
export function canonicalJson(terms: DealTerms): string {
  const entries = Object.entries(terms)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

/** sha256 of the canonical terms; stored on chain at lock so the deal commits to what the buyer approved. */
export function termsHash(terms: DealTerms): Uint8Array {
  return sha256(new TextEncoder().encode(canonicalJson(terms)));
}

export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function formatDuration(secs: number): string {
  if (secs % DAY === 0 && secs >= DAY) return `${secs / DAY} day${secs === DAY ? "" : "s"}`;
  if (secs % 3600 === 0 && secs >= 3600) return `${secs / 3600} hour${secs === 3600 ? "" : "s"}`;
  if (secs % 60 === 0 && secs >= 60) return `${secs / 60} minute${secs === 60 ? "" : "s"}`;
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

/** The plain-language summary the buyer approves before any money moves. */
export function describeTerms(terms: DealTerms, opts: { decimals: number; symbol: string }): string {
  const price = `${formatAmount(terms.price, opts.decimals)} ${opts.symbol}`;
  const deadline = new Date(terms.deadline * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ");
  return [
    `You pay ${price} into escrow now. The seller is paid only after delivering: "${terms.task}".`,
    `If nothing is delivered by ${deadline}, the full ${price} is refunded to you.`,
    `After delivery you have ${formatDuration(terms.reviewSecs)} to release payment; if you do nothing, the seller can claim it.`,
  ].join(" ");
}
