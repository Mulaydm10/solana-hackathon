/**
 * Price suggestion for a new listing (PLAN §3, §4.1 step 4). Every number is computed here, in integer
 * basis points on bigint base units, so the same inputs give the same range in every engine. A model may
 * later rephrase `reasons`, never change the numbers. The seller sees the range and may choose any price.
 */
import type { ListingKind } from "./listing.ts";
import type { RepScore } from "./rep.ts";
import { formatAmount } from "./terms.ts";

export type Grade = "A" | "B" | "C" | "D";

export type Assessment = {
  grade: Grade;
  sizeBytes?: number;
  /** Share of the promised scope actually present (rows, fields, dates), basis points 0-10000. */
  coverageBps?: number;
};

/** A listing or past sale in the same category; the caller picks the category. */
export type Comparable = {
  kind: ListingKind;
  price: bigint;
  /** A completed sale (stronger evidence) rather than an asking price. */
  sold: boolean;
  sizeBytes?: number;
};

export type PriceInput = {
  kind: ListingKind;
  assessment?: Assessment;
  comparables: readonly Comparable[];
  rep?: RepScore;
  /** Age of the newest data, days (Data only; services and teams do not go stale). */
  ageDays?: number;
  /** Starting price when there is no comparable at all; defaults to `DEFAULT_ANCHOR` (6-decimal USDC). */
  anchor?: bigint;
  /** For the wording of `reasons` only. */
  decimals?: number;
  symbol?: string;
};

export type PriceSuggestion = { low: bigint; mid: bigint; high: bigint; reasons: string[] };

const BPS = 10_000n;

export const PRICING = {
  /** Used when no comparable exists: 5 USDC per dataset, 0.01 USDC per call, 50 USDC per team job. */
  defaultAnchor: { Data: 5_000_000n, Service: 10_000n, Team: 50_000_000n } as Record<ListingKind, bigint>,
  /** At least this many completed sales and only sales are used; otherwise sales and asking prices together. */
  minSales: 3,
  grade: { A: 12_000n, B: 10_000n, C: 8_000n, D: 6_000n } as Record<Grade, bigint>,
  /** Freshness (from Carpool): full value for 30 days, then -10% per 90 days, never below 40%. */
  fresh: { fullDays: 30, stepDays: 90, stepBps: 1_000, floorBps: 4_000 },
  /** Reputation: +10% at score >= 90, -10% below 60; no premium while CONCENTRATED or HIGH_FAILURE. */
  rep: { highScore: 90, lowScore: 60, upBps: 11_000n, downBps: 9_000n },
  /** Size relative to the comparables' median size, clamped. */
  size: { minBps: 5_000n, maxBps: 20_000n },
  coverageFloorBps: 5_000n,
  /** Half-width of the range: tighter with more evidence. */
  spread: { many: 1_500n, few: 2_500n, none: 4_000n },
} as const;

function median(xs: readonly bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

const clamp = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);
const pct = (bps: bigint) => {
  const d = Number(bps - BPS) / 100;
  return `${d > 0 ? "+" : ""}${d}%`;
};

export function freshnessBps(ageDays: number): bigint {
  const f = PRICING.fresh;
  const age = Number.isFinite(ageDays) && ageDays > 0 ? Math.floor(ageDays) : 0;
  if (age <= f.fullDays) return BPS;
  const cut = Math.floor(((age - f.fullDays) * f.stepBps) / f.stepDays);
  return BigInt(Math.max(f.floorBps, 10_000 - cut));
}

export function suggestPrice(input: PriceInput): PriceSuggestion {
  const money = (x: bigint) => `${formatAmount(x, input.decimals ?? 6)} ${input.symbol ?? "USDC"}`;
  const reasons: string[] = [];
  const same = input.comparables.filter((c) => c.kind === input.kind && c.price > 0n);
  const sales = same.filter((c) => c.sold);
  const evidence = sales.length >= PRICING.minSales ? sales : same;

  let mid: bigint;
  if (evidence.length > 0) {
    mid = median(evidence.map((c) => c.price));
    reasons.push(
      evidence === sales
        ? `Median of ${sales.length} recent sales in this category: ${money(mid)}.`
        : `Median of ${evidence.length} listings and sales in this category: ${money(mid)}.`,
    );
  } else {
    mid = input.anchor && input.anchor > 0n ? input.anchor : PRICING.defaultAnchor[input.kind];
    reasons.push(`No comparable listings yet; starting from ${money(mid)}.`);
  }

  const apply = (bps: bigint, why: string) => {
    if (bps === BPS) return;
    mid = (mid * bps) / BPS;
    reasons.push(`${why}: ${pct(bps)}.`);
  };

  const a = input.assessment;
  if (a) {
    apply(PRICING.grade[a.grade], `Assessed grade ${a.grade}`);
    const sizes = evidence.flatMap((c) => (c.sizeBytes && c.sizeBytes > 0 ? [BigInt(Math.floor(c.sizeBytes))] : []));
    if (a.sizeBytes && a.sizeBytes > 0 && sizes.length > 0) {
      const bps = clamp((BigInt(Math.floor(a.sizeBytes)) * BPS) / median(sizes), PRICING.size.minBps, PRICING.size.maxBps);
      apply(bps, "Size compared with similar listings");
    }
    if (a.coverageBps !== undefined && Number.isFinite(a.coverageBps)) {
      const c = clamp(BigInt(Math.floor(a.coverageBps)), 0n, BPS);
      apply(c < PRICING.coverageFloorBps ? PRICING.coverageFloorBps : c, "Coverage of the promised scope");
    }
  } else {
    reasons.push("Not assessed yet, so no quality adjustment.");
  }

  if (input.kind === "Data" && input.ageDays !== undefined) {
    apply(freshnessBps(input.ageDays), `Newest data is ${Math.max(0, Math.floor(input.ageDays))} days old`);
  }

  const r = input.rep;
  if (r) {
    if (r.score === null) reasons.push("Seller has no reputation score yet, so no adjustment.");
    else if (r.score >= PRICING.rep.highScore && r.flags.length === 0) apply(PRICING.rep.upBps, `Seller score ${r.score}/100`);
    else if (r.score < PRICING.rep.lowScore) apply(PRICING.rep.downBps, `Seller score ${r.score}/100`);
    if (r.flags.length > 0 && r.score !== null && r.score >= PRICING.rep.highScore) {
      reasons.push("No reputation premium while the seller's record is flagged.");
    }
  }

  if (mid < 1n) mid = 1n;
  const half = evidence.length >= 5 ? PRICING.spread.many : evidence.length > 0 ? PRICING.spread.few : PRICING.spread.none;
  let low = (mid * (BPS - half)) / BPS;
  if (low < 1n) low = 1n;
  const high = (mid * (BPS + half)) / BPS;
  reasons.push(`Range ${money(low)} to ${money(high)} (${pct(BPS + half).replace("+", "±")}, ${evidence.length >= 5 ? "plenty of" : evidence.length > 0 ? "little" : "no"} evidence).`);
  return { low, mid, high: high < mid ? mid : high, reasons };
}
