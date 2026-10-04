// Devnet-only demo keys, stored as Solana CLI keypair files (64-byte JSON) under surface/.keys
// (gitignored). They hold test tokens with no value. Never point this at mainnet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyPairSignerFromBytes, getAddressEncoder, createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";

export const KEYS_DIR = new URL("../.keys/", import.meta.url).pathname;
export const CONFIG_PATH = KEYS_DIR + "config.json";

export type DeskConfig = {
  rpcUrl: string;
  /** Buyer + fee payer keypair file (the Solana CLI wallet by default). */
  buyerKeyPath: string;
  mint: string;
  decimals: number;
  symbol: string;
  /** serviceId -> seller keypair file. */
  sellers: Record<string, string>;
};

export async function loadSigner(path: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

/** Load the keypair at `path`, creating it first if missing. */
export async function loadOrCreateSigner(path: string): Promise<KeyPairSigner> {
  if (!existsSync(path)) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
    const full = new Uint8Array(64);
    full.set(secret, 0);
    full.set(getAddressEncoder().encode(signer.address), 32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...full]), { mode: 0o600 });
  }
  return loadSigner(path);
}

export function readConfig(): DeskConfig {
  if (!existsSync(CONFIG_PATH)) throw new Error("no surface/.keys/config.json - run `npm run setup:devnet --prefix surface` first");
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DeskConfig;
}
