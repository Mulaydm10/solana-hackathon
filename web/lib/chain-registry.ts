// The on-chain Registry (contracts/web.md): Listing accounts from the program, the seller's SellerRep, and the
// off-chain metadata and assessment report, each accepted only if it hashes to what the chain committed to.
//   - meta:   sha256(canonicalListing(meta))  must equal Listing.meta_hash, else the listing is not shown
//   - report: sha256(canonicalize(report))     must equal Listing.report_hash, AND the listing's assessor must
//             still be on the on-chain AssessorRegistry, else the listing shows as "not assessed"
// So nothing a seller (or this site's storage) writes can change what a buyer is shown about quality.
import {
  canonicalize, metaHash, sha256Hex, validateListingMeta, type Grade, type Json, type ListingMeta, type RepCounts,
} from "@deal/core";
import type { AttestedReport, Registry, RegistryListing } from "./registry";

const KINDS = ["Data", "Service", "Team"] as const;

/** One Listing account as decoded from chain (the generated client's shape, reduced to what we use). */
export type ChainListing = {
  address: string;
  seller: string;
  kind: number;
  mint: string;
  price: bigint;
  contentHash: Uint8Array;
  metaHash: Uint8Array;
  assessor: string;
  reportHash: Uint8Array;
  assessedAt: bigint;
  active: boolean;
  sales: bigint;
  createdAt: bigint;
};

/** What the registry needs from chain; `rpcSource` (lib/chain-source.ts) implements it over RPC. */
export type ChainSource = {
  listings(): Promise<ChainListing[]>;
  sellerRep(seller: string, mint: string): Promise<RepCounts>;
  assessors(): Promise<string[]>;
};

/** Off-chain documents, keyed by listing address: the metadata JSON and the assessor's report JSON. */
export type DocStore = {
  get(listing: string): Promise<{ meta?: string; report?: string } | null>;
};

/** The assessor report fields the site uses (agents/src/seller/assess.ts AssessmentReport). */
type ReportDoc = { grade: Grade; quality?: { ageDays?: number }; needsConfirmation?: boolean };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Accepts a stored metadata document only if it validates and hashes to the on-chain meta_hash. */
export function verifiedMeta(text: string | undefined, onChainMetaHash: Uint8Array): ListingMeta | null {
  const v = validateListingMeta(parse(text));
  if (!v.ok) return null;
  return hex(metaHash(v.value)) === hex(onChainMetaHash) ? v.value : null;
}

/** Accepts a stored report only if it hashes to the on-chain report_hash and its assessor is still registered. */
export async function verifiedReport(text: string | undefined, l: ChainListing, registered: readonly string[]): Promise<AttestedReport | null> {
  if (l.assessedAt === 0n || !registered.includes(l.assessor)) return null;
  const doc = parse(text) as ReportDoc | undefined;
  if (!doc || typeof doc !== "object" || !["A", "B", "C", "D"].includes(doc.grade)) return null;
  if (sha256Hex(canonicalize(doc as unknown as Json)) !== hex(l.reportHash)) return null;
  return {
    grade: doc.grade,
    reportHash: hex(l.reportHash),
    assessor: l.assessor,
    assessedAt: Number(l.assessedAt),
    ...(doc.quality?.ageDays !== undefined ? { ageDays: doc.quality.ageDays } : {}),
    containsPersonalData: doc.needsConfirmation === true,
  };
}

export function chainRegistry(source: ChainSource, docs: DocStore): Registry {
  const build = async (l: ChainListing, registered: readonly string[]): Promise<RegistryListing | null> => {
    const d = await docs.get(l.address);
    const meta = verifiedMeta(d?.meta, l.metaHash);
    const kind = KINDS[l.kind];
    if (!meta || !kind || meta.kind !== kind) return null; // unverifiable metadata is never rendered
    return {
      address: l.address, seller: l.seller, kind, mint: l.mint, price: l.price, contentHash: hex(l.contentHash), meta,
      report: await verifiedReport(d?.report, l, registered),
      active: l.active, sales: Number(l.sales), rep: await source.sellerRep(l.seller, l.mint), createdAt: Number(l.createdAt),
    };
  };
  return {
    async list() {
      const [all, registered] = await Promise.all([source.listings(), source.assessors()]);
      const built = await Promise.all(all.filter((l) => l.active).map((l) => build(l, registered)));
      return built.filter((x): x is RegistryListing => x !== null);
    },
    async get(address) {
      const [all, registered] = await Promise.all([source.listings(), source.assessors()]);
      const l = all.find((x) => x.address === address);
      return l ? build(l, registered) : null;
    },
  };
}

/** In-memory documents (tests and local dev); production uses blob storage behind the same interface. */
export function memoryDocStore(docs: Record<string, { meta?: string; report?: string }> = {}): DocStore & { put(listing: string, d: { meta?: string; report?: string }): void } {
  return {
    get: async (l) => docs[l] ?? null,
    put: (l, d) => void (docs[l] = { ...docs[l], ...d }),
  };
}
