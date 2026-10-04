// Server-only: the Registry the site serves. Fixtures by default (demo), the on-chain registry when
// DEAL_REGISTRY=chain (after the devnet upgrade). Pages, /api/catalogue and /llms.txt all read this one source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSolanaRpc } from "@solana/kit";
import { chainRegistry, type DocStore } from "./chain-registry";
import { rpcSource, type MinimalRpc } from "./chain-source";
import { parseEnv } from "./env";
import { fixtureRegistry, type Registry } from "./registry";

/** Listing documents on disk: `<dir>/<listing address>.json` = { meta: string, report?: string }. */
export function fileDocStore(dir: string): DocStore {
  return {
    async get(listing) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(listing)) return null; // never a path traversal
      const p = join(dir, `${listing}.json`);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as { meta?: string; report?: string };
      } catch {
        return null;
      }
    },
  };
}

let cached: Registry | undefined;

export function siteRegistry(): Registry {
  if (cached) return cached;
  const env = parseEnv(process.env);
  if (process.env.DEAL_REGISTRY === "chain" && env.ok) {
    const rpc = createSolanaRpc(env.env.rpcUrl) as unknown as MinimalRpc;
    cached = chainRegistry(rpcSource(rpc), fileDocStore(process.env.DEAL_DOCS_DIR ?? join(process.cwd(), ".data", "docs")));
  } else {
    cached = fixtureRegistry();
  }
  return cached;
}

export const registryMode = () => (process.env.DEAL_REGISTRY === "chain" ? "chain" : "demo");
