// Browser-safe: the create_listing transaction the seller's own wallet signs (#110), from the parameters the
// server's draft returned. The seller's token account is created in the same transaction (idempotent): buyers'
// payments and x402 calls need it to exist (#88).
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { getCreateListingInstructionAsync, listingAddress, ListingKind } from "@deal/chain";

export type DraftedListing = { kind: "Data" | "Service"; price: string; contentHash: string; metaHash: string; termsTemplateHash: string; assessor: string };

const hex32 = (h: string) => {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("bad hash");
  return Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16));
};

export async function createListingIxs(seller: TransactionSigner, mint: Address, listingId: bigint, l: DraftedListing): Promise<{ listing: Address; ixs: Instruction[] }> {
  if (l.assessor === seller.address) throw new Error("the assessor cannot be the seller");
  const price = BigInt(l.price);
  if (price <= 0n) throw new Error("a listing needs a price");
  return {
    listing: await listingAddress(seller.address, listingId),
    ixs: [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: seller, owner: seller.address, mint }),
      await getCreateListingInstructionAsync({
        seller, mint, listingId, kind: ListingKind[l.kind], price, contentHash: hex32(l.contentHash), metaHash: hex32(l.metaHash),
        termsTemplateHash: hex32(l.termsTemplateHash), assessor: l.assessor as Address,
      }),
    ],
  };
}

/** base64 of a file's bytes, in chunks (no huge argument lists). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Finding = { type: string; count: number };
type Report = {
  scope?: string; format?: string; sizeBytes?: number; integrity?: { parses?: boolean };
  quality?: { rows: number; columns: number; nullBps: number; duplicateRows: number; outliers: Finding[]; newestDate?: string; ageDays?: number };
  safety?: { pii: Finding[]; secrets: Finding[] };
  probe?: { status: number; schemaOk: boolean; latencyMs: number };
  dryRun?: { stages: number; capabilities: number };
};
const findings = (f: Finding[] | undefined) => (f?.length ? f.map((x) => `${x.type} (${x.count})`).join(", ") : "none");

/** The assessor's report as plain lines, written by code from its numbers (seller text is never shown as a finding). */
export function reportLines(r: Report | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  out.push(`Scope: ${r.scope === "sample" ? "a sample" : "the full content"}${r.format ? `, ${r.format}` : ""}${r.sizeBytes !== undefined ? `, ${r.sizeBytes} bytes` : ""}`);
  if (r.integrity) out.push(`Integrity: ${r.integrity.parses ? "parses cleanly" : "does not parse"}`);
  const q = r.quality;
  if (q) {
    out.push(`Quality: ${q.rows} rows, ${q.columns} columns, ${(q.nullBps / 100).toFixed(2)}% empty cells, ${q.duplicateRows} duplicate rows`);
    out.push(`Outliers: ${findings(q.outliers)}`);
    if (q.newestDate) out.push(`Newest data: ${q.newestDate}${q.ageDays !== undefined ? ` (${q.ageDays} days old)` : ""}`);
  }
  if (r.safety) out.push(`Personal data: ${findings(r.safety.pii)}; secrets: ${findings(r.safety.secrets)}`);
  if (r.probe) out.push(`Probe: HTTP ${r.probe.status}, output ${r.probe.schemaOk ? "matches" : "does not match"} the schema, ${r.probe.latencyMs} ms`);
  if (r.dryRun) out.push(`Dry run: ${r.dryRun.stages} stages, ${r.dryRun.capabilities} capabilities`);
  return out;
}
