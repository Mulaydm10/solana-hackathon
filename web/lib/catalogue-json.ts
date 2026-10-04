// The one machine-readable view of the registry: /api/catalogue (MCP find_listings) and /llms.txt use it.
import { describeRep, formatAmount } from "@deal/core";
import type { Ranked } from "./catalogue";

export const usdc = (base: bigint) => `${formatAmount(base, 6)} USDC`;

export function catalogueItem(l: Ranked, site: string) {
  return {
    address: l.address,
    seller: l.seller,
    kind: l.kind,
    name: l.meta.name,
    category: l.meta.category,
    tags: l.meta.tags,
    price: l.price.toString(),
    priceUsdc: formatAmount(l.price, 6),
    perCall: l.kind === "Service",
    // Verified fields only: the assessor's grade (null until attested) and the scored SellerRep.
    grade: l.report?.grade ?? null,
    attested: l.report !== null,
    reputation: { score: l.score.score, flags: l.score.flags, summary: describeRep(l.score) },
    url: new URL(`/listing/${l.address}`, site).toString(),
  };
}
