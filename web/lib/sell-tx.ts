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
