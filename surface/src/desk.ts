// The deal desk for the local demo server: holds the devnet demo keys (buyer, sellers, verifier,
// approver) and runs every action through the shared deal library (@deal/chain deals), which owns
// the safe-send logic. Results are the library's { ok, signature } | { ok: false, reason, message }.
// The program, not this code, enforces every rule.
import { createClient, type Address, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { fetchMaybeToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS,
  deals,
  getDeal,
  getPolicy,
  type DealClient,
  type DealContext,
  type DealView,
  type PolicyView,
  type Sent,
} from "@deal/chain";
import type { DeskConfig } from "./keys.ts";
import { loadSigner } from "./keys.ts";

export type LockInput = {
  dealId: bigint;
  seller: Address;
  price: bigint;
  deadline: number;
  reviewSecs: number;
  termsHash: Uint8Array;
  stake: bigint;
  bondBps: number;
  toleranceBps: number;
  resolveSecs: number;
};

export type DeskStatus = {
  program: Address;
  programDeployed: boolean;
  buyerSol: number;
  buyerTokens: string;
  mint: Address;
  sellers: number;
  verifier: Address;
  policy: PolicyView | null;
};

/** What the HTTP layer needs; tests pass a fake. */
export interface Desk {
  buyer: Address;
  verifier: Address;
  sellerFor(serviceId: string): Address | undefined;
  lock(input: LockInput): Promise<Sent<{ deal: Address }>>;
  accept(deal: Address): Promise<Sent>;
  deliver(deal: Address, deliveryHash: Uint8Array, invoice: bigint): Promise<Sent>;
  release(deal: Address, deliveryHash: Uint8Array): Promise<Sent>;
  challenge(deal: Address): Promise<Sent>;
  resolve(deal: Address, deliveryOk: boolean): Promise<Sent>;
  timeoutRefund(deal: Address): Promise<Sent>;
  refund(deal: Address): Promise<Sent>;
  claim(deal: Address): Promise<Sent>;
  cancel(deal: Address): Promise<Sent>;
  get(deal: Address): Promise<DealView | null>;
  status(): Promise<DeskStatus>;
}

const NOT_DEMO = (deal: Address): Sent => ({ ok: false, reason: "UNKNOWN_SELLER", message: `No demo key for the seller of ${deal}.` });

export async function createDesk(cfg: DeskConfig): Promise<Desk> {
  const buyer = await loadSigner(cfg.buyerKeyPath);
  const verifier = await loadSigner(cfg.verifierKeyPath);
  const approver = await loadSigner(cfg.approverKeyPath);
  const client = createClient().use(signerPlugin(buyer)).use(solanaRpc({ rpcUrl: cfg.rpcUrl }));
  // 20 s: a stalled websocket confirmation is resolved from chain state sooner (seen on devnet and locally).
  const ctx: DealContext = { client: client as unknown as DealClient, mint: cfg.mint as Address, confirmTimeoutMs: 20_000 };
  const sellers = new Map<string, KeyPairSigner>(); // serviceId -> signer
  for (const [serviceId, path] of Object.entries(cfg.sellers)) sellers.set(serviceId, await loadSigner(path));
  const byAddress = new Map([...sellers.values()].map((s) => [s.address as string, s]));
  const sellerOf = async (deal: Address) => {
    const d = await getDeal(ctx, deal);
    return d ? byAddress.get(d.seller) : undefined;
  };
  const policyThreshold = async () => BigInt((await getPolicy(ctx, buyer.address))?.approvalThreshold ?? "0");

  return {
    buyer: buyer.address,
    verifier: verifier.address,
    sellerFor: (serviceId) => sellers.get(serviceId)?.address,
    async lock(p) {
      // Above the policy's threshold the approver co-signs (a manager's approval in a real company).
      const needsApproval = p.price > (await policyThreshold());
      return deals.open(ctx, buyer, {
        seller: p.seller, dealId: p.dealId, amount: p.price, deadline: p.deadline, reviewSecs: p.reviewSecs,
        resolveSecs: p.resolveSecs, toleranceBps: p.toleranceBps, stakeRequired: p.stake, bondBps: p.bondBps,
        verifier: verifier.address, termsHash: p.termsHash, approver: needsApproval ? approver : undefined,
      });
    },
    async accept(deal) {
      const s = await sellerOf(deal);
      return s ? deals.accept(ctx, s, deal) : NOT_DEMO(deal);
    },
    async deliver(deal, hash, invoice) {
      const s = await sellerOf(deal);
      return s ? deals.deliver(ctx, s, deal, hash, invoice) : NOT_DEMO(deal);
    },
    release: (deal, hash) => deals.release(ctx, buyer, deal, hash),
    challenge: (deal) => deals.challenge(ctx, buyer, deal),
    resolve: (deal, ok) => deals.resolve(ctx, verifier, deal, ok),
    timeoutRefund: (deal) => deals.timeoutRefund(ctx, buyer, deal),
    refund: (deal) => deals.refund(ctx, buyer, deal),
    claim: (deal) => deals.claim(ctx, buyer, deal),
    cancel: (deal) => deals.cancel(ctx, buyer, deal),
    get: (deal) => getDeal(ctx, deal),
    async status() {
      const [program, sol, token, policy] = await Promise.all([
        client.rpc.getAccountInfo(DEAL_ESCROW_PROGRAM_ADDRESS, { encoding: "base64" }).send(),
        client.rpc.getBalance(buyer.address).send(),
        findAssociatedTokenPda({ owner: buyer.address, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }).then(([a]) => fetchMaybeToken(client.rpc, a)),
        getPolicy(ctx, buyer.address),
      ]);
      return {
        program: DEAL_ESCROW_PROGRAM_ADDRESS, programDeployed: Boolean(program.value?.executable),
        buyerSol: Number(sol.value) / 1e9, buyerTokens: token.exists ? token.data.amount.toString() : "0",
        mint: ctx.mint, sellers: sellers.size, verifier: verifier.address, policy,
      };
    },
  };
}
