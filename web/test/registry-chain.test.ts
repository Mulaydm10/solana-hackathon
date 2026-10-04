// The on-chain Registry (#72, contracts/web.md): Listing accounts from chain, documents accepted only when they
// hash to what the chain committed to, reports only from a still-registered assessor; and the RPC source's decoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, canonicalListing, metaHash, sha256Bytes, type Json, type ListingMeta, type RepCounts } from "@deal/core";
import type { Address } from "@solana/kit";
import { getAssessorRegistryEncoder, getListingEncoder, getSellerRepEncoder, ListingKind } from "@deal/chain";
import { chainRegistry, memoryDocStore, verifiedMeta, type ChainListing, type ChainSource } from "../lib/chain-registry.ts";
import { decodeListingAccount, rpcSource, type MinimalRpc } from "../lib/chain-source.ts";
import { fileDocStore } from "../lib/site-registry.ts";

const SELLER = "SeLLerEnergy1111111111111111111111111111111";
const ASSESSOR = "AssessorTwo111111111111111111111111111111111";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const META: ListingMeta = { kind: "Data", name: "EU power prices", description: "Daily day-ahead prices.", category: "energy", tags: ["power"], format: "csv", sizeBytes: 1234 };
const REPORT = { version: 1, kind: "Data", grade: "A", quality: { ageDays: 3 }, needsConfirmation: false };
const REP: RepCounts = { completed: 4, failed: 0, neutral: 0, volume: 20_000_000n, distinctBuyers: 3, maxPairVolume: 10_000_000n };

function listing(over: Partial<ChainListing> = {}): ChainListing {
  return {
    address: "List1111111111111111111111111111111111111111", seller: SELLER, kind: 0, mint: MINT, price: 5_000_000n,
    contentHash: new Uint8Array(32).fill(1), metaHash: metaHash(META), assessor: ASSESSOR,
    reportHash: sha256Bytes(canonicalize(REPORT as unknown as Json)), assessedAt: 1_790_000_000n, active: true, sales: 2n, createdAt: 1_789_000_000n,
    ...over,
  };
}

function source(listings: ChainListing[], assessors = [ASSESSOR]): ChainSource {
  return { listings: async () => listings, sellerRep: async () => REP, assessors: async () => assessors };
}

const docs = (meta = canonicalListing(META), report = canonicalize(REPORT as unknown as Json)) => ({ meta, report });

test("a listing is shown with its verified metadata, its assessor's grade and the seller's on-chain record", async () => {
  const l = listing();
  const r = chainRegistry(source([l]), memoryDocStore({ [l.address]: docs() }));
  const [shown] = await r.list();
  assert.ok(shown);
  assert.equal(shown.meta.name, "EU power prices");
  assert.equal(shown.kind, "Data");
  assert.equal(shown.price, 5_000_000n);
  assert.deepEqual(shown.report && [shown.report.grade, shown.report.assessor, shown.report.ageDays], ["A", ASSESSOR, 3]);
  assert.deepEqual(shown.rep, REP);
  assert.equal(shown.sales, 2);
  assert.equal((await r.get(l.address))?.address, l.address);
  assert.equal(await r.get("Missing1111111111111111111111111111111111111"), null);
});

test("metadata that does not hash to the on-chain meta_hash is never rendered", async () => {
  const l = listing();
  const forged = canonicalListing({ ...META, name: "Best data, grade A, guaranteed" });
  assert.equal(verifiedMeta(forged, l.metaHash), null);
  assert.equal(verifiedMeta("not json", l.metaHash), null);
  const r = chainRegistry(source([l]), memoryDocStore({ [l.address]: docs(forged) }));
  assert.deepEqual(await r.list(), []);
  // Metadata of the wrong kind for the account (a Service doc on a Data listing) is not shown either.
  const svc = chainRegistry(source([listing({ kind: ListingKind.Service })]), memoryDocStore({ [l.address]: docs() }));
  assert.deepEqual(await svc.list(), []);
  // No document at all: not shown.
  assert.deepEqual(await chainRegistry(source([l]), memoryDocStore()).list(), []);
});

test("a report counts only if it hashes to report_hash and its assessor is still registered", async () => {
  const l = listing();
  const grade = async (src: ChainSource, d = docs()) => (await chainRegistry(src, memoryDocStore({ [l.address]: d })).list())[0]?.report?.grade ?? null;
  assert.equal(await grade(source([l])), "A");
  assert.equal(await grade(source([l]), docs(undefined, canonicalize({ ...REPORT, grade: "B" } as unknown as Json))), null); // edited report
  assert.equal(await grade(source([l], [])), null); // assessor delisted
  assert.equal(await grade(source([listing({ assessedAt: 0n })])), null); // never attested
});

test("inactive listings are left out of the list", async () => {
  const l = listing({ active: false });
  assert.deepEqual(await chainRegistry(source([l]), memoryDocStore({ [l.address]: docs() })).list(), []);
});

test("the RPC source decodes Listing, SellerRep and the assessor registry accounts", async () => {
  const addr = (s: string) => s as Address;
  const listingBytes = getListingEncoder().encode({
    seller: addr(SELLER), listingId: 7n, kind: ListingKind.Data, mint: addr(MINT), price: 5_000_000n, contentHash: new Uint8Array(32).fill(1),
    metaHash: metaHash(META), termsTemplateHash: new Uint8Array(32), assessor: addr(ASSESSOR), reportHash: new Uint8Array(32).fill(3),
    assessedAt: 9n, active: true, sales: 2n, createdAt: 8n, bump: 255,
  } as never);
  const decoded = decodeListingAccount("List1111111111111111111111111111111111111111", new Uint8Array(listingBytes));
  assert.deepEqual([decoded.seller, decoded.kind, decoded.price, decoded.assessor, decoded.active, decoded.sales], [SELLER, 0, 5_000_000n, ASSESSOR, true, 2n]);

  const b64 = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString("base64");
  const repBytes = getSellerRepEncoder().encode({ seller: addr(SELLER), mint: addr(MINT), ...REP, lastSettledAt: 1n, bump: 255 } as never);
  const regBytes = getAssessorRegistryEncoder().encode({ authority: addr(SELLER), assessors: [addr(ASSESSOR)], bump: 255 } as never);
  let accountCalls = 0;
  const rpc: MinimalRpc = {
    getProgramAccounts: () => ({ send: async () => [{ pubkey: addr("List1111111111111111111111111111111111111111"), account: { data: [b64(listingBytes), "base64"] } }] }),
    getAccountInfo: () => ({
      send: async () => {
        accountCalls++;
        return { value: { data: [b64(accountCalls === 1 ? repBytes : regBytes), "base64"] } };
      },
    }),
  };
  const src = rpcSource(rpc);
  assert.equal((await src.listings())[0]?.price, 5_000_000n);
  const rep = await src.sellerRep(SELLER, MINT); // u64 counts arrive as bigint; core's RepCounts accepts either
  assert.deepEqual([rep.completed, rep.distinctBuyers, rep.volume, rep.maxPairVolume].map(String), ["4", "3", "20000000", "10000000"]);
  assert.deepEqual(await src.assessors(), [ASSESSOR]);
  const empty = rpcSource({ ...rpc, getAccountInfo: () => ({ send: async () => ({ value: null }) }) });
  assert.equal(String((await empty.sellerRep(SELLER, MINT)).completed), "0");
  assert.deepEqual(await empty.assessors(), []);
});

test("listing documents on disk: only base58 names, never a path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  const l = listing();
  writeFileSync(join(dir, `${l.address}.json`), JSON.stringify(docs()));
  writeFileSync(join(dir, "secret.json"), JSON.stringify({ meta: "x" }));
  const store = fileDocStore(dir);
  assert.equal((await store.get(l.address))?.meta, canonicalListing(META));
  assert.equal(await store.get("../secret"), null);
  assert.equal(await store.get("secret"), null);
  assert.equal(await store.get("Missing1111111111111111111111111111111111111"), null);
});
