// Runs the marketplace verifier (#108) on a long-running host: rules the challenges that name its key.
//   VERIFIER_KEYPAIR      path to the verifier's keypair file (its address is DEAL_VERIFIER on every deal)   required
//   VERIFIER_FACTS_URL    base URL of the site's server-side fact routes (custody + delivery store)          default: none
//   VERIFIER_FACTS_TOKEN  bearer token for those routes (>= 32 chars)                                         required with the URL
//   VERIFIER_INTERVAL_MS  pause between passes                                                                default 30000
//   DEAL_RPC_URL / DEAL_MINT                                                                                  devnet, Circle USDC
// Fact routes (GET, all under VERIFIER_FACTS_URL; 404 = "none", anything else non-2xx = "can't be had"):
//   /deals/:deal/key-release?buyer=:buyer  -> { "releasedTo": "<wallet>" | null }
//   /deals/:deal/terms                     -> the canonical terms JSON (core canonicalJson), as text
//   /deals/:deal/delivery                  -> the delivered bytes
// Without VERIFIER_FACTS_URL every fact is missing, so every challenge abstains and times out to a refund.
// Mainnet is refused. The key stays in this process: it signs `resolve` and is never sent anywhere.
import { readFileSync } from "node:fs";
import { createClient, createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import type { DealClient, DealContext } from "@deal/chain";
import { createVerifierService, type FactSources } from "../src/index.ts";

const env = process.env;
const fail = (m: string) => { console.error(`serve-verifier: ${m}`); process.exit(1); };
const rpcUrl = env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
if (/mainnet/i.test(rpcUrl)) fail("mainnet is not supported");
if (!env.VERIFIER_KEYPAIR) fail("VERIFIER_KEYPAIR must point to the verifier's keypair file");
const verifier = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(env.VERIFIER_KEYPAIR!, "utf8")) as number[]));
const client = createClient().use(signerPlugin(verifier)).use(solanaRpc({ rpcUrl }));
const ctx: DealContext = { client: client as unknown as DealClient, mint: (env.DEAL_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") as Address };

const base = env.VERIFIER_FACTS_URL?.replace(/\/+$/, "");
const token = env.VERIFIER_FACTS_TOKEN ?? "";
if (base && token.length < 32) fail("VERIFIER_FACTS_TOKEN must be at least 32 characters");
if (!base) console.warn("serve-verifier: no VERIFIER_FACTS_URL; every challenge will abstain");

/** null on 404, the response on 2xx; throws otherwise (the fact can't be had). */
async function get(path: string): Promise<Response | null> {
  if (!base) throw new Error("no fact source configured");
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fact route ${res.status}`);
  return res;
}

const sources: FactSources = {
  async keyReleasedTo(deal, buyer) {
    const res = await get(`/deals/${deal}/key-release?buyer=${encodeURIComponent(buyer)}`);
    if (!res) return null;
    const body = (await res.json()) as { releasedTo?: unknown };
    if (body.releasedTo !== null && typeof body.releasedTo !== "string") throw new Error("bad key-release reply");
    return body.releasedTo;
  },
  async terms(deal) {
    const res = await get(`/deals/${deal}/terms`);
    return res ? res.text() : null;
  },
  async content(deal) {
    const res = await get(`/deals/${deal}/delivery`);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  },
};

const svc = createVerifierService({ ctx, verifier, sources, log: (l) => console.log(l) });
const intervalMs = Number(env.VERIFIER_INTERVAL_MS ?? 30_000);
console.log(`serve-verifier: ruling challenges that name ${svc.address} every ${intervalMs} ms`);
svc.start(intervalMs);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { svc.stop(); process.exit(0); });
