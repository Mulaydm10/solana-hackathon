/**
 * Seller reputation score (PLAN §2.1, from Assay). The program keeps honest counts in `SellerRep`;
 * this turns them into a score, or refuses to score when there is too little evidence to trust.
 * Counts may come straight from chain `getSellerRep` (numbers and decimal strings) or as bigints.
 */

type Count = number | bigint | string;

export type RepCounts = {
  completed: Count;
  failed: Count;
  neutral: Count;
  /** Sum paid for completed work, token base units. */
  volume: Count;
  distinctBuyers: Count;
  /** Largest completed volume with any one buyer. */
  maxPairVolume: Count;
};

export type RepFlag = "CONCENTRATED" | "HIGH_FAILURE";

export type RepScore =
  | { score: null; reason: "TOO_FEW_DEALS" | "TOO_FEW_BUYERS"; flags: RepFlag[] }
  | { score: number; flags: RepFlag[] };

export const REP_RULES = {
  /** No score below this many completed deals. */
  minDeals: 10,
  /** No score below this many distinct buyers with a completed deal. */
  minBuyers: 3,
  /** CONCENTRATED when one buyer is more than this share of volume (basis points). */
  maxPairShareBps: 5_000,
  /** HIGH_FAILURE when failed / (completed + failed) is more than this (basis points). */
  maxFailureBps: 2_000,
} as const;

const big = (c: Count): bigint => {
  const b = BigInt(c);
  return b < 0n ? 0n : b;
};

/**
 * Score 0-100 = the lower bound of the 95% Wilson interval on the delivery success rate
 * (completed vs failed; neutral outcomes say nothing about the seller). A seller with 10 perfect deals
 * scores lower than one with 200, because the evidence is weaker. Flags are reported in every case.
 */
export function repScore(rep: RepCounts): RepScore {
  const completed = big(rep.completed);
  const failed = big(rep.failed);
  const volume = big(rep.volume);
  const flags: RepFlag[] = [];
  if (volume > 0n && big(rep.maxPairVolume) * 10_000n > volume * BigInt(REP_RULES.maxPairShareBps)) flags.push("CONCENTRATED");
  const decided = completed + failed;
  if (decided > 0n && failed * 10_000n > decided * BigInt(REP_RULES.maxFailureBps)) flags.push("HIGH_FAILURE");

  if (completed < BigInt(REP_RULES.minDeals)) return { score: null, reason: "TOO_FEW_DEALS", flags };
  if (big(rep.distinctBuyers) < BigInt(REP_RULES.minBuyers)) return { score: null, reason: "TOO_FEW_BUYERS", flags };
  return { score: wilsonLowerPct(Number(completed), Number(decided)), flags };
}

function wilsonLowerPct(success: number, n: number): number {
  const z = 1.96;
  const p = success / n;
  const z2 = z * z;
  const lower = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return Math.max(0, Math.min(100, Math.floor(lower * 100)));
}

/** One line for listing pages and approvals. */
export function describeRep(r: RepScore): string {
  const flags = r.flags.map((f) => (f === "CONCENTRATED" ? "one buyer is over half of the volume" : "many failed deliveries"));
  const head =
    r.score === null
      ? r.reason === "TOO_FEW_DEALS"
        ? `no score yet (fewer than ${REP_RULES.minDeals} completed deals)`
        : `no score yet (fewer than ${REP_RULES.minBuyers} different buyers)`
      : `score ${r.score}/100`;
  return flags.length ? `${head}; warning: ${flags.join(", ")}` : head;
}
