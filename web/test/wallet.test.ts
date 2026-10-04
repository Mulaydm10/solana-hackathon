import { test } from "node:test";
import assert from "node:assert/strict";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { devnetAccount, devnetWallets, short } from "../app/wallet.tsx";

const account = (address: string, chains: string[]) => ({ address, publicKey: new Uint8Array(32), chains, features: [] }) as unknown as WalletAccount;
const wallet = (name: string, chains: string[], features: string[]) =>
  ({ version: "1.0.0", name, icon: "data:image/svg+xml,", chains, accounts: [], features: Object.fromEntries(features.map((f) => [f, {}])) }) as unknown as Wallet;

test("only wallets that can connect on Solana devnet are offered", () => {
  const ws = [
    wallet("Phantom", ["solana:mainnet", "solana:devnet"], ["standard:connect", "solana:signTransaction"]),
    wallet("MainnetOnly", ["solana:mainnet"], ["standard:connect"]),
    wallet("NoConnect", ["solana:devnet"], ["solana:signTransaction"]),
    wallet("EvmWallet", ["eip155:1"], ["standard:connect"]),
  ];
  assert.deepEqual(devnetWallets(ws).map((w) => w.name), ["Phantom"]);
});

test("the connected account must be a devnet account", () => {
  assert.equal(devnetAccount([account("Main1", ["solana:mainnet"])]), null);
  assert.equal(devnetAccount([account("Main1", ["solana:mainnet"]), account("Dev1", ["solana:devnet"])])?.address, "Dev1");
  assert.equal(short("7kP2BybuHZVTM9n53AT4eH5jTk9LCPk1NwGncU25kjd8"), "7kP2…kjd8");
});
