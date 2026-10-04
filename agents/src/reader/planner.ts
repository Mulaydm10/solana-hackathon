/**
 * Reference buyer planner (PLAN §7: "code does the arithmetic", "the planner only sees parsed fields").
 * It decides from typed fields only: kind, grade, price, seller, listing address. Names and descriptions
 * are carried for display and never read by `decide`, so no text in a listing can change what is bought
 * or how much is paid. The injection corpus checks exactly that property; the team planner (#70) must pass
 * the same corpus through `runCorpus`.
 */
import type { Grade } from "@deal/core";
import { s, type Infer } from "./schema.ts";

/** What the reader may extract from a listing as published by a seller. */
export const LISTING_FIELDS = s.object({
  listing: s.address(),
  seller: s.address(),
  kind: s.oneOf(["Data", "Service", "Team"] as const),
  price: s.amount({ max: 10n ** 15n }),
  grade: s.oneOf(["A", "B", "C", "D"] as const),
  name: s.text({ max: 80 }),
  description: s.text({ max: 2_000, multiline: true }),
});
export type ParsedListing = Infer<typeof LISTING_FIELDS>;

export type BuyPolicy = {
  /** What is left to spend, base units. */
  budget: bigint;
  /** The most for one purchase, base units. */
  maxPrice: bigint;
  minGrade: Grade;
  kinds: ParsedListing["kind"][];
  blockedSellers?: readonly string[];
};

export type Decision = { action: "buy"; listing: string; seller: string; price: bigint } | { action: "none"; reason: "NO_ACCEPTABLE_LISTING" };

const RANK: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 };

/** The cheapest acceptable listing, best grade on ties, then the lowest address: total and deterministic. */
export function decide(candidates: readonly ParsedListing[], p: BuyPolicy): Decision {
  const limit = p.budget < p.maxPrice ? p.budget : p.maxPrice;
  const ok = candidates.filter(
    (c) => p.kinds.includes(c.kind) && RANK[c.grade] >= RANK[p.minGrade] && c.price > 0n && c.price <= limit && !(p.blockedSellers ?? []).includes(c.seller),
  );
  if (ok.length === 0) return { action: "none", reason: "NO_ACCEPTABLE_LISTING" };
  ok.sort((a, b) => (a.price !== b.price ? (a.price < b.price ? -1 : 1) : RANK[b.grade] - RANK[a.grade] || (a.listing < b.listing ? -1 : 1)));
  const best = ok[0]!;
  return { action: "buy", listing: best.listing, seller: best.seller, price: best.price };
}

/** The only side effects a planner decision can cause; recorded by tests, wired to chain/broker in #70. */
export type Effects = {
  /** Opens an escrow deal for exactly this listing and price (agent_open_deal in production). */
  openDeal(listing: string, seller: string, price: bigint): Promise<void>;
};

export async function execute(d: Decision, fx: Effects): Promise<void> {
  if (d.action === "buy") await fx.openDeal(d.listing, d.seller, d.price);
}
