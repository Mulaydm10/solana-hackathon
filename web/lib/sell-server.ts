// Server-only: builds the sell flow's dependencies from env (#110). Storage is Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set (Vercel's disk is read-only), else files under DEAL_DOCS_DIR / DEAL_KEYS_DIR
// (local dev, the Omen). Documents and ciphertext share one store; custody keys live apart, sealed.
import { join } from "node:path";
import { createClient, createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { get as blobGet, put as blobPut } from "@vercel/blob";
import type { DealClient, DealContext } from "@deal/chain";
import type { ServerEnv } from "./env";
import { USDC_DEVNET } from "./registry";
import type { Probe } from "./sell";
import { docStore, fileBlobs, keyVault, vercelBlobs, type BlobApi, type Blobs, type KeyVault, type WritableDocStore } from "./storage";

const blobApi: BlobApi = {
  put: (pathname, body, o) => blobPut(pathname, Buffer.from(body), o),
  get: (pathname, o) => blobGet(pathname, o),
};

/** Where listing documents and ciphertext live (also what the chain registry reads). */
export function docsBlobs(env: Pick<ServerEnv, "BLOB_READ_WRITE_TOKEN">, raw: Record<string, string | undefined> = process.env): Blobs {
  return env.BLOB_READ_WRITE_TOKEN
    ? vercelBlobs(blobApi, env.BLOB_READ_WRITE_TOKEN, "docs")
    : fileBlobs(raw.DEAL_DOCS_DIR ?? join(process.cwd(), ".data", "docs"));
}

function keysBlobs(env: Pick<ServerEnv, "BLOB_READ_WRITE_TOKEN">, raw: Record<string, string | undefined>): Blobs {
  return env.BLOB_READ_WRITE_TOKEN
    ? vercelBlobs(blobApi, env.BLOB_READ_WRITE_TOKEN, "custody-keys")
    : fileBlobs(raw.DEAL_KEYS_DIR ?? join(process.cwd(), ".data", "keys"));
}

export type SellRuntime = { ctx: DealContext; docs: WritableDocStore; keys: KeyVault; assessor: KeyPairSigner; now: () => number; probe: Probe };

/** The assessor's one probe call to a seller's https endpoint (assess sets its own timeout). */
const probe: Probe = (url, init) => (url.startsWith("https://") ? fetch(url, { ...init, redirect: "error" }) : Promise.reject(new Error("https only")));

let cached: Promise<SellRuntime> | undefined;

/** Needs the "sell" capability (requireEnv) first: DEAL_ASSESSOR_KEY and DEAL_CUSTODY_KEY are present. */
export function sellRuntime(env: ServerEnv, raw: Record<string, string | undefined> = process.env): Promise<SellRuntime> {
  cached ??= (async () => {
    const assessor = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(env.DEAL_ASSESSOR_KEY!) as number[]));
    // The assessor pays its own attest_listing fees.
    const client = createClient().use(signerPlugin(assessor)).use(solanaRpc({ rpcUrl: env.rpcUrl }));
    const ctx: DealContext = { client: client as unknown as DealClient, mint: (env.DEAL_MINT ?? USDC_DEVNET) as Address };
    const master = Uint8Array.from(Buffer.from(env.DEAL_CUSTODY_KEY!, "hex"));
    return { ctx, docs: docStore(docsBlobs(env, raw)), keys: keyVault(keysBlobs(env, raw), master), assessor, now: () => Math.floor(Date.now() / 1000), probe };
  })();
  return cached;
}
