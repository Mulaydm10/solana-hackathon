// ChainSource over RPC (server-side): Listing accounts by discriminator, SellerRep, the assessor registry.
import {
  DEAL_ESCROW_PROGRAM_ADDRESS, LISTING_DISCRIMINATOR, getAssessorRegistryDecoder, getListingDecoder, getSellerRepDecoder,
  registryAddress, sellerRepAddress,
} from "@deal/chain";
import type { Address } from "@solana/kit";
import { base58Encode, type RepCounts } from "@deal/core";
import type { ChainListing, ChainSource } from "./chain-registry";

type B64Account = { data: [string, "base64"] } | null;
/** The two RPC calls we need, typed loosely so any Kit RPC (or a test double) fits. */
export type MinimalRpc = {
  getProgramAccounts(program: Address, o: object): { send(): Promise<{ pubkey: Address; account: { data: [string, "base64"] } }[]> };
  getAccountInfo(a: Address, o: object): { send(): Promise<{ value: B64Account }> };
};

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function decodeListingAccount(address: string, data: Uint8Array): ChainListing {
  const x = getListingDecoder().decode(data);
  return {
    address, seller: x.seller, kind: x.kind, mint: x.mint, price: x.price, contentHash: Uint8Array.from(x.contentHash),
    metaHash: Uint8Array.from(x.metaHash), assessor: x.assessor, reportHash: Uint8Array.from(x.reportHash),
    assessedAt: x.assessedAt, active: x.active, sales: x.sales, createdAt: x.createdAt,
  };
}

const ZERO_REP: RepCounts = { completed: 0, failed: 0, neutral: 0, volume: 0n, distinctBuyers: 0, maxPairVolume: 0n };

export function rpcSource(rpc: MinimalRpc): ChainSource {
  return {
    async listings() {
      const discriminator = base58Encode(Uint8Array.from(LISTING_DISCRIMINATOR));
      const rows = await rpc.getProgramAccounts(DEAL_ESCROW_PROGRAM_ADDRESS, {
        encoding: "base64",
        filters: [{ memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } }],
      }).send();
      return rows.map((r) => decodeListingAccount(r.pubkey, b64(r.account.data[0])));
    },
    async sellerRep(seller, mint) {
      const a = await sellerRepAddress(seller as Address, mint as Address);
      const info = (await rpc.getAccountInfo(a, { encoding: "base64" }).send()).value;
      if (!info) return ZERO_REP;
      const r = getSellerRepDecoder().decode(b64(info.data[0]));
      return { completed: r.completed, failed: r.failed, neutral: r.neutral, volume: r.volume, distinctBuyers: r.distinctBuyers, maxPairVolume: r.maxPairVolume };
    },
    async assessors() {
      const info = (await rpc.getAccountInfo(await registryAddress(), { encoding: "base64" }).send()).value;
      return info ? getAssessorRegistryDecoder().decode(b64(info.data[0])).assessors.map(String) : [];
    },
  };
}
