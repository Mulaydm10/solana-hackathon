// The deal library: every deal action, written once, for every app (local server, Vercel site,
// MCP package). Each action takes a Kit client whose signer can be anything: a server keypair, a
// browser wallet or an agent's own keypair. Actions never throw for expected outcomes: they return
// { ok: true, signature } or { ok: false, reason, message }, with the program's own error names as
// reasons. Browser-safe: no Node built-ins.
import type { Address, GetAccountInfoApi, GetSignaturesForAddressApi, Instruction, Rpc, TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchMaybeDeal,
  fetchMaybeBuyerPolicy,
  fetchMaybeSellerRep,
  fetchMaybeDealLink,
  fetchMaybeListing,
  findLinkPda,
  fetchMaybeRepPair,
  getAcceptInstructionAsync,
  getCancelInstructionAsync,
  getChallengeInstructionAsync,
  getClaimInstructionAsync,
  getCreateDealInstructionAsync,
  getInitPolicyInstructionAsync,
  getRefundInstructionAsync,
  getReleaseInstructionAsync,
  getResolveInstructionAsync,
  getSubmitDeliveryInstructionAsync,
  getTimeoutRefundInstructionAsync,
  getUpdatePolicyInstructionAsync,
  type PolicyParamsArgs,
} from "./generated/index.ts";
import { dealAddress, policyAddress, programErrorName, registryAddress, repPairAddress, sellerRepAddress, STATUS_NAMES } from "./index.ts";
import { isRateLimited, isTransient } from "./retry.ts";

/** The parts of a Kit client the library needs. Any plugin client (RPC, LiteSVM, wallet) fits. */
export type DealClient = {
  rpc: Rpc<GetAccountInfoApi & GetSignaturesForAddressApi>;
  sendTransaction(instructions: Instruction[]): Promise<{ context: { signature: string } }>;
};

export type DealContext = {
  client: DealClient;
  /** The token the deals are paid in (e.g. devnet USDC). */
  mint: Address;
  /** How long to wait for a confirmation before reading the chain directly. Default 45 s. */
  confirmTimeoutMs?: number;
  /** Send attempts on rate limits / timeouts. Default 6. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** "Pubkey::default()": no verifier / no approver. */
export const NO_KEY = "11111111111111111111111111111111" as Address;

export type Refusal = { ok: false; reason: string; message: string };
export type Sent<T = object> = ({ ok: true; signature: string } & T) | Refusal;

export type DealView = {
  address: Address;
  buyer: Address;
  seller: Address;
  verifier: Address;
  status: string;
  amount: string;
  invoiceAmount: string;
  stakeRequired: string;
  stakePosted: string;
  bondPosted: string;
  toleranceBps: number;
  bondBps: number;
  deadline: number;
  reviewSecs: number;
  resolveSecs: number;
  createdAt: number;
  acceptedAt: number;
  deliveredAt: number;
  challengedAt: number;
  termsHash: string;
  deliveryHash: string;
};

export type PolicyView = {
  address: Address;
  buyer: Address;
  mint: Address;
  periodSecs: number;
  periodStart: number;
  periodBudget: string;
  periodSpent: string;
  maxPrice: string;
  approvalThreshold: string;
  approver: Address;
  allowAnySeller: boolean;
  allowedSellers: Address[];
};

/** On-chain seller reputation in one mint (counts only; scoring is core `repScore`). Amounts are decimal strings. */
export type SellerRepView = {
  address: Address;
  seller: Address;
  mint: Address;
  completed: number;
  failed: number;
  neutral: number;
  volume: string;
  distinctBuyers: number;
  maxPairVolume: string;
  lastSettledAt: number;
};

export type RepPairView = {
  address: Address;
  seller: Address;
  buyer: Address;
  mint: Address;
  completed: number;
  failed: number;
  volume: string;
};

export type OpenParams = {
  seller: Address;
  dealId: bigint;
  amount: bigint;
  /** Unix seconds. */
  deadline: bigint | number;
  reviewSecs: bigint | number;
  resolveSecs?: bigint | number;
  toleranceBps?: number;
  stakeRequired?: bigint;
  bondBps?: number;
  verifier?: Address;
  termsHash: Uint8Array;
  /** Required when the amount is above the buyer policy's approval threshold. */
  approver?: TransactionSigner;
  /** Open from this listing (must be active, attested by a registered assessor, same seller, mint and price). */
  listing?: Address;
  /** With a listing: the content hash the buyer was shown; refused if the listing changed since. */
  listingContentHash?: Uint8Array;
};

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message });

/** Turn a failed send into a refusal: program errors by name, everything else as CHAIN_ERROR. */
export function toRefusal(e: unknown): Refusal {
  const name = programErrorName(e);
  if (name) return refuse(name, `Solana program refused: ${name}`);
  if (isRateLimited(e)) return refuse("RATE_LIMITED", "The RPC rate-limited this request; try again shortly.");
  if (isTransient(e)) return refuse("RPC_UNAVAILABLE", "The RPC failed transiently; check the deal, then try again.");
  return refuse("CHAIN_ERROR", e instanceof Error ? e.message.slice(0, 300) : String(e));
}

/**
 * Send once, safely. A 429 can arrive after the transaction landed, and a confirmation can stall
 * even though the transaction is finalized. After either, `landed()` reads the chain: if the action
 * took effect we return its latest signature; otherwise we resend. A resend of something that did
 * land fails on chain and is caught by the same check, so nothing ever happens twice.
 */
export async function safeSend(
  ctx: DealContext,
  watch: Address,
  landed: () => Promise<boolean>,
  build: () => Promise<Instruction[]>,
): Promise<Sent> {
  const sleep = ctx.sleep ?? defaultSleep;
  const attempts = ctx.attempts ?? 6;
  const timeoutMs = ctx.confirmTimeoutMs ?? 45_000;
  let uncertain = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const sent = ctx.client.sendTransaction(await build());
      sent.catch(() => {}); // may be abandoned on timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("confirmation timed out"), { confirmTimeout: true })), timeoutMs);
      });
      try {
        const result = await Promise.race([sent, timeout]);
        return { ok: true, signature: String(result.context.signature) };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const timedOut = (e as { confirmTimeout?: boolean }).confirmTimeout === true;
      // Program errors are definitive; rate limits, network blips, 5xx and expired blockhashes are
      // not: the transaction may have landed, so the chain decides before any resend.
      const transient = timedOut || (programErrorName(e) === undefined && isTransient(e));
      if (transient) uncertain = true;
      // Any failure that is not the program's own refusal may have happened AFTER the transaction
      // was sent (e.g. the confirmation websocket failed), so the chain is asked before reporting.
      const programRefused = programErrorName(e) !== undefined;
      if (uncertain || !programRefused) {
        await sleep(1_500);
        if (await readWithRetry(ctx, landed)) return { ok: true, signature: await latestSignature(ctx, watch) };
      }
      if (!transient) return toRefusal(e); // unknown errors: reported, never resent
      if (attempt >= attempts) {
        return timedOut
          ? refuse("CONFIRMATION_TIMEOUT", "No confirmation and the chain does not show the action; check the deal before retrying.")
          : isRateLimited(e)
            ? refuse("RATE_LIMITED", "The RPC kept rate-limiting this request; try again shortly.")
            : refuse("RPC_UNAVAILABLE", "The RPC kept failing transiently and the chain does not show the action; try again shortly.");
      }
      await sleep(800 * 2 ** (attempt - 1));
    }
  }
}

/** Reads are idempotent: retry them on any transient failure. */
/** Reads retry on rate limits and transient RPC errors (shared by the market actions). */
export async function readWithRetry<T>(ctx: DealContext, read: () => Promise<T>): Promise<T> {
  const sleep = ctx.sleep ?? defaultSleep;
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (!isTransient(e) || i >= 6) throw e;
      await sleep(800 * 2 ** (i - 1));
    }
  }
}

async function latestSignature(ctx: DealContext, address: Address): Promise<string> {
  const [last] = await readWithRetry(ctx, () => ctx.client.rpc.getSignaturesForAddress(address, { limit: 1 }).send());
  return String(last?.signature ?? "landed");
}

/** The owner's token account for the context's mint. */
export async function ata(ctx: DealContext, owner: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
}

async function rawDeal(ctx: DealContext, deal: Address) {
  const d = await readWithRetry(ctx, () => fetchMaybeDeal(ctx.client.rpc, deal));
  return d.exists ? d.data : null;
}

/** Deal state as plain JSON (bigints as decimal strings), or null if there is no such deal. */
export async function getDeal(ctx: DealContext, deal: Address): Promise<DealView | null> {
  const d = await rawDeal(ctx, deal);
  if (!d) return null;
  return {
    address: deal, buyer: d.buyer, seller: d.seller, verifier: d.verifier, status: STATUS_NAMES[d.status] ?? `Unknown(${d.status})`,
    amount: d.amount.toString(), invoiceAmount: d.invoiceAmount.toString(), stakeRequired: d.stakeRequired.toString(),
    stakePosted: d.stakePosted.toString(), bondPosted: d.bondPosted.toString(), toleranceBps: d.toleranceBps, bondBps: d.bondBps,
    deadline: Number(d.deadline), reviewSecs: Number(d.reviewSecs), resolveSecs: Number(d.resolveSecs),
    createdAt: Number(d.createdAt), acceptedAt: Number(d.acceptedAt), deliveredAt: Number(d.deliveredAt),
    challengedAt: Number(d.challengedAt), termsHash: hex(d.termsHash), deliveryHash: hex(d.deliveryHash),
  };
}

export async function getPolicy(ctx: DealContext, buyer: Address): Promise<PolicyView | null> {
  const address = await policyAddress(buyer);
  const p = await readWithRetry(ctx, () => fetchMaybeBuyerPolicy(ctx.client.rpc, address));
  if (!p.exists) return null;
  const x = p.data;
  return {
    address, buyer: x.buyer, mint: x.mint, periodSecs: Number(x.periodSecs), periodStart: Number(x.periodStart),
    periodBudget: x.periodBudget.toString(), periodSpent: x.periodSpent.toString(), maxPrice: x.maxPrice.toString(),
    approvalThreshold: x.approvalThreshold.toString(), approver: x.approver, allowAnySeller: x.allowAnySeller,
    allowedSellers: [...x.allowedSellers],
  };
}

/** A seller's on-chain track record in the context's mint, as plain JSON; all zeros if none. */
export async function getSellerRep(ctx: DealContext, seller: Address): Promise<SellerRepView> {
  const address = await sellerRepAddress(seller, ctx.mint);
  const r = await readWithRetry(ctx, () => fetchMaybeSellerRep(ctx.client.rpc, address));
  const x = r.exists ? r.data : null;
  return {
    address, seller, mint: ctx.mint, completed: Number(x?.completed ?? 0), failed: Number(x?.failed ?? 0), neutral: Number(x?.neutral ?? 0),
    volume: (x?.volume ?? 0n).toString(), distinctBuyers: Number(x?.distinctBuyers ?? 0),
    maxPairVolume: (x?.maxPairVolume ?? 0n).toString(), lastSettledAt: Number(x?.lastSettledAt ?? 0),
  };
}

/** The history between one seller and one buyer; all zeros if they never dealt. */
export async function getRepPair(ctx: DealContext, seller: Address, buyer: Address): Promise<RepPairView> {
  const address = await repPairAddress(seller, buyer, ctx.mint);
  const r = await readWithRetry(ctx, () => fetchMaybeRepPair(ctx.client.rpc, address));
  const x = r.exists ? r.data : null;
  return {
    address, seller, buyer, mint: ctx.mint, completed: Number(x?.completed ?? 0), failed: Number(x?.failed ?? 0),
    volume: (x?.volume ?? 0n).toString(),
  };
}

const statusIs = (ctx: DealContext, deal: Address, ...names: string[]) => async () => {
  const d = await rawDeal(ctx, deal);
  return d !== null && names.includes(STATUS_NAMES[d.status] ?? "");
};

/**
 * Did *this* open land? With `want`: the deal at the PDA has exactly our seller, amount and terms hash (an id
 * collision with another deal is not success). With `null`: does any deal exist there yet.
 */
export async function isOurs(ctx: DealContext, deal: Address, want: { seller: Address; amount: bigint; termsHash: Uint8Array } | null): Promise<boolean> {
  const d = await rawDeal(ctx, deal);
  if (!d) return false;
  if (!want) return true;
  return d.seller === want.seller && d.amount === want.amount && d.termsHash.length === want.termsHash.length
    && d.termsHash.every((b, i) => b === want.termsHash[i]);
}

/** Accounts every payout instruction needs; payouts can only reach the deal's own parties. */
async function settleAccounts(ctx: DealContext, actor: TransactionSigner, deal: Address) {
  const d = await rawDeal(ctx, deal);
  if (!d) return null;
  // A deal opened from a listing passes that listing (if it still exists) so its sales count.
  const link = await readWithRetry(ctx, async () => fetchMaybeDealLink(ctx.client.rpc, (await findLinkPda({ deal }))[0]));
  const listing = link.exists && (await readWithRetry(ctx, () => fetchMaybeListing(ctx.client.rpc, link.data.listing))).exists
    ? link.data.listing : undefined;
  return {
    actor, deal, policy: await policyAddress(d.buyer), mint: ctx.mint, listing,
    buyerToken: await ata(ctx, d.buyer), sellerToken: await ata(ctx, d.seller),
    sellerRep: await sellerRepAddress(d.seller, d.mint), repPair: await repPairAddress(d.seller, d.buyer, d.mint),
  };
}

const NOT_FOUND = refuse("DEAL_NOT_FOUND", "No deal at that address.");

export const deals = {
  /** Buyer creates their spending policy (once). Deals can only be opened through it. */
  async initPolicy(ctx: DealContext, buyer: TransactionSigner, params: PolicyParamsArgs): Promise<Sent<{ policy: Address }>> {
    const policy = await policyAddress(buyer.address);
    const r = await safeSend(ctx, policy, async () => (await getPolicy(ctx, buyer.address)) !== null, async () => [
      await getInitPolicyInstructionAsync({ buyer, mint: ctx.mint, params }),
    ]);
    return r.ok ? { ...r, policy } : r;
  },

  async updatePolicy(ctx: DealContext, buyer: TransactionSigner, params: PolicyParamsArgs): Promise<Sent> {
    const policy = await policyAddress(buyer.address);
    // An update is idempotent (same params twice = same state), so landed() = "not applicable".
    return safeSend(ctx, policy, async () => false, async () => [await getUpdatePolicyInstructionAsync({ buyer, policy, params })]);
  },

  /** Buyer opens a deal; the order amount moves into escrow. Checked against the buyer's policy. */
  async open(ctx: DealContext, buyer: TransactionSigner, p: OpenParams): Promise<Sent<{ deal: Address }>> {
    const deal = await dealAddress(buyer.address, p.dealId);
    // Pre-existing deal at this id (an id collision, or someone else's earlier deal): refuse instead of
    // letting `landed` mistake it for ours.
    if (await isOurs(ctx, deal, null)) {
      return refuse("DEAL_ID_TAKEN", "A deal with this id already exists; choose another id.");
    }
    const r = await safeSend(ctx, deal, async () => isOurs(ctx, deal, { seller: p.seller, amount: p.amount, termsHash: p.termsHash }), async () => [
      await getCreateDealInstructionAsync({
        buyer, seller: p.seller, approver: p.approver, mint: ctx.mint, buyerToken: await ata(ctx, buyer.address),
        dealId: p.dealId, amount: p.amount, deadline: BigInt(p.deadline), reviewSecs: BigInt(p.reviewSecs),
        resolveSecs: BigInt(p.resolveSecs ?? 600), toleranceBps: p.toleranceBps ?? 0, stakeRequired: p.stakeRequired ?? 0n,
        bondBps: p.bondBps ?? 0, verifier: p.verifier ?? NO_KEY, termsHash: p.termsHash,
        listing: p.listing, link: p.listing ? (await findLinkPda({ deal }))[0] : undefined,
        registry: p.listing ? await registryAddress() : undefined, listingContentHash: p.listingContentHash ?? new Uint8Array(32),
      }),
    ]);
    return r.ok ? { ...r, deal } : r;
  },

  /** Seller accepts the terms and posts the stake. */
  async accept(ctx: DealContext, seller: TransactionSigner, deal: Address): Promise<Sent> {
    return safeSend(ctx, deal, statusIs(ctx, deal, "Funded", "Delivered", "Challenged", "Released", "Claimed", "VerifiedPass", "VerifiedFail", "NoVerdict"), async () => [
      await getAcceptInstructionAsync({ seller, deal, mint: ctx.mint, sellerToken: await ata(ctx, seller.address) }),
    ]);
  },

  /** Seller records the delivery hash and the invoice (must be within the order ± tolerance). */
  async deliver(ctx: DealContext, seller: TransactionSigner, deal: Address, deliveryHash: Uint8Array, invoiceAmount: bigint): Promise<Sent> {
    return safeSend(ctx, deal, statusIs(ctx, deal, "Delivered", "Challenged", "Released", "Claimed", "VerifiedPass", "VerifiedFail", "NoVerdict"), async () => [
      await getSubmitDeliveryInstructionAsync({ seller, deal, deliveryHash, invoiceAmount }),
    ]);
  },

  /** Buyer approves exactly the delivery it names. */
  async release(ctx: DealContext, buyer: TransactionSigner, deal: Address, expectedDeliveryHash: Uint8Array): Promise<Sent> {
    const acc = await settleAccounts(ctx, buyer, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, "Released"), async () => [await getReleaseInstructionAsync({ ...acc, expectedDeliveryHash })]);
  },

  /** Anyone, after the review window with no challenge: pays the seller. */
  async claim(ctx: DealContext, actor: TransactionSigner, deal: Address): Promise<Sent> {
    const acc = await settleAccounts(ctx, actor, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, "Claimed"), async () => [await getClaimInstructionAsync(acc)]);
  },

  /** Buyer disputes inside the review window, posting the bond. */
  async challenge(ctx: DealContext, buyer: TransactionSigner, deal: Address): Promise<Sent> {
    return safeSend(ctx, deal, statusIs(ctx, deal, "Challenged", "VerifiedPass", "VerifiedFail", "NoVerdict"), async () => [
      await getChallengeInstructionAsync({ buyer, deal, mint: ctx.mint, buyerToken: await ata(ctx, buyer.address) }),
    ]);
  },

  /** The deal's verifier decides a challenge. */
  async resolve(ctx: DealContext, verifier: TransactionSigner, deal: Address, deliveryOk: boolean): Promise<Sent> {
    const acc = await settleAccounts(ctx, verifier, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, deliveryOk ? "VerifiedPass" : "VerifiedFail"), async () => [
      await getResolveInstructionAsync({ ...acc, deliveryOk }),
    ]);
  },

  /** Anyone, after the resolve window with no verdict: refunds the buyer, returns the stake. */
  async timeoutRefund(ctx: DealContext, actor: TransactionSigner, deal: Address): Promise<Sent> {
    const acc = await settleAccounts(ctx, actor, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, "NoVerdict"), async () => [await getTimeoutRefundInstructionAsync(acc)]);
  },

  /** Anyone, after a missed deadline: refunds the buyer (and slashes an accepted seller's stake). */
  async refund(ctx: DealContext, actor: TransactionSigner, deal: Address): Promise<Sent> {
    const acc = await settleAccounts(ctx, actor, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, "Refunded"), async () => [await getRefundInstructionAsync(acc)]);
  },

  /** Buyer withdraws an offer the seller has not accepted. */
  async cancel(ctx: DealContext, buyer: TransactionSigner, deal: Address): Promise<Sent> {
    const acc = await settleAccounts(ctx, buyer, deal);
    if (!acc) return NOT_FOUND;
    return safeSend(ctx, deal, statusIs(ctx, deal, "Cancelled"), async () => [await getCancelInstructionAsync(acc)]);
  },
};
