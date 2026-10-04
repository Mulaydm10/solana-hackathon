// Devnet test-token faucet (PLAN §8): a fixed amount per request, at most once per wallet and per client
// address every 24 h, and a daily total cap, so one visitor cannot drain it. Sending is injected; the route
// wires it to the faucet wallet (server key from Vercel env, never the client).
import { base58Decode } from "@deal/core";

export type FaucetSend = (to: string, amount: bigint) => Promise<{ ok: true; signature: string } | { ok: false; reason: string; message: string }>;

export type FaucetResult =
  | { ok: true; signature: string; amount: string }
  | { ok: false; reason: "BAD_WALLET" | "WALLET_LIMIT" | "CLIENT_LIMIT" | "DAILY_CAP" | string; message: string; retryAfterSecs?: number };

export const FAUCET = { amount: 20_000_000n, windowSecs: 86_400, dailyCap: 2_000_000_000n } as const;

export function createFaucet(send: FaucetSend, o: { now?: () => number; amount?: bigint; dailyCap?: bigint } = {}) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const amount = o.amount ?? FAUCET.amount;
  const cap = o.dailyCap ?? FAUCET.dailyCap;
  const lastByWallet = new Map<string, number>();
  const lastByClient = new Map<string, number>();
  let day = -1;
  let given = 0n;
  return async (wallet: string, client: string): Promise<FaucetResult> => {
    const t = now();
    const key = base58Decode(wallet);
    if (!key || key.length !== 32) return { ok: false, reason: "BAD_WALLET", message: "That is not a Solana wallet address." };
    const w = lastByWallet.get(wallet);
    if (w !== undefined && t - w < FAUCET.windowSecs) return { ok: false, reason: "WALLET_LIMIT", message: "This wallet got test tokens in the last 24 hours.", retryAfterSecs: FAUCET.windowSecs - (t - w) };
    const c = lastByClient.get(client);
    if (c !== undefined && t - c < FAUCET.windowSecs) return { ok: false, reason: "CLIENT_LIMIT", message: "You got test tokens in the last 24 hours.", retryAfterSecs: FAUCET.windowSecs - (t - c) };
    const today = Math.floor(t / FAUCET.windowSecs);
    if (today !== day) { day = today; given = 0n; }
    if (given + amount > cap) return { ok: false, reason: "DAILY_CAP", message: "The faucet has given out today's total. Try tomorrow." };
    // Reserve before sending, so two concurrent requests cannot both pass the limits.
    lastByWallet.set(wallet, t);
    lastByClient.set(client, t);
    given += amount;
    const r = await send(wallet, amount).catch((e: unknown) => ({ ok: false as const, reason: "SEND_FAILED", message: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) {
      // Nothing was sent: release the reservation so the visitor can retry.
      lastByWallet.delete(wallet);
      lastByClient.delete(client);
      given -= amount;
      return r;
    }
    return { ok: true, signature: r.signature, amount: amount.toString() };
  };
}
