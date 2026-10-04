// Market actions (deal_escrow v3): listings and missions with agent mandates, written once for every
// app, with the same rules as the deal actions in deals.ts. Every action goes through safeSend, so an
// uncertain send is settled by reading the chain, never by sending twice; each `landed` check names
// the exact state the action produces. Results, never throws. Browser-safe: no Node built-ins.
import type { Address, TransactionSigner } from "@solana/kit";
import { getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ListingKind,
  fetchMaybeDeal,
  fetchMaybeDealLink,
  fetchMaybeListing,
  fetchMaybeMandate,
  fetchMaybeMission,
  findLinkPda,
  findListingPda,
  findMandatePda,
  findMissionAuthPda,
  findMissionPda,
  getAddMandateInstruction,
  getAgentChallengeInstructionAsync,
  getAgentOpenDealInstructionAsync,
  getAgentReleaseInstructionAsync,
  getAgentSpendInstructionAsync,
  getApproveStageInstructionAsync,
  getAttestListingInstruction,
  getCloseListingInstruction,
  getCloseMissionInstructionAsync,
  getCreateListingInstructionAsync,
  getCreateMissionInstructionAsync,
  getRevokeMandateInstruction,
  getUpdateListingInstruction,
} from "./generated/index.ts";
import { ata, isOurs, NO_KEY, readWithRetry, refuse, safeSend, type DealContext, type OpenParams, type Sent } from "./deals.ts";
import { dealAddress, policyAddress, registryAddress, repPairAddress, sellerRepAddress, STATUS_NAMES } from "./index.ts";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const KIND_NAMES = ["Data", "Service", "Team"] as const;
export type ListingKindName = (typeof KIND_NAMES)[number];
const kindOf = (k: ListingKindName): ListingKind => ListingKind[k];

// ---------------------------------------------------------------- listings

export type ListingInput = {
  listingId: bigint;
  kind: ListingKindName;
  /** Token base units; per call for a Service. */
  price: bigint;
  contentHash: Uint8Array;
  metaHash: Uint8Array;
  termsTemplateHash?: Uint8Array;
  /** Must not be the seller. */
  assessor: Address;
};

export type ListingView = {
  address: Address;
  seller: Address;
  listingId: string;
  kind: ListingKindName;
  mint: Address;
  price: string;
  contentHash: string;
  metaHash: string;
  termsTemplateHash: string;
  assessor: Address;
  reportHash: string;
  /** 0 = not attested (or attestation cleared by a content change). */
  assessedAt: number;
  active: boolean;
  sales: number;
  createdAt: number;
};

export async function listingAddress(seller: Address, listingId: bigint): Promise<Address> {
  return (await findListingPda({ seller, listingId }))[0];
}

async function rawListing(ctx: DealContext, listing: Address) {
  const l = await readWithRetry(ctx, () => fetchMaybeListing(ctx.client.rpc, listing));
  return l.exists ? l.data : null;
}

export async function getListing(ctx: DealContext, listing: Address): Promise<ListingView | null> {
  const x = await rawListing(ctx, listing);
  if (!x) return null;
  return {
    address: listing, seller: x.seller, listingId: x.listingId.toString(), kind: KIND_NAMES[x.kind]!, mint: x.mint,
    price: x.price.toString(), contentHash: hex(x.contentHash), metaHash: hex(x.metaHash), termsTemplateHash: hex(x.termsTemplateHash),
    assessor: x.assessor, reportHash: hex(x.reportHash), assessedAt: Number(x.assessedAt), active: x.active,
    sales: Number(x.sales), createdAt: Number(x.createdAt),
  };
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

export const listings = {
  /** Seller lists data, a service or a team blueprint. Starts unattested. */
  async create(ctx: DealContext, seller: TransactionSigner, p: ListingInput): Promise<Sent<{ listing: Address }>> {
    const listing = await listingAddress(seller.address, p.listingId);
    const r = await safeSend(ctx, listing, async () => (await rawListing(ctx, listing)) !== null, async () => [
      await getCreateListingInstructionAsync({
        seller, mint: ctx.mint, listingId: p.listingId, kind: kindOf(p.kind), price: p.price, contentHash: p.contentHash,
        metaHash: p.metaHash, termsTemplateHash: p.termsTemplateHash ?? new Uint8Array(32), assessor: p.assessor,
      }),
    ]);
    return r.ok ? { ...r, listing } : r;
  },

  /** The listing's assessor attests a report for exactly the content it assessed. */
  async attest(ctx: DealContext, assessor: TransactionSigner, listing: Address, contentHash: Uint8Array, reportHash: Uint8Array): Promise<Sent> {
    return safeSend(ctx, listing, async () => {
      const l = await rawListing(ctx, listing);
      return l !== null && l.assessedAt !== 0n && same(l.reportHash, reportHash) && same(l.contentHash, contentHash);
    }, async () => [getAttestListingInstruction({ assessor, listing, contentHash, reportHash, registry: await registryAddress() })]);
  },

  /** Price and availability keep the attestation; new content or metadata clears it. */
  async update(
    ctx: DealContext, seller: TransactionSigner, listing: Address,
    u: { price?: bigint; active?: boolean; contentHash?: Uint8Array; metaHash?: Uint8Array },
  ): Promise<Sent> {
    return safeSend(ctx, listing, async () => {
      const l = await rawListing(ctx, listing);
      return l !== null && (u.price === undefined || l.price === u.price) && (u.active === undefined || l.active === u.active)
        && (u.contentHash === undefined || same(l.contentHash, u.contentHash)) && (u.metaHash === undefined || same(l.metaHash, u.metaHash));
    }, async () => [
      getUpdateListingInstruction({
        seller, listing, price: u.price ?? null, active: u.active ?? null, contentHash: u.contentHash ?? null, metaHash: u.metaHash ?? null,
      }),
    ]);
  },

  /** Seller removes the listing (rent back). Open deals keep working. */
  async close(ctx: DealContext, seller: TransactionSigner, listing: Address): Promise<Sent> {
    return safeSend(ctx, listing, async () => (await rawListing(ctx, listing)) === null, async () => [getCloseListingInstruction({ seller, listing })]);
  },
};

// ---------------------------------------------------------------- missions

export type MandateInput = {
  agent: Address;
  roleHash: Uint8Array;
  cap: bigint;
  perTxCap: bigint;
  /** Empty = only sellers of attested listings. */
  payees: Address[];
  /** Bit i = may spend in stage i. */
  stageMask: number;
  /** Unix seconds; at most the mission's expiry. */
  expiresAt: bigint | number;
};

export type MissionInput = {
  missionId: bigint;
  budget: bigint;
  termsHash: Uint8Array;
  teamListing?: Address;
  stageCaps: bigint[];
  expiresAt: bigint | number;
  /** SOL (lamports) for the rent of deals the agents open. */
  rentLamports?: bigint;
  approver?: TransactionSigner;
  /** The verifier every agent deal must name (not the buyer). */
  verifier: Address;
  /** Floors for agents' deals; defaults 600 s, 600 s, 5% tolerance, 10% max bond, 0% min stake. */
  minReviewSecs?: bigint;
  minResolveSecs?: bigint;
  maxToleranceBps?: number;
  maxBondBps?: number;
  minStakeBps?: number;
};

export type MissionAccounts = { mission: Address; auth: Address; authPolicy: Address; vault: Address };

export type MissionView = MissionAccounts & {
  buyer: Address;
  budget: string;
  spent: string;
  vaultBalance: string;
  mandateCount: number;
  mandatesDigest: string;
  mandatesLocked: boolean;
  stages: { cap: string; spent: string; planHash: string; approvedAt: number }[];
  currentStage: number;
  expiresAt: number;
  closed: boolean;
};

export type MandateView = {
  address: Address;
  mission: Address;
  agent: Address;
  roleHash: string;
  cap: string;
  perTxCap: string;
  spent: string;
  payees: Address[];
  stageMask: number;
  expiresAt: number;
  revoked: boolean;
};

const enc = getAddressEncoder();
const le64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
};

/**
 * The program's running digest over a mission's mandates, in the order they were added. A UI
 * computes it from the mandates it showed the human and passes it to `approveStage`; the program
 * refuses the approval if the mandate set on chain is different (MandatesChanged).
 */
export function mandatesDigest(mandates: readonly MandateInput[]): Uint8Array {
  let d = new Uint8Array(32);
  for (const m of mandates) {
    const parts = [
      d, enc.encode(m.agent), m.roleHash, Uint8Array.of(m.stageMask), le64(m.cap), le64(m.perTxCap), le64(BigInt(m.expiresAt)),
      ...m.payees.map((p) => enc.encode(p)),
    ];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    d = sha256(all);
  }
  return d;
}

export async function missionAccounts(ctx: DealContext, buyer: Address, missionId: bigint): Promise<MissionAccounts> {
  const [mission] = await findMissionPda({ buyer, missionId });
  const [auth] = await findMissionAuthPda({ mission });
  return { mission, auth, authPolicy: await policyAddress(auth), vault: await ata(ctx, auth) };
}

async function rawMission(ctx: DealContext, mission: Address) {
  const m = await readWithRetry(ctx, () => fetchMaybeMission(ctx.client.rpc, mission));
  return m.exists ? m.data : null;
}

async function rawMandate(ctx: DealContext, mission: Address, agent: Address) {
  const [address] = await findMandatePda({ mission, agent });
  const m = await readWithRetry(ctx, () => fetchMaybeMandate(ctx.client.rpc, address));
  return { address, data: m.exists ? m.data : null };
}

async function tokenBalance(ctx: DealContext, account: Address): Promise<bigint> {
  const info = await readWithRetry(ctx, () => ctx.client.rpc.getAccountInfo(account, { encoding: "base64" }).send());
  const data = info.value?.data?.[0];
  if (!data) return 0n;
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new DataView(bytes.buffer).getBigUint64(64, true); // SPL token account: amount at offset 64
}

export async function getMission(ctx: DealContext, mission: Address): Promise<MissionView | null> {
  const m = await rawMission(ctx, mission);
  if (!m) return null;
  const [auth] = await findMissionAuthPda({ mission });
  const vault = await ata(ctx, auth);
  return {
    mission, auth, authPolicy: await policyAddress(auth), vault, buyer: m.buyer, budget: m.budget.toString(), spent: m.spent.toString(),
    vaultBalance: (await tokenBalance(ctx, vault)).toString(), mandateCount: m.mandateCount, mandatesDigest: hex(m.mandatesDigest),
    mandatesLocked: m.mandatesLocked,
    stages: m.stages.map((s) => ({ cap: s.cap.toString(), spent: s.spent.toString(), planHash: hex(s.planHash), approvedAt: Number(s.approvedAt) })),
    currentStage: m.currentStage, expiresAt: Number(m.expiresAt), closed: m.closed,
  };
}

export async function getMandate(ctx: DealContext, mission: Address, agent: Address): Promise<MandateView | null> {
  const { address, data: x } = await rawMandate(ctx, mission, agent);
  if (!x) return null;
  return {
    address, mission: x.mission, agent: x.agent, roleHash: hex(x.roleHash), cap: x.cap.toString(), perTxCap: x.perTxCap.toString(),
    spent: x.spent.toString(), payees: [...x.payees], stageMask: x.stageMask, expiresAt: Number(x.expiresAt), revoked: x.revoked,
  };
}

const MISSION_NOT_FOUND = refuse("MISSION_NOT_FOUND", "No mission at that address.");

/** The deal's own accounts as an agent's settle/challenge needs them. */
async function missionDealAccounts(ctx: DealContext, auth: Address, deal: Address) {
  const d = await readWithRetry(ctx, () => fetchMaybeDeal(ctx.client.rpc, deal));
  if (!d.exists) return null;
  const [link] = await findLinkPda({ deal });
  const linked = await readWithRetry(ctx, () => fetchMaybeDealLink(ctx.client.rpc, link));
  const l = linked.exists ? linked.data.listing : null;
  const listing = l && (await rawListing(ctx, l)) !== null ? l : undefined;
  return {
    deal: d.data,
    accounts: {
      deal, authPolicy: await policyAddress(auth), mint: ctx.mint,
      dealVault: (await findAssociatedTokenPda({ owner: deal, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
      sellerToken: await ata(ctx, d.data.seller), sellerRep: await sellerRepAddress(d.data.seller, ctx.mint),
      repPair: await repPairAddress(d.data.seller, auth, ctx.mint), link, listing,
    },
  };
}

/** The actor's mandate account if it has one (an agent); undefined for the buyer. */
async function actorMandate(ctx: DealContext, mission: Address, actor: Address): Promise<Address | undefined> {
  const m = await rawMandate(ctx, mission, actor);
  return m.data ? m.address : undefined;
}

/** Runs `fn` after every earlier call with the same key has finished (an in-process mutex per key). */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function spendOnce(
  ctx: DealContext, agent: TransactionSigner, mission: Address, payee: Address, amount: bigint, receiptHash: Uint8Array, listing?: Address,
): Promise<Sent> {
  const before = (await rawMandate(ctx, mission, agent.address)).data;
  if (!before) return refuse("MANDATE_NOT_FOUND", "This agent has no mandate on that mission.");
  return safeSend(ctx, mission, async () => {
    const now = (await rawMandate(ctx, mission, agent.address)).data;
    return now !== null && now.spent >= before.spent + amount;
  }, async () => [
    await getAgentSpendInstructionAsync({
      agent, mission, mint: ctx.mint, payeeToken: await ata(ctx, payee), listing, amount, receiptHash,
      registry: listing ? await registryAddress() : undefined,
    }),
  ]);
}

const statusOf = async (ctx: DealContext, deal: Address) => {
  const d = await readWithRetry(ctx, () => fetchMaybeDeal(ctx.client.rpc, deal));
  return d.exists ? STATUS_NAMES[d.data.status] ?? "" : null;
};

export const missions = {
  /** Buyer funds a mission (budget into the mission vault, charged to the buyer's policy). */
  async create(ctx: DealContext, buyer: TransactionSigner, p: MissionInput): Promise<Sent<MissionAccounts>> {
    const acc = await missionAccounts(ctx, buyer.address, p.missionId);
    const r = await safeSend(ctx, acc.mission, async () => (await rawMission(ctx, acc.mission)) !== null, async () => [
      await getCreateMissionInstructionAsync({
        buyer, approver: p.approver, mint: ctx.mint, buyerToken: await ata(ctx, buyer.address), missionId: p.missionId,
        budget: p.budget, termsHash: p.termsHash, teamListing: p.teamListing ?? NO_KEY, stageCaps: p.stageCaps,
        expiresAt: BigInt(p.expiresAt), rentLamports: p.rentLamports ?? 0n, verifier: p.verifier,
        minReviewSecs: p.minReviewSecs ?? 600n, minResolveSecs: p.minResolveSecs ?? 600n, maxToleranceBps: p.maxToleranceBps ?? 500,
        maxBondBps: p.maxBondBps ?? 1000, minStakeBps: p.minStakeBps ?? 0,
      }),
    ]);
    return r.ok ? { ...r, ...acc } : r;
  },

  /** Buyer gives one agent a mandate (only before the first stage is approved). */
  async addMandate(ctx: DealContext, buyer: TransactionSigner, mission: Address, m: MandateInput): Promise<Sent<{ mandate: Address }>> {
    const [mandate] = await findMandatePda({ mission, agent: m.agent });
    const r = await safeSend(ctx, mandate, async () => (await rawMandate(ctx, mission, m.agent)).data !== null, async () => [
      getAddMandateInstruction({
        buyer, mission, mandate, agent: m.agent, roleHash: m.roleHash, cap: m.cap, perTxCap: m.perTxCap, payees: m.payees,
        stageMask: m.stageMask, expiresAt: BigInt(m.expiresAt),
      }),
    ]);
    return r.ok ? { ...r, mandate } : r;
  },

  /** The human gate: approve a stage's plan, naming the mandate set the human was shown. */
  async approveStage(
    ctx: DealContext, buyer: TransactionSigner, mission: Address, stage: number, planHash: Uint8Array, digest: Uint8Array,
    approver?: TransactionSigner,
  ): Promise<Sent> {
    return safeSend(ctx, mission, async () => {
      const m = await rawMission(ctx, mission);
      const s = m?.stages[stage];
      return !!s && s.approvedAt !== 0n && same(s.planHash, planHash);
    }, async () => [await getApproveStageInstructionAsync({ buyer, approver, mission, stage, planHash, mandatesDigest: digest })]);
  },

  /**
   * An agent pays an allowed payee from the mission vault. Not idempotent on chain, so `landed`
   * compares the mandate's spent counter with the value read before sending.
   */
  async spend(
    ctx: DealContext, agent: TransactionSigner, mission: Address, payee: Address, amount: bigint, receiptHash: Uint8Array, listing?: Address,
  ): Promise<Sent> {
    // One spend at a time per mandate in this process, so `landed` (spent grew by `amount` since our read)
    // can never be satisfied by a different concurrent payment.
    return serialized(`${mission}:${agent.address}`, () => spendOnce(ctx, agent, mission, payee, amount, receiptHash, listing));
  },

  /** An agent buys under escrow: a normal deal with the mission's authority as the buyer. */
  async openDeal(
    ctx: DealContext, agent: TransactionSigner, mission: Address, p: Omit<OpenParams, "approver" | "reviewSecs"> & { reviewSecs?: bigint | number },
    receiptHash: Uint8Array,
  ): Promise<Sent<{ deal: Address }>> {
    const [auth] = await findMissionAuthPda({ mission });
    // Unset terms default to the mission's own rules, so the easy call is the allowed one.
    const m = await rawMission(ctx, mission);
    if (!m) return MISSION_NOT_FOUND;
    p = {
      ...p,
      verifier: p.verifier ?? m.verifier,
      reviewSecs: p.reviewSecs ?? m.minReviewSecs,
      resolveSecs: p.resolveSecs ?? m.minResolveSecs,
      toleranceBps: p.toleranceBps ?? m.maxToleranceBps,
      bondBps: p.bondBps ?? m.maxBondBps,
      stakeRequired: p.stakeRequired ?? (p.amount * BigInt(m.minStakeBps) + 9_999n) / 10_000n,
    };
    const deal = await dealAddress(auth, p.dealId);
    if (await isOurs(ctx, deal, null)) return refuse("DEAL_ID_TAKEN", "A deal with this id already exists; choose another id.");
    const r = await safeSend(ctx, deal, async () => isOurs(ctx, deal, { seller: p.seller, amount: p.amount, termsHash: p.termsHash }), async () => [
      await getAgentOpenDealInstructionAsync({
        agent, mission, seller: p.seller, authPolicy: await policyAddress(auth), mint: ctx.mint, deal,
        dealVault: (await findAssociatedTokenPda({ owner: deal, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
        sellerRep: await sellerRepAddress(p.seller, ctx.mint), repPair: await repPairAddress(p.seller, auth, ctx.mint),
        listing: p.listing, link: p.listing ? (await findLinkPda({ deal }))[0] : undefined,
        registry: p.listing ? await registryAddress() : undefined, listingContentHash: p.listingContentHash ?? new Uint8Array(32),
        dealId: p.dealId, amount: p.amount, deadline: BigInt(p.deadline), reviewSecs: BigInt(p.reviewSecs!),
        resolveSecs: BigInt(p.resolveSecs ?? 600), toleranceBps: p.toleranceBps ?? 0, stakeRequired: p.stakeRequired ?? 0n,
        bondBps: p.bondBps ?? 0, verifier: p.verifier ?? NO_KEY, termsHash: p.termsHash, receiptHash,
      }),
    ]);
    return r.ok ? { ...r, deal } : r;
  },

  /** An agent with a live mandate releases one of the mission's deals. */
  /** Releases one of the mission's deals: the buyer at any time, or the agent that opened it. */
  async release(ctx: DealContext, actor: TransactionSigner, mission: Address, deal: Address, expectedDeliveryHash: Uint8Array): Promise<Sent> {
    const [auth] = await findMissionAuthPda({ mission });
    const x = await missionDealAccounts(ctx, auth, deal);
    if (!x) return refuse("DEAL_NOT_FOUND", "No deal at that address.");
    const mandate = await actorMandate(ctx, mission, actor.address);
    return safeSend(ctx, deal, async () => (await statusOf(ctx, deal)) === "Released", async () => [
      await getAgentReleaseInstructionAsync({ agent: actor, mission, mandate, ...x.accounts, expectedDeliveryHash }),
    ]);
  },

  /** Challenges one of the mission's deals: the buyer at any time, or the agent that opened it. The bond counts as spend. */
  async challenge(ctx: DealContext, actor: TransactionSigner, mission: Address, deal: Address): Promise<Sent> {
    const [auth] = await findMissionAuthPda({ mission });
    const x = await missionDealAccounts(ctx, auth, deal);
    if (!x) return refuse("DEAL_NOT_FOUND", "No deal at that address.");
    const mandate = await actorMandate(ctx, mission, actor.address);
    return safeSend(ctx, deal, async () => ["Challenged", "VerifiedPass", "VerifiedFail", "NoVerdict"].includes((await statusOf(ctx, deal)) ?? ""), async () => [
      await getAgentChallengeInstructionAsync({ agent: actor, mission, mandate, deal, mint: ctx.mint, dealVault: x.accounts.dealVault }),
    ]);
  },

  /** Buyer revokes one agent in one transaction. */
  async revoke(ctx: DealContext, buyer: TransactionSigner, mission: Address, agent: Address): Promise<Sent> {
    const [mandate] = await findMandatePda({ mission, agent });
    return safeSend(ctx, mandate, async () => (await rawMandate(ctx, mission, agent)).data?.revoked === true, async () => [
      getRevokeMandateInstruction({ buyer, mission, mandate }),
    ]);
  },

  /** Buyer any time, anyone after expiry: everything left goes back to the buyer. Safe to repeat. */
  async close(ctx: DealContext, actor: TransactionSigner, mission: Address): Promise<Sent> {
    const m = await rawMission(ctx, mission);
    if (!m) return MISSION_NOT_FOUND;
    const [auth] = await findMissionAuthPda({ mission });
    const vault = await ata(ctx, auth);
    return safeSend(ctx, mission, async () => (await rawMission(ctx, mission))?.closed === true && (await tokenBalance(ctx, vault)) === 0n, async () => [
      await getCloseMissionInstructionAsync({
        actor, mission, buyer: m.buyer, policy: await policyAddress(m.buyer), mint: ctx.mint, buyerToken: await ata(ctx, m.buyer),
      }),
    ]);
  },
};
