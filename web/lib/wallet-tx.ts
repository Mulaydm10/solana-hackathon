// Send instructions with the user's own wallet (Wallet Standard `solana:signAndSendTransaction`). The site builds
// the transaction from the program's generated builders, the wallet shows it, signs it and sends it: the site
// never sees a private key. Shared by the buy flow (#72) and the hire flow (#73).
import {
  appendTransactionMessageInstructions, compileTransaction, createSolanaRpc, createTransactionMessage, getBase58Decoder,
  getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction,
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

export type WalletSend = { ok: true; signature: string } | { ok: false; reason: "NO_SIGN_AND_SEND" | "REJECTED_OR_FAILED"; message: string };

export async function sendWithWallet(wallet: Wallet, account: WalletAccount, rpcUrl: string, instructions: Instruction[]): Promise<WalletSend> {
  const feature = wallet.features[SIGN_AND_SEND] as SignAndSend | undefined;
  if (!feature) return { ok: false, reason: "NO_SIGN_AND_SEND", message: "this wallet cannot sign and send Solana transactions" };
  try {
    const { value } = await createSolanaRpc(rpcUrl).getLatestBlockhash().send();
    const transaction = transactionBytes(account.address as Address, value, instructions);
    const [r] = await feature.signAndSendTransaction({ account, chain: "solana:devnet", transaction });
    return { ok: true, signature: getBase58Decoder().decode(r!.signature) };
  } catch (e) {
    return { ok: false, reason: "REJECTED_OR_FAILED", message: e instanceof Error ? e.message : String(e) };
  }
}
