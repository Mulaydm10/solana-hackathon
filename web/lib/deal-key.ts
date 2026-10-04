// Server-only core of the buy flow's two routes (#111):
//   pickupKey  POST /api/deals/[deal]/key   - key pickup for a browser buyer (#125 design)
//   storeTerms POST /api/deals/[deal]/terms - the deal's canonical terms, for the verifier (#108)
// Rules, all checked here against the chain, never taken from the request:
//   - the key goes out only AFTER delivery (Delivered or later), so a buyer can't hold the data while the deal still
//     looks undelivered (#97 note); custody re-checks buyer, listing and status itself
//   - the signed request is pinned to this server's cluster and program id (#126 review note 2); a signature for
//     any other cluster or program does not verify
//   - every release is recorded as `releases/<deal>.json` naming the buyer's WALLET (#126 note 3), where the
//     verifier's keyReleasedTo reads it
import { canonicalJson, sha256Hex, type DealTerms } from "@deal/core";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { createCustody, memoryKeyStore, type KeyEntry } from "./agents-sell";
import { ADDRESS, type DealView } from "./deal-read";
import type { Blobs } from "./storage";

export type Refusal = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message });

/** Statuses after the seller's on-chain delivery: only then does the key leave custody. */
export const KEY_AFTER_DELIVERY: readonly string[] = ["Delivered", "Challenged", "Released", "Claimed", "VerifiedPass"];

export type DealDeps = {
  readDeal(deal: string): Promise<DealView | null>;
  keys: { get(listing: string): Promise<KeyEntry | undefined> };
  ciphertext(listing: string): Promise<Uint8Array | null>;
  /** Raw store for `releases/<deal>.json` and `terms/<deal>.json` (docs blobs). */
  blobs: Blobs;
  cluster: string;
  now(): number;
};

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export type KeyBody = { buyer?: unknown; ephemeralPub?: unknown; expires?: unknown; signature?: unknown };
export type PickedUp = { ok: true; sealedKey: string; ciphertext: string; contentHash: string; buyer: string };

export async function pickupKey(deps: DealDeps, deal: string, body: KeyBody): Promise<PickedUp | Refusal> {
  if (!ADDRESS.test(deal)) return refuse("BAD_DEAL", "not a deal address");
  const { buyer, ephemeralPub, expires, signature } = body;
  if (typeof buyer !== "string" || !ADDRESS.test(buyer) || typeof ephemeralPub !== "string" || !/^[0-9a-f]{64}$/.test(ephemeralPub)
    || typeof expires !== "number" || !Number.isSafeInteger(expires) || typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) {
    return refuse("BAD_REQUEST", "send { buyer, ephemeralPub (64 hex), expires (unix s), signature (128 hex) }");
  }
  const view = await deps.readDeal(deal).catch(() => null);
  if (!view) return refuse("NO_DEAL", "the chain shows no such deal");
  if (!view.listing) return refuse("NO_LISTING", "this deal was not opened from a listing, so there is no data in custody");
  if (!KEY_AFTER_DELIVERY.includes(view.status)) return refuse("NOT_DELIVERED", `the deal is ${view.status}; the key is released after the seller's on-chain delivery`);
  const entry = await deps.keys.get(view.listing).catch(() => undefined);
  if (!entry) return refuse("NO_KEY", "custody holds no data for this listing");
  const ciphertext = await deps.ciphertext(view.listing).catch(() => null);
  if (!ciphertext) return refuse("NO_DATA", "custody holds no data for this listing");

  const keys = memoryKeyStore();
  keys.set(view.listing, entry);
  let releasedTo: string | null = null;
  const custody = createCustody({
    // The facts custody checks come from the same chain read, never from the request.
    readDeal: async () => ({ status: view.status, buyer: view.buyer, listing: view.listing }),
    keys,
    releases: { record: (_d, wallet) => void (releasedTo = wallet), releasedTo: () => releasedTo },
    now: deps.now,
  });
  // Cluster and program are this server's own, so a signature made for anywhere else cannot verify.
  const request = { deal, ephemeralPub, expires, cluster: deps.cluster, programId: DEAL_ESCROW_PROGRAM_ADDRESS };
  const r = await custody.releaseKey({ listing: view.listing, deal, buyer, recipient: { request, signature: fromHex(signature) } });
  if (!r.ok) return r;
  await deps.blobs.write(`releases/${deal}.json`, new TextEncoder().encode(JSON.stringify({ deal, wallet: releasedTo, at: deps.now() })));
  return { ok: true, sealedKey: b64(r.sealedKey), ciphertext: b64(ciphertext), contentHash: Buffer.from(entry.contentHash).toString("hex"), buyer };
}

/** The verifier's FactSources.keyReleasedTo: the wallet a deal's key went to, or null. */
export async function keyReleasedTo(blobs: Blobs, deal: string): Promise<string | null> {
  if (!ADDRESS.test(deal)) return null;
  const b = await blobs.read(`releases/${deal}.json`);
  if (!b) return null;
  try {
    const r = JSON.parse(new TextDecoder().decode(b)) as { wallet?: unknown };
    return typeof r.wallet === "string" ? r.wallet : null;
  } catch {
    return null;
  }
}

/** Parses canonical terms JSON back to DealTerms (price as bigint); null if it is not exactly canonical. */
export function parseCanonicalTerms(text: string): DealTerms | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o.price !== "string" || !/^\d{1,20}$/.test(o.price)) return null;
    const t = { ...o, price: BigInt(o.price) } as unknown as DealTerms;
    return canonicalJson(t) === text ? t : null;
  } catch {
    return null;
  }
}

/** Stores the canonical terms a deal committed to, only if they hash to the deal's on-chain terms hash. */
export async function storeTerms(deps: Pick<DealDeps, "readDeal" | "blobs">, deal: string, terms: unknown): Promise<{ ok: true } | Refusal> {
  if (!ADDRESS.test(deal)) return refuse("BAD_DEAL", "not a deal address");
  if (typeof terms !== "string" || terms.length > 8_192) return refuse("BAD_REQUEST", "send { terms: <canonical terms JSON string> }");
  const parsed = parseCanonicalTerms(terms);
  if (!parsed) return refuse("NOT_CANONICAL", "the terms must be core canonicalJson output");
  const view = await deps.readDeal(deal).catch(() => null);
  if (!view) return refuse("NO_DEAL", "the chain shows no such deal");
  if (sha256Hex(terms) !== view.termsHash) return refuse("TERMS_MISMATCH", "these terms do not hash to the deal's on-chain terms hash");
  if (parsed.buyer !== view.buyer || parsed.seller !== view.seller) return refuse("TERMS_MISMATCH", "the terms name a different buyer or seller");
  await deps.blobs.write(`terms/${deal}.json`, new TextEncoder().encode(terms));
  return { ok: true };
}
