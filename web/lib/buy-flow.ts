// The buy flow's transactions (#111), built in the browser from the program's generated builders and signed in the
// buyer's or seller's own wallet. Pure builders: no RPC, no wallet; the pages wire them to lib/wallet-tx.
//   policyIx   - "Set up your budget": the buyer's BuyerPolicy, which create_deal needs (none exists yet)
//   buyIx      - a deal opened from a listing (content hash bound, #83), with the canonical terms it commits to
//   acceptIx   - the seller accepts (posts any stake)
//   deliverIx  - the seller delivers; for Data the delivery hash IS the listing's content hash (DealLink check)
import { type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getAcceptInstructionAsync, getInitPolicyInstructionAsync, getSubmitDeliveryInstructionAsync } from "@deal/chain";
import { canonicalJson, sha256Hex, type DealTerms } from "@deal/core";
import { FEE_REVIEW_SECS, feeDealIx, hexToBytes, randomDealId } from "./mission-flow";

export type Budget = {
  /** Token base units for each period. */
  periodBudget: bigint;
  /** The most for one purchase. */
  maxPrice: bigint;
  /** Seconds; default one day. */
  periodSecs?: bigint;
  /** null = any seller; a list = only these sellers (fail closed). */
  allowedSellers: string[] | null;
};

export type Refused = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

/** The buyer's spending policy. The buyer approves every purchase in its own wallet, so no co-signer is set. */
export async function policyIx(buyer: TransactionSigner, mint: Address, b: Budget): Promise<{ ok: true; ix: Instruction } | Refused> {
  if (b.periodBudget <= 0n || b.maxPrice <= 0n || b.maxPrice > b.periodBudget) return refuse("BAD_BUDGET", "the budget must be positive and at least the max price");
  if (b.allowedSellers && (b.allowedSellers.length === 0 || b.allowedSellers.length > 8)) return refuse("BAD_ALLOWLIST", "an allowlist needs 1 to 8 sellers");
  return {
    ok: true,
    ix: await getInitPolicyInstructionAsync({
      buyer, mint,
      params: {
        periodSecs: b.periodSecs ?? 86_400n, periodBudget: b.periodBudget, maxPrice: b.maxPrice,
        // Above-threshold purchases would need a co-signer; the threshold sits at the whole budget, so none does.
        approvalThreshold: b.periodBudget, approver: buyer.address,
        allowAnySeller: b.allowedSellers === null, allowedSellers: (b.allowedSellers ?? []) as Address[],
      },
    }),
  };
}

export type ListingForSale = { address: string; seller: string; kind: "Data" | "Service" | "Team"; mint: string; price: bigint; contentHash: string; name: string };

/** The canonical terms of a purchase from a listing; their sha256 is the deal's on-chain terms hash. */
export function purchaseTerms(buyer: string, l: ListingForSale, deadline: number): DealTerms {
  return {
    template: "pay_on_delivery", buyer, seller: l.seller, serviceId: l.address,
    task: `Deliver the listed ${l.kind.toLowerCase()} "${l.name}" (content ${l.contentHash.slice(0, 16)})`,
    price: l.price, deadline, reviewSecs: Number(FEE_REVIEW_SECS),
  };
}

export async function buyIx(
  buyer: TransactionSigner, l: ListingForSale, o: { mint: string; verifier: string; now: number; deliveryHours?: number; dealId?: bigint },
): Promise<{ ok: true; deal: Address; ix: Instruction; terms: string } | Refused> {
  // Nothing here is hard-coded to one token: the listing must be priced in the site's configured mint.
  if (l.mint !== o.mint) return refuse("MINT_MISMATCH", "this listing is priced in a different token than the site settles in");
  if (l.kind === "Team") return refuse("TEAM_LISTING", "teams are hired on the Hire page");
  const deadline = o.now + (o.deliveryHours ?? 24) * 3_600;
  const terms = canonicalJson(purchaseTerms(buyer.address, l, deadline));
  const { deal, ix } = await feeDealIx(buyer, {
    listing: { address: l.address, seller: l.seller, price: l.price, contentHash: l.contentHash },
    mint: o.mint as Address, verifier: o.verifier as Address, deadline: BigInt(deadline), termsHash: sha256Hex(terms), dealId: o.dealId ?? randomDealId(),
  });
  return { ok: true, deal, ix, terms };
}

const tokenAccount = async (owner: string, mint: string) =>
  (await findAssociatedTokenPda({ owner: owner as Address, mint: mint as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

export async function acceptIx(seller: TransactionSigner, d: { deal: string; mint: string; status: string }): Promise<{ ok: true; ix: Instruction } | Refused> {
  if (d.status !== "Open") return refuse("NOT_OPEN", `the deal is ${d.status}`);
  return { ok: true, ix: await getAcceptInstructionAsync({ seller, deal: d.deal as Address, mint: d.mint as Address, sellerToken: await tokenAccount(seller.address, d.mint) }) };
}

/** For a Data listing, the only delivery the program accepts is the listing's content hash. */
export async function deliverIx(
  seller: TransactionSigner, d: { deal: string; status: string; amount: string; expectedDeliveryHash: string }, deliveryHash?: string,
): Promise<{ ok: true; ix: Instruction } | Refused> {
  if (d.status !== "Funded") return refuse("NOT_FUNDED", `the deal is ${d.status}`);
  const h = d.expectedDeliveryHash || deliveryHash;
  if (!h || !/^[0-9a-f]{64}$/.test(h)) return refuse("NO_DELIVERY_HASH", "name the sha256 of what you delivered");
  return { ok: true, ix: await getSubmitDeliveryInstructionAsync({ seller, deal: d.deal as Address, deliveryHash: hexToBytes(h), invoiceAmount: BigInt(d.amount) }) };
}
