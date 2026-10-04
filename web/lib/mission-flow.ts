// The hire flow's transactions and checks, built in code from the program's generated builders (#73). Browser-safe:
// the pages call these with a no-op signer for the buyer, and the buyer's own wallet signs what they return.
//   - approveStageIx: an approval names a plan HASH; it is built only if the plan text shown to the buyer hashes to
//     it, so an approval of plan A can never be signed for (or replayed as) plan B
//   - waitingStage: the stage whose plan the team is waiting on (a "plan" event without its "approved")
//   - feeDealIx / releaseIx / challengeIx: the team's fee is an ordinary escrow deal opened from the Team listing;
//     the buyer releases exactly the final product's hash, or challenges it
import { type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  dealAddress, findLinkPda, getApproveStageInstructionAsync, getChallengeInstructionAsync, getCreateDealInstructionAsync, getCreateMissionInstructionAsync,
  getReleaseInstructionAsync, policyAddress, registryAddress, repPairAddress, sellerRepAddress,
} from "@deal/chain";
import { sha256Hex } from "@deal/core";

export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const HEX32 = /^[0-9a-f]{64}$/;

export type Plan = { stage: number; plan: string; planHash: string };
export type MissionEvent = { type: string; stage?: number; deliverableHash?: string };

/** A stage plan rendered by code from its canonical JSON (the text whose hash the buyer approves). */
export function describePlan(plan: string): string {
  try {
    const p = JSON.parse(plan) as { name?: unknown; roles?: unknown; cap?: unknown };
    const roles = Array.isArray(p.roles) ? p.roles.filter((r) => typeof r === "string").join(", ") : "";
    return `${typeof p.name === "string" ? p.name : "stage"} by ${roles || "no role"}, spend cap ${`${(Number(p.cap ?? 0) / 1e6).toFixed(2)} USDC`}`;
  } catch {
    return "unreadable plan";
  }
}

/** True only if `planHash` is the sha256 of exactly this plan text. */
export const planHashOk = (p: Plan) => HEX32.test(p.planHash) && sha256Hex(p.plan) === p.planHash;

/** The stage the team is waiting on: its plan is out and the buyer has not approved it yet. */
export function waitingStage(events: readonly MissionEvent[]): number | null {
  const approved = new Set(events.filter((e) => e.type === "approved").map((e) => e.stage));
  const waiting = events.filter((e) => e.type === "plan" && !approved.has(e.stage)).at(-1);
  return waiting?.stage ?? null;
}

export type Refused = { ok: false; reason: string; message: string };

export async function approveStageIx(
  buyer: TransactionSigner, mission: Address, plans: readonly Plan[], stage: number, digest: string,
): Promise<{ ok: true; ix: Instruction } | Refused> {
  const p = plans.find((x) => x.stage === stage);
  if (!p) return { ok: false, reason: "NO_SUCH_STAGE", message: `there is no stage ${stage + 1}` };
  if (!planHashOk(p)) return { ok: false, reason: "PLAN_HASH_MISMATCH", message: "the plan shown does not hash to the plan hash; nothing to sign" };
  if (!HEX32.test(digest)) return { ok: false, reason: "BAD_DIGEST", message: "the mandate digest is malformed" };
  return { ok: true, ix: await getApproveStageInstructionAsync({ buyer, mission, stage, planHash: hexToBytes(p.planHash), mandatesDigest: hexToBytes(digest) }) };
}

/** create_mission's parameters as the mission service sends them (bigints and byte arrays as strings). */
export type CreateWire = {
  missionId: string; budget: string; termsHash: string; stageCaps: string[]; expiresAt: string; verifier: string;
  minReviewSecs?: string; minResolveSecs?: string; maxToleranceBps?: number; maxBondBps?: number; minStakeBps?: number; rentLamports?: string;
};

/** The buyer funds the mission's expense budget; the buyer's floors for every agent deal are fixed here. */
export async function createMissionIx(buyer: TransactionSigner, mint: Address, teamListing: Address, cp: CreateWire): Promise<Instruction> {
  const [buyerToken] = await findAssociatedTokenPda({ owner: buyer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return getCreateMissionInstructionAsync({
    buyer, mint, buyerToken, missionId: BigInt(cp.missionId), budget: BigInt(cp.budget), termsHash: hexToBytes(cp.termsHash), teamListing,
    stageCaps: cp.stageCaps.map((x) => BigInt(x)), expiresAt: BigInt(cp.expiresAt), rentLamports: BigInt(cp.rentLamports ?? "50000000"),
    verifier: cp.verifier as Address, minReviewSecs: BigInt(cp.minReviewSecs ?? "600"), minResolveSecs: BigInt(cp.minResolveSecs ?? "600"),
    maxToleranceBps: Number(cp.maxToleranceBps ?? 500), maxBondBps: Number(cp.maxBondBps ?? 1000), minStakeBps: Number(cp.minStakeBps ?? 0),
  });
}

export type TeamListing = { address: string; seller: string; price: bigint; contentHash: string };

export type FeeDealParams = {
  listing: TeamListing;
  mint: Address;
  /** The mission's terms hash: the fee deal commits to the same terms the buyer signed. */
  termsHash: string;
  verifier: Address;
  /** Unix seconds: the team must deliver the final product by then (the mission's expiry). */
  deadline: bigint;
  dealId: bigint;
};

/** Review a whole team job for a day; the verifier gets an hour to rule on a challenge. */
export const FEE_REVIEW_SECS = 86_400n;
export const FEE_RESOLVE_SECS = 3_600n;

/** The buyer opens the team's fee deal from the Team listing (price, seller and content hash checked on chain). */
export async function feeDealIx(buyer: TransactionSigner, p: FeeDealParams): Promise<{ deal: Address; ix: Instruction }> {
  const deal = await dealAddress(buyer.address, p.dealId);
  const [buyerToken] = await findAssociatedTokenPda({ owner: buyer.address, mint: p.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const ix = await getCreateDealInstructionAsync({
    buyer, seller: p.listing.seller as Address, mint: p.mint, buyerToken, dealId: p.dealId, amount: p.listing.price, deadline: p.deadline,
    reviewSecs: FEE_REVIEW_SECS, resolveSecs: FEE_RESOLVE_SECS, toleranceBps: 0, stakeRequired: 0n, bondBps: 1_000, verifier: p.verifier,
    termsHash: hexToBytes(p.termsHash), listing: p.listing.address as Address, link: (await findLinkPda({ deal }))[0],
    registry: await registryAddress(), listingContentHash: hexToBytes(p.listing.contentHash),
  });
  return { deal, ix };
}

/** A random 64-bit deal id (collisions are refused by the library and the program anyway). */
export const randomDealId = () => new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);

export type FeeDealState = { deal: Address; buyer: Address; seller: Address; mint: Address; status: string; deliveryHash: string; listing: Address | null };

/**
 * Release pays the team for exactly the product hash the buyer was shown. Refused in code unless the hash the team
 * delivered on chain is that product's hash (the program checks it again).
 */
export async function releaseIx(buyer: TransactionSigner, d: FeeDealState, productHash: string): Promise<{ ok: true; ix: Instruction } | Refused> {
  if (d.status !== "Delivered") return { ok: false, reason: "NOT_DELIVERED", message: `the fee deal is ${d.status}` };
  if (!HEX32.test(productHash) || d.deliveryHash !== productHash) {
    return { ok: false, reason: "PRODUCT_MISMATCH", message: "what the team delivered on chain is not the final product shown here" };
  }
  const tok = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint: d.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  return {
    ok: true,
    ix: await getReleaseInstructionAsync({
      actor: buyer, deal: d.deal, policy: await policyAddress(d.buyer), mint: d.mint, buyerToken: await tok(d.buyer), sellerToken: await tok(d.seller),
      sellerRep: await sellerRepAddress(d.seller, d.mint), repPair: await repPairAddress(d.seller, d.buyer, d.mint), listing: d.listing ?? undefined,
      expectedDeliveryHash: hexToBytes(productHash),
    }),
  };
}

/** Challenge inside the review window: the buyer posts the bond and the deal's verifier rules. */
export async function challengeIx(buyer: TransactionSigner, d: FeeDealState): Promise<{ ok: true; ix: Instruction } | Refused> {
  if (d.status !== "Delivered") return { ok: false, reason: "NOT_DELIVERED", message: `the fee deal is ${d.status}` };
  const [buyerToken] = await findAssociatedTokenPda({ owner: d.buyer, mint: d.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { ok: true, ix: await getChallengeInstructionAsync({ buyer, deal: d.deal, mint: d.mint, buyerToken }) };
}
