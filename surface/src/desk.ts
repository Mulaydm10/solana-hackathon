// The deal desk: sends deal_escrow instructions to Solana devnet. The server wallet is the buyer
// and pays every fee (sellers sign but need no SOL). The program, not this code, enforces the rules.
import { createClient, type Address, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { fetchMaybeToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS,
  STATUS_NAMES,
  dealAddress,
  fetchMaybeDeal,
  getClaimInstructionAsync,
  getCreateDealInstructionAsync,
  getRefundInstructionAsync,
  getReleaseInstructionAsync,
  getSubmitDeliveryInstruction,
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
};

export type DealView = {
  address: Address;
  buyer: Address;
  seller: Address;
  amount: string;
  deadline: number;
  reviewSecs: number;
  status: (typeof STATUS_NAMES)[number];
  termsHash: string;
  deliveryHash: string;
  deliveredAt: number;
};

/** What the HTTP layer needs; tests pass a fake. */
export interface Desk {
  buyer: Address;
  sellerFor(serviceId: string): Address | undefined;
  lock(input: LockInput): Promise<{ deal: Address; signature: string }>;
  deliver(deal: Address, deliveryHash: Uint8Array): Promise<string>;
  release(deal: Address): Promise<string>;
  refund(deal: Address): Promise<string>;
  claim(deal: Address): Promise<string>;
  get(deal: Address): Promise<DealView | null>;
  /** Live proof the setup is real: program deployed, buyer balances. */
  status(): Promise<DeskStatus>;
}

export type DeskStatus = {
  program: Address;
  programDeployed: boolean;
  buyerSol: number;
  buyerTokens: string;
  mint: Address;
  sellers: number;
};

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString("hex");

export async function createDesk(cfg: DeskConfig): Promise<Desk> {
  const buyerSigner = await loadSigner(cfg.buyerKeyPath);
  const client = createClient().use(signerPlugin(buyerSigner)).use(solanaRpc({ rpcUrl: cfg.rpcUrl }));
  const sellers = new Map<string, KeyPairSigner>(); // serviceId -> signer
  for (const [serviceId, path] of Object.entries(cfg.sellers)) sellers.set(serviceId, await loadSigner(path));
  const byAddress = new Map([...sellers.values()].map((s) => [s.address, s]));
  const mint = cfg.mint as Address;
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const send = async (ix: Parameters<typeof client.sendTransaction>[0]) => {
    const result = await client.sendTransaction(ix);
    return String(result.context.signature);
  };
  const sellerOf = async (deal: Address) => {
    const d = await fetchMaybeDeal(client.rpc, deal);
    if (!d.exists) throw new Error(`no deal at ${deal}`);
    const s = byAddress.get(d.data.seller);
    if (!s) throw new Error(`no demo key for seller ${d.data.seller}`);
    return { signer: s, data: d.data };
  };

  return {
    buyer: buyerSigner.address,
    sellerFor: (serviceId) => sellers.get(serviceId)?.address,
    async lock(input) {
      const signature = await send([
        await getCreateDealInstructionAsync({
          buyer: buyerSigner, seller: input.seller, mint, buyerToken: await ata(buyerSigner.address),
          dealId: input.dealId, amount: input.price, deadline: BigInt(input.deadline),
          reviewSecs: BigInt(input.reviewSecs), termsHash: input.termsHash,
        }),
      ]);
      return { deal: await dealAddress(buyerSigner.address, input.dealId), signature };
    },
    async deliver(deal, deliveryHash) {
      const { signer } = await sellerOf(deal);
      return send([getSubmitDeliveryInstruction({ seller: signer, deal, deliveryHash })]);
    },
    async release(deal) {
      const { data } = await sellerOf(deal);
      return send([await getReleaseInstructionAsync({ buyer: buyerSigner, deal, mint, sellerToken: await ata(data.seller) })]);
    },
    async refund(deal) {
      return send([await getRefundInstructionAsync({ deal, mint, buyerToken: await ata(buyerSigner.address) })]);
    },
    async claim(deal) {
      const { signer } = await sellerOf(deal);
      return send([await getClaimInstructionAsync({ seller: signer, deal, mint, sellerToken: await ata(signer.address) })]);
    },
    async get(deal) {
      const d = await fetchMaybeDeal(client.rpc, deal);
      if (!d.exists) return null;
      const x = d.data;
      return {
        address: deal, buyer: x.buyer, seller: x.seller, amount: x.amount.toString(),
        deadline: Number(x.deadline), reviewSecs: Number(x.reviewSecs), status: STATUS_NAMES[x.status],
        termsHash: hex(x.termsHash), deliveryHash: hex(x.deliveryHash), deliveredAt: Number(x.deliveredAt),
      };
    },
    async status() {
      const [program, sol, token] = await Promise.all([
        client.rpc.getAccountInfo(DEAL_ESCROW_PROGRAM_ADDRESS, { encoding: "base64" }).send(),
        client.rpc.getBalance(buyerSigner.address).send(),
        fetchMaybeToken(client.rpc, await ata(buyerSigner.address)),
      ]);
      return {
        program: DEAL_ESCROW_PROGRAM_ADDRESS, programDeployed: Boolean(program.value?.executable),
        buyerSol: Number(sol.value) / 1e9, buyerTokens: token.exists ? token.data.amount.toString() : "0",
        mint, sellers: sellers.size,
      };
    },
  };
}
