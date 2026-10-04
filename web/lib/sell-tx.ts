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

/** The data upload limit (lib/sell.ts MAX_DATA_BYTES), checked in the browser before uploading. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const tooLarge = (bytes: number) =>
  `This file is ${(bytes / 1024 / 1024).toFixed(1)} MB; data listings take at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Choose a smaller file.`;

/**
 * A /api/sell/* reply as an object, also when it is not JSON (#137): a proxy or the platform may answer with
 * plain text, e.g. HTTP 413 "Request Entity Too Large", which must read as a refusal, not a JSON parse error.
 */
export async function readReply(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // not JSON: fall through
  }
  if (res.status === 413) return { ok: false, reason: "TOO_LARGE", message: `the upload is too large for the server; data listings take at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` };
  return { ok: false, reason: `HTTP_${res.status}`, message: `the server answered HTTP ${res.status}${res.ok ? " without a JSON reply" : ""}; try again` };
}
