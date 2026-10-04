// Catalogue search, filters and ranking (PLAN §8). Pure and deterministic: the same query always gives the
// same order. Ranking uses only verified fields (assessor grade, SellerRep score), never seller text.
import { repScore, type Grade, type ListingKind, type RepScore } from "@deal/core";
import type { RegistryListing } from "./registry";

export type Query = {
  q?: string;
  kind?: ListingKind;
  category?: string;
  /** Token base units. */
  maxPrice?: bigint;
  minGrade?: Grade;
  /** Hide sellers whose record is flagged (CONCENTRATED, HIGH_FAILURE). */
  hideFlagged?: boolean;
  /** Hide listings no registered assessor has attested (they cannot be bought yet). */
  attestedOnly?: boolean;
};

export type Ranked = RegistryListing & { score: RepScore; match: number };

const RANK: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1 };
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** How well a listing matches the search words: name 3, tags and category 2, description 1 per word. */
export function matchScore(l: RegistryListing, q: string | undefined): number {
  const want = words(q ?? "");
  if (want.length === 0) return 1;
  const name = new Set(words(l.meta.name));
  const tags = new Set([...l.meta.tags.flatMap(words), ...words(l.meta.category)]);
  const desc = new Set(words(l.meta.description));
  return want.reduce((n, w) => n + (name.has(w) ? 3 : 0) + (tags.has(w) ? 2 : 0) + (desc.has(w) ? 1 : 0), 0);
}

export function search(listings: readonly RegistryListing[], query: Query): Ranked[] {
  return listings
    .map((l) => ({ ...l, score: repScore(l.rep), match: matchScore(l, query.q) }))
    .filter((l) =>
      l.match > 0
      && (!query.kind || l.kind === query.kind)
      && (!query.category || l.meta.category === query.category)
      && (query.maxPrice === undefined || l.price <= query.maxPrice)
      && (!query.minGrade || (l.report !== null && RANK[l.report.grade] >= RANK[query.minGrade]))
      && (!query.hideFlagged || l.score.flags.length === 0)
      && (!query.attestedOnly || l.report !== null))
    .sort((a, b) =>
      b.match - a.match
      || (b.score.score ?? -1) - (a.score.score ?? -1)
      || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)
      || (b.report?.assessedAt ?? 0) - (a.report?.assessedAt ?? 0)
      || (a.address < b.address ? -1 : 1));
}

/** A decimal USDC amount ("2", "2.5") in 6-decimal base units, or undefined if malformed. */
function usdcToBase(s: string | undefined): bigint | undefined {
  const m = s?.trim().match(/^(\d{1,14})(?:\.(\d{1,6}))?$/);
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : undefined;
}

/** Reads a query from URL search params, ignoring anything malformed (never throws). */
export function parseQuery(p: Record<string, string | string[] | undefined>): Query {
  const one = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const kind = one("kind");
  const grade = one("minGrade");
  const max = one("maxPrice");
  return {
    q: one("q")?.slice(0, 200),
    kind: kind === "Data" || kind === "Service" || kind === "Team" ? kind : undefined,
    category: one("category")?.match(/^[a-z0-9-]{1,32}$/)?.[0],
    // `maxPrice` is base units (API, llms.txt); `maxUsdc` is what the catalogue form sends.
    maxPrice: max && /^\d{1,20}$/.test(max) ? BigInt(max) : usdcToBase(one("maxUsdc")),
    minGrade: grade === "A" || grade === "B" || grade === "C" || grade === "D" ? grade : undefined,
    hideFlagged: one("hideFlagged") === "1",
    attestedOnly: one("attestedOnly") === "1",
  };
}

export const categories = (listings: readonly RegistryListing[]) => [...new Set(listings.map((l) => l.meta.category))].sort();
