// One escrow deal as the chain shows it (browser- and server-safe): the deal account plus its DealLink. Shared by the
// deal page and the key/terms routes, so both judge the same facts.
import { createSolanaRpc, type Address } from "@solana/kit";
import { fetchMaybeDeal, fetchMaybeDealLink, findLinkPda, STATUS_NAMES } from "@deal/chain";

export type DealView = {
  deal: string;
  buyer: string;
  seller: string;
  mint: string;
  verifier: string;
  status: string;
  /** Token base units, as decimal strings (JSON-safe). */
  amount: string;
  stakeRequired: string;
  bondBps: number;
  deadline: number;
  reviewSecs: number;
  deliveredAt: number;
  termsHash: string;
  deliveryHash: string;
  /** From the deal's DealLink: the listing it was opened from (null for a plain deal). */
  listing: string | null;
  /** For Data listings, the content hash the delivery must equal ("" = no check). */
  expectedDeliveryHash: string;
};

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ZERO = "00".repeat(32);
export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type DealRpc = Parameters<typeof fetchMaybeDeal>[0];

/** null when there is no such deal (or the address is malformed). Throws only on transport errors. */
export async function readDealView(rpc: DealRpc, deal: string): Promise<DealView | null> {
  if (!ADDRESS.test(deal)) return null;
  const d = await fetchMaybeDeal(rpc, deal as Address);
  if (!d.exists) return null;
  const link = await fetchMaybeDealLink(rpc, (await findLinkPda({ deal: deal as Address }))[0]);
  const x = d.data;
  const expected = link.exists ? hex(link.data.expectedDeliveryHash) : ZERO;
  return {
    deal, buyer: x.buyer, seller: x.seller, mint: x.mint, verifier: x.verifier, status: STATUS_NAMES[x.status] ?? "Unknown",
    amount: x.amount.toString(), stakeRequired: x.stakeRequired.toString(), bondBps: x.bondBps,
    deadline: Number(x.deadline), reviewSecs: Number(x.reviewSecs), deliveredAt: Number(x.deliveredAt),
    termsHash: hex(x.termsHash), deliveryHash: hex(x.deliveryHash),
    listing: link.exists ? link.data.listing : null, expectedDeliveryHash: expected === ZERO ? "" : expected,
  };
}

export const rpcFor = (url: string) => createSolanaRpc(url) as unknown as DealRpc;
