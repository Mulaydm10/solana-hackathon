"use client";
// Connect a Wallet Standard wallet (Phantom) on Solana devnet. The site never holds a key: this only learns
// the public address. Wallets that do not support devnet are refused, matching lib/env.ts refusing mainnet.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";

export const DEVNET = "solana:devnet";

/** Wallets that can connect and work on Solana devnet. */
export function devnetWallets(all: readonly Wallet[]): Wallet[] {
  return all.filter((w) => w.chains.includes(DEVNET) && StandardConnect in w.features);
}

/** The first account the wallet exposes for devnet, or null. */
export function devnetAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  return accounts.find((a) => a.chains.includes(DEVNET)) ?? null;
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The connected wallet and devnet account, shared by every page that asks the buyer to sign (#72, #73). */
export type Connected = { wallet: Wallet; account: WalletAccount };
const Ctx = createContext<{ connected: Connected | null; set: (c: Connected | null) => void }>({ connected: null, set: () => {} });

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connected, set] = useState<Connected | null>(null);
  return <Ctx.Provider value={{ connected, set }}>{children}</Ctx.Provider>;
}

/** The connected wallet, or null until the user connects. */
export const useWallet = () => useContext(Ctx).connected;

export function WalletButton() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const { connected, set } = useContext(Ctx);
  const account = connected?.account ?? null;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const refresh = () => setWallets(devnetWallets(api.get()));
    refresh();
    const offs = [api.on("register", refresh), api.on("unregister", refresh)];
    return () => offs.forEach((off) => off());
  }, []);

  async function connect(w: Wallet) {
    setError(null);
    try {
      const { accounts } = await (w.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect]).connect();
      const a = devnetAccount(accounts);
      if (!a) setError("This wallet has no devnet account. Switch the wallet to Devnet and try again.");
      set(a ? { wallet: w, account: a } : null);
    } catch {
      setError("The wallet did not connect.");
    }
  }

  if (account) {
    return (
      <span data-testid="wallet-account" title={account.address}>
        <span aria-hidden>●</span> {short(account.address)} <small>devnet</small>
      </span>
    );
  }
  return (
    <span>
      {wallets.length === 0 ? (
        <small data-testid="wallet-none">No devnet wallet found. Install Phantom.</small>
      ) : (
        wallets.map((w) => (
          <button key={w.name} type="button" onClick={() => connect(w)}>
            Connect {w.name}
          </button>
        ))
      )}
      {error ? <small role="alert"> {error}</small> : null}
    </span>
  );
}
