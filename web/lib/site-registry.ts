// Server-only: the Registry the site serves. Fixtures by default (demo), the on-chain registry when
// DEAL_REGISTRY=chain (after the devnet upgrade). Pages, /api/catalogue and /llms.txt all read this one source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSolanaRpc } from "@solana/kit";
import { chainRegistry, type DocStore } from "./chain-registry";
import { rpcSource, type MinimalRpc } from "./chain-source";
import { parseEnv } from "./env";
import { docsBlobs } from "./sell-server";
import { docStore } from "./storage";
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

/** The registry could not be read (RPC down or rate-limited) and there is no earlier good list to serve. */
export class RegistryUnavailable extends Error {
  constructor(cause?: unknown) {
    super("the listing registry is temporarily unavailable", { cause });
    this.name = "RegistryUnavailable";
  }
}

export type RetryOptions = { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };

/**
 * A registry that survives RPC hiccups (#131): each read is retried with a short backoff; if every attempt
 * fails, the last list read successfully is served (same verified listings, possibly a little stale); with
 * none yet, it throws RegistryUnavailable for the caller to show as "try again", never as a raw 500.
 */
export function resilientRegistry(inner: Registry, o: RetryOptions = {}): Registry {
  const attempts = Math.max(1, o.attempts ?? 3);
  const delayMs = o.delayMs ?? 300;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastGood: Awaited<ReturnType<Registry["list"]>> | undefined;
  const retry = async <T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    let error: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs * 2 ** (i - 1));
      try {
        return { ok: true, value: await read() };
      } catch (e) {
        error = e;
      }
    }
    return { ok: false, error };
  };
  return {
    async list() {
      const r = await retry(() => inner.list());
      if (r.ok) return (lastGood = r.value);
      if (lastGood) return lastGood;
      throw new RegistryUnavailable(r.error);
    },
    async get(address) {
      const r = await retry(() => inner.get(address));
      if (r.ok) return r.value;
      if (lastGood) return lastGood.find((l) => l.address === address) ?? null;
      throw new RegistryUnavailable(r.error);
    },
  };
}

let cached: Registry | undefined;

export function siteRegistry(): Registry {
  if (cached) return cached;
  const env = parseEnv(process.env);
  if (process.env.DEAL_REGISTRY === "chain" && env.ok) {
    const rpc = createSolanaRpc(env.env.rpcUrl) as unknown as MinimalRpc;
    // The same documents the sell flow writes (files, or Vercel Blob with BLOB_READ_WRITE_TOKEN).
    cached = resilientRegistry(chainRegistry(rpcSource(rpc), docStore(docsBlobs(env.env))));
  } else {
    cached = fixtureRegistry();
  }
  return cached;
}

export const registryMode = () => (process.env.DEAL_REGISTRY === "chain" ? "chain" : "demo");
/** The footer line about where listings come from (#132): only demo mode calls them demo data. */
export const registryNote = () =>
  registryMode() === "chain" ? "Listings are read from the on-chain registry." : "Listings shown are demo data until the registry is on chain.";
