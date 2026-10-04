// Server-only: the buy flow's dependencies from env. Key pickup needs the custody capability (the master key);
// terms storage only needs the doc store. Same storage as the sell flow (#110), so keys and ciphertext match.
import type { ServerEnv } from "./env";
import type { DealDeps } from "./deal-key";
import { readDealView, rpcFor } from "./deal-read";
import { docsBlobs, keysBlobs } from "./sell-server";
import { docStore, keyVault } from "./storage";

export function dealDeps(env: ServerEnv, raw: Record<string, string | undefined> = process.env): DealDeps {
  const rpc = rpcFor(env.rpcUrl);
  const blobs = docsBlobs(env, raw);
  // Without DEAL_CUSTODY_KEY there is no vault to open; the key route requires the "sell" capability first.
  const vault = env.DEAL_CUSTODY_KEY ? keyVault(keysBlobs(env, raw), Uint8Array.from(Buffer.from(env.DEAL_CUSTODY_KEY, "hex"))) : null;
  return {
    readDeal: (deal) => readDealView(rpc, deal),
    keys: { get: async (listing) => (vault ? vault.get(listing) : undefined) },
    ciphertext: (listing) => docStore(blobs).getCiphertext(listing),
    blobs,
    cluster: env.DEAL_CLUSTER,
    now: () => Math.floor(Date.now() / 1000),
  };
}
