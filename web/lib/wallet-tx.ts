// Send instructions with the user's own wallet (Wallet Standard `solana:signAndSendTransaction`). The site builds
// the transaction from the program's generated builders, the wallet shows it, signs it and sends it: the site
// never sees a private key. Shared by the buy flow (#72) and the hire flow (#73).
import {
  address, appendTransactionMessageInstructions, compileTransaction, createSolanaRpc, createTransactionMessage, getBase58Decoder,
  getBase64Decoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Base64EncodedWireTransaction, type Instruction,
} from "@solana/kit";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

export const SIGN_AND_SEND = "solana:signAndSendTransaction";
type SignAndSend = {
  signAndSendTransaction(...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]): Promise<{ signature: Uint8Array }[]>;
};

/** The unsigned transaction bytes for `instructions`, paid by `payer`, valid for a recent blockhash. */
export function transactionBytes(payer: Address, blockhash: { blockhash: string; lastValidBlockHeight: bigint }, instructions: Instruction[]): Uint8Array {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as never, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg)));
}

export type WalletSend = { ok: true; signature: string } | { ok: false; reason: "NO_SIGN_AND_SEND" | "REJECTED_OR_FAILED" | "SIMULATION_FAILED"; message: string };

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const CU_PRICE_MICRO_LAMPORTS = 10_000n;

/** SetComputeUnitLimit + SetComputeUnitPrice. A transaction that already carries them is shown and sent as built (#146). */
export function computeBudgetIxs(units: number, microLamports: bigint = CU_PRICE_MICRO_LAMPORTS): Instruction[] {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, microLamports, true);
  return [{ programAddress: COMPUTE_BUDGET, data: limit }, { programAddress: COMPUTE_BUDGET, data: price }];
}

type Simulated = { ok: true; units: number } | { ok: false; message: string };

/** Simulate on the site's own RPC first: a failing transaction never reaches the wallet, and the limit fits the work. */
async function simulate(rpc: ReturnType<typeof createSolanaRpc>, payer: Address, blockhash: Parameters<typeof transactionBytes>[1], instructions: Instruction[]): Promise<Simulated> {
  const wire = getBase64Decoder().decode(transactionBytes(payer, blockhash, [...computeBudgetIxs(1_400_000), ...instructions])) as Base64EncodedWireTransaction;
  const { value } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
  if (value.err) {
    const why = value.logs?.find((l) => l.includes("Error Message:")) ?? value.logs?.at(-1) ?? JSON.stringify(value.err, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    return { ok: false, message: why.replace(/^Program log: /, "") };
  }
  return { ok: true, units: Number(value.unitsConsumed ?? 200_000n) };
}

export async function sendWithWallet(wallet: Wallet, account: WalletAccount, rpcUrl: string, instructions: Instruction[]): Promise<WalletSend> {
  const feature = wallet.features[SIGN_AND_SEND] as SignAndSend | undefined;
  if (!feature) return { ok: false, reason: "NO_SIGN_AND_SEND", message: "this wallet cannot sign and send Solana transactions" };
  try {
    const rpc = createSolanaRpc(rpcUrl);
    const payer = account.address as Address;
    const { value } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const sim = await simulate(rpc, payer, value, instructions);
    if (!sim.ok) return { ok: false, reason: "SIMULATION_FAILED", message: `the transaction would fail: ${sim.message}` };
    const units = Math.min(1_400_000, Math.ceil(sim.units * 1.2) + 10_000);
    const transaction = transactionBytes(payer, value, [...computeBudgetIxs(units), ...instructions]);
    const [r] = await feature.signAndSendTransaction({ account, chain: "solana:devnet", transaction });
    return { ok: true, signature: getBase58Decoder().decode(r!.signature) };
  } catch (e) {
    return { ok: false, reason: "REJECTED_OR_FAILED", message: e instanceof Error ? e.message : String(e) };
  }
}
