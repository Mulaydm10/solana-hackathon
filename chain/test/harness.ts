// Shared LiteSVM harness: one in-process chain with the compiled program, a test mint, and the
// parties of a deal. Tests and the attack search both drive the program only through this.
import assert from "node:assert/strict";
import { createClient, generateKeyPairSigner, lamports, type Address, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS,
  PROGRAM_ERRORS,
  PROGRAM_SO,
  dealAddress,
  fetchDeal,
  fetchMaybeDeal,
  getAcceptInstructionAsync,
  getCancelInstructionAsync,
  getChallengeInstructionAsync,
  getClaimInstructionAsync,
  getCreateDealInstructionAsync,
  getInitPolicyInstructionAsync,
  getRefundInstructionAsync,
  getReleaseInstructionAsync,
  getResolveInstructionAsync,
  getSubmitDeliveryInstruction,
  getTimeoutRefundInstructionAsync,
  getUpdatePolicyInstructionAsync,
  policyAddress,
  type PolicyParamsArgs,
} from "../src/index.ts";

export const USDC = 1_000_000n;
export const HOUR = 3600n;
/** Pubkey::default(): "no verifier" / "no approver". */
export const NONE = "11111111111111111111111111111111" as Address;
export const hash = (n: number) => new Uint8Array(32).fill(n);

export type DealOpts = {
  amount?: bigint;
  deadline?: bigint;
  reviewSecs?: bigint;
  resolveSecs?: bigint;
  toleranceBps?: number;
  stakeRequired?: bigint;
  bondBps?: number;
  verifier?: Address;
  seller?: Address;
  approver?: TransactionSigner;
};

/** Custom program error code anywhere in a Kit error's cause chain. */
export function programErrorCode(e: unknown): number | undefined {
  for (let cur = e as { context?: { code?: unknown }; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (typeof cur.context?.code === "number") return cur.context.code;
  }
  return undefined;
}

/** Assert the transaction fails; with `name`, that it fails with exactly that program error. */
export async function rejects(p: Promise<unknown>, name?: string) {
  await assert.rejects(p, (e: unknown) => {
    if (name) {
      const idx = PROGRAM_ERRORS.indexOf(name);
      assert.ok(idx >= 0, `unknown error name ${name}`);
      assert.equal(programErrorCode(e), 6000 + idx, `expected ${name}, got code ${programErrorCode(e)}`);
    }
    return true;
  });
}

export const DEFAULT_POLICY = (seller: Address, approver: Address): PolicyParamsArgs => ({
  periodSecs: 86_400,
  periodBudget: 50n * USDC,
  maxPrice: 20n * USDC,
  approvalThreshold: 10n * USDC,
  approver,
  allowAnySeller: false,
  allowedSellers: [seller],
});

export async function setup(opts: { policy?: (s: Address, a: Address) => PolicyParamsArgs } = {}) {
  const client = await createClient()
    .use(generatedSigner())
    .use(litesvm())
    .use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  // LiteSVM's clock starts at unix 0; start at a realistic time so a 0 timestamp can't mask bugs.
  const clock0 = client.svm.getClock();
  clock0.unixTimestamp = 1_800_000_000n;
  client.svm.setClock(clock0);

  const buyer = client.payer;
  const [seller, stranger, verifier, approver, mint] = await Promise.all(
    [0, 1, 2, 3, 4].map(() => generateKeyPairSigner()),
  ) as [KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner];
  for (const s of [seller, stranger, verifier, approver]) client.svm.airdrop(s.address, lamports(1_000_000_000n));

  await client.sendTransaction(
    await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }),
  );
  const fund = async (owner: Address, amount: bigint) =>
    client.sendTransaction(
      await getMintToATAInstructionPlanAsync({ payer: buyer, owner, mint: mint.address, mintAuthority: buyer, amount, decimals: 6 }),
    );
  await fund(buyer.address, 100n * USDC);
  await fund(seller.address, 20n * USDC);
  await fund(stranger.address, 20n * USDC);
  for (const s of [verifier, approver]) {
    await client.sendTransaction([
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner: s.address, mint: mint.address }),
    ]);
  }

  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const balance = async (owner: Address) => (await fetchToken(client.rpc, await ata(owner))).data.amount;
  const now = () => client.svm.getClock().unixTimestamp;
  const warp = (secs: bigint) => {
    const clock = client.svm.getClock();
    clock.unixTimestamp = clock.unixTimestamp + secs;
    client.svm.setClock(clock);
    client.svm.expireBlockhash();
  };
  const policy = await policyAddress(buyer.address);
  const send = async (ixs: Parameters<typeof client.sendTransaction>[0]) => {
    client.svm.expireBlockhash(); // identical retries must be new transactions
    return client.sendTransaction(ixs);
  };

  await send([
    await getInitPolicyInstructionAsync({
      buyer, mint: mint.address, params: (opts.policy ?? DEFAULT_POLICY)(seller.address, approver.address),
    }),
  ]);

  let nextId = 1n;
  async function open(o: DealOpts = {}) {
    const dealId = nextId++;
    await send([
      await getCreateDealInstructionAsync({
        buyer, seller: o.seller ?? seller.address, approver: o.approver, mint: mint.address,
        buyerToken: await ata(buyer.address), dealId,
        amount: o.amount ?? 5n * USDC, deadline: o.deadline ?? now() + HOUR,
        reviewSecs: o.reviewSecs ?? 600n, resolveSecs: o.resolveSecs ?? 600n,
        toleranceBps: o.toleranceBps ?? 500, stakeRequired: o.stakeRequired ?? 1n * USDC,
        bondBps: o.bondBps ?? 1000, verifier: o.verifier ?? verifier.address, termsHash: hash(7),
      }),
    ]);
    return dealAddress(buyer.address, dealId);
  }
  const settleAccounts = async (actor: TransactionSigner, deal: Address) => {
    const d = (await fetchDeal(client.rpc, deal)).data;
    return { actor, deal, policy, mint: mint.address, buyerToken: await ata(d.buyer), sellerToken: await ata(d.seller) };
  };
  const ops = {
    accept: async (deal: Address, by: TransactionSigner = seller) =>
      send([await getAcceptInstructionAsync({ seller: by, deal, mint: mint.address, sellerToken: await ata(by.address) })]),
    deliver: async (deal: Address, invoice = 5n * USDC, by: TransactionSigner = seller, h = hash(9)) =>
      send([getSubmitDeliveryInstruction({ seller: by, deal, deliveryHash: h, invoiceAmount: invoice })]),
    release: async (deal: Address, by: TransactionSigner = buyer, h = hash(9)) =>
      send([await getReleaseInstructionAsync({ ...(await settleAccounts(by, deal)), expectedDeliveryHash: h })]),
    claim: async (deal: Address, by: TransactionSigner = seller) =>
      send([await getClaimInstructionAsync(await settleAccounts(by, deal))]),
    challenge: async (deal: Address, by: TransactionSigner = buyer) =>
      send([await getChallengeInstructionAsync({ buyer: by, deal, mint: mint.address, buyerToken: await ata(by.address) })]),
    resolve: async (deal: Address, ok: boolean, by: TransactionSigner = verifier) =>
      send([await getResolveInstructionAsync({ ...(await settleAccounts(by, deal)), deliveryOk: ok })]),
    timeoutRefund: async (deal: Address, by: TransactionSigner = stranger) =>
      send([await getTimeoutRefundInstructionAsync(await settleAccounts(by, deal))]),
    refund: async (deal: Address, by: TransactionSigner = stranger) =>
      send([await getRefundInstructionAsync(await settleAccounts(by, deal))]),
    cancel: async (deal: Address, by: TransactionSigner = buyer) =>
      send([await getCancelInstructionAsync(await settleAccounts(by, deal))]),
    updatePolicy: async (params: PolicyParamsArgs, by: TransactionSigner = buyer) =>
      send([await getUpdatePolicyInstructionAsync({ buyer: by, policy, params })]),
  };
  const deal = async (address: Address) => (await fetchDeal(client.rpc, address)).data;
  const maybeDeal = async (address: Address) => fetchMaybeDeal(client.rpc, address);
  const vaultBalance = async (address: Address) => {
    const [vault] = await findAssociatedTokenPda({ owner: address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return (await fetchToken(client.rpc, vault)).data.amount;
  };

  return {
    client, buyer, seller, stranger, verifier, approver, mint, policy, ata, balance, now, warp, send, open, deal, maybeDeal,
    vaultBalance, ...ops,
  };
}
