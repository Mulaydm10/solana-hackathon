// The listing registry the site reads (PLAN §8). One typed interface; today an in-memory fixture
// implementation, later the on-chain one over @deal/chain `listings` (after #62), behind the same shape.
//
// Rule (#95 review): what the page shows as quality and trust comes from the assessor's report (attested on
// chain by a registered assessor) and from the program's SellerRep counts, never from seller-written text.
// `meta` is seller-written and is only ever shown as quoted text.
import type { Grade, ListingKind, ListingMeta, RepCounts } from "@deal/core";

export type AttestedReport = {
  /** From the assessor's report, verified against `Listing.report_hash` by the chain implementation. */
  grade: Grade;
  /** sha256 hex of the canonical report (= Listing.report_hash). */
  reportHash: string;
  assessor: string;
  /** Unix seconds. */
  assessedAt: number;
  /** Days since the newest data point, when the report found dates. */
  ageDays?: number;
  /** Personal data was found and the seller confirmed listing it anyway. */
  containsPersonalData: boolean;
};

export type RegistryListing = {
  /** The Listing account address. */
  address: string;
  seller: string;
  kind: ListingKind;
  mint: string;
  /** Token base units. */
  price: bigint;
  /** sha256 hex of the content (Data), endpoint descriptor (Service) or blueprint (Team). */
  contentHash: string;
  /** Seller-written metadata, bound on chain by `meta_hash`. */
  meta: ListingMeta;
  /** null until a registered assessor attests. Unattested listings cannot be bought (create_deal refuses). */
  report: AttestedReport | null;
  active: boolean;
  /** Completed sales (a statistic only: it can be under-counted, never inflated). */
  sales: number;
  /** The seller's SellerRep in this listing's mint. */
  rep: RepCounts;
  /** Unix seconds. */
  createdAt: number;
};

export interface Registry {
  /** Every active listing. */
  list(): Promise<RegistryListing[]>;
  /** One listing by address, or null. */
  get(address: string): Promise<RegistryListing | null>;
}

export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = 1_791_072_000; // 2026-10-04: fixtures are dated relative to this, so pages render the same every time

const rep = (completed: number, buyers: number, failed = 0, volume = completed * 5_000_000, maxPair = Math.floor(volume / Math.max(1, buyers))): RepCounts => ({
  completed, failed, neutral: 0, volume: BigInt(volume), distinctBuyers: buyers, maxPairVolume: BigInt(maxPair),
});

/** Demo listings covering every kind and every trust state the pages must render. */
export const FIXTURES: RegistryListing[] = [
  {
    address: "6pX1dEuPowerPrices2025DataListingAddr11111", seller: "SeLLerEnergy1111111111111111111111111111111", kind: "Data", mint: USDC_DEVNET,
    price: 6_000_000n, contentHash: "4f".repeat(32), active: true, sales: 41, createdAt: NOW - 30 * 86_400,
    meta: { kind: "Data", name: "EU day-ahead power prices 2025", description: "Hourly prices for 12 bidding zones, cleaned and gap-filled.", category: "energy", tags: ["prices", "eu", "hourly"], format: "csv", sizeBytes: 2_400_000, rows: 105_120, columns: ["hour", "zone", "price_eur_mwh"] },
    report: { grade: "A", reportHash: "a1".repeat(32), assessor: "AssessorOne111111111111111111111111111111111", assessedAt: NOW - 29 * 86_400, ageDays: 2, containsPersonalData: false },
    rep: rep(48, 19),
  },
  {
    address: "7qY2ShippingRatesDataListingAddr22222222222", seller: "SeLLerLogistics11111111111111111111111111111", kind: "Data", mint: USDC_DEVNET,
    price: 2_500_000n, contentHash: "5e".repeat(32), active: true, sales: 3, createdAt: NOW - 10 * 86_400,
    meta: { kind: "Data", name: "Container shipping rates Asia-Europe", description: "Weekly spot rates, 2019-2026.", category: "logistics", tags: ["shipping", "rates"], format: "csv", sizeBytes: 180_000, rows: 400 },
    report: { grade: "C", reportHash: "b2".repeat(32), assessor: "AssessorOne111111111111111111111111111111111", assessedAt: NOW - 9 * 86_400, ageDays: 400, containsPersonalData: false },
    rep: rep(4, 2),
  },
  {
    address: "8rZ3InvoiceOcrServiceListingAddr33333333333", seller: "SeLLerDocs111111111111111111111111111111111", kind: "Service", mint: USDC_DEVNET,
    price: 20_000n, contentHash: "6d".repeat(32), active: true, sales: 1_210, createdAt: NOW - 60 * 86_400,
    meta: { kind: "Service", name: "Invoice OCR", description: "Reads a PDF invoice and returns line items as JSON.", category: "documents", tags: ["ocr", "invoices"], endpoint: "https://ocr.example.com/v1/read", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    report: { grade: "A", reportHash: "c3".repeat(32), assessor: "AssessorTwo111111111111111111111111111111111", assessedAt: NOW - 59 * 86_400, containsPersonalData: false },
    rep: rep(1_190, 140, 12),
  },
  {
    address: "9sA4TripPlannerTeamListingAddr4444444444444", seller: "SeLLerTravel11111111111111111111111111111111", kind: "Team", mint: USDC_DEVNET,
    price: 45_000_000n, contentHash: "d0789d9f8e3dbb5c92e5f0a70b6230866f1fef26104554800dcaa7b89dafafeb", active: true, sales: 12, createdAt: NOW - 20 * 86_400,
    meta: { kind: "Team", name: "Trip planner", description: "A researcher and a writer plan a trip and hold bookings.", category: "travel", tags: ["trips"], blueprintHash: "d0789d9f8e3dbb5c92e5f0a70b6230866f1fef26104554800dcaa7b89dafafeb", roles: ["researcher", "writer"], deliverable: "A day-by-day trip plan", maxDurationSecs: 604_800 },
    report: { grade: "B", reportHash: "d4".repeat(32), assessor: "AssessorOne111111111111111111111111111111111", assessedAt: NOW - 19 * 86_400, containsPersonalData: false },
    rep: rep(12, 11),
  },
  {
    address: "AtB5CustomerListDataListingAddr55555555555", seller: "SeLLerWash111111111111111111111111111111111", kind: "Data", mint: USDC_DEVNET,
    price: 9_000_000n, contentHash: "7c".repeat(32), active: true, sales: 15, createdAt: NOW - 5 * 86_400,
    // The description claims an A grade; the page must show the assessor's B and the concentration flag.
    meta: { kind: "Data", name: "B2B leads, DACH", description: "Grade A verified! Best data on the market, buy now.", category: "sales", tags: ["leads"], format: "csv", sizeBytes: 90_000, rows: 1_200 },
    report: { grade: "B", reportHash: "e5".repeat(32), assessor: "AssessorTwo111111111111111111111111111111111", assessedAt: NOW - 4 * 86_400, ageDays: 6, containsPersonalData: true },
    rep: rep(15, 3, 0, 75_000_000, 60_000_000),
  },
  {
    address: "BuC6NewSellerDataListingAddr666666666666666", seller: "SeLLerNew1111111111111111111111111111111111", kind: "Data", mint: USDC_DEVNET,
    price: 1_000_000n, contentHash: "8b".repeat(32), active: true, sales: 0, createdAt: NOW - 86_400,
    meta: { kind: "Data", name: "Berlin bike counts", description: "Daily counts from 30 stations.", category: "mobility", tags: ["bikes", "berlin"], format: "json", sizeBytes: 50_000 },
    report: null, // not attested yet: visible, but cannot be bought
    rep: rep(0, 0),
  },
];

export function fixtureRegistry(listings: RegistryListing[] = FIXTURES): Registry {
  return {
    list: async () => listings.filter((l) => l.active),
    get: async (address) => listings.find((l) => l.address === address) ?? null,
  };
}

/** The registry the pages use. Swapped for the on-chain implementation after #62. */
export function registry(): Registry {
  return fixtureRegistry();
}
