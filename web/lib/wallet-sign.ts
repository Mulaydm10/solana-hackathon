// Sign a message with the user's own wallet (Wallet Standard `solana:signMessage`), e.g. the key pickup request
// (#111). The wallet shows the text and signs it; the site never sees a key.
import type { Wallet, WalletAccount } from "@wallet-standard/base";

export const SIGN_MESSAGE = "solana:signMessage";
type SignMessage = { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]> };

export type Signed = { ok: true; signature: Uint8Array } | { ok: false; reason: "NO_SIGN_MESSAGE" | "REJECTED" | "ALTERED"; message: string };

export async function signWithWallet(wallet: Wallet, account: WalletAccount, message: Uint8Array): Promise<Signed> {
  const f = wallet.features[SIGN_MESSAGE] as SignMessage | undefined;
  if (!f) return { ok: false, reason: "NO_SIGN_MESSAGE", message: "this wallet cannot sign messages" };
  try {
    const [r] = await f.signMessage({ account, message });
    // A wallet may prefix what it signs; the server verifies exactly `message`, so anything else would fail later.
    if (!r || r.signedMessage.length !== message.length || !r.signedMessage.every((b, i) => b === message[i])) {
      return { ok: false, reason: "ALTERED", message: "the wallet signed different bytes than requested" };
    }
    return { ok: true, signature: r.signature };
  } catch (e) {
    return { ok: false, reason: "REJECTED", message: e instanceof Error ? e.message : String(e) };
  }
}
