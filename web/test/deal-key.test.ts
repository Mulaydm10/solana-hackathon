// Buy-flow server core (#111): key pickup and terms storage, judged on chain facts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58Encode, canonicalJson, sha256Hex, type DealTerms } from "@deal/core";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { seal } from "../../agents/src/custody/index.ts";
import { keyReleasedTo, pickupKey, storeTerms, type DealDeps } from "../lib/deal-key.ts";
import type { DealView } from "../lib/deal-read.ts";
import { ephemeralKeyPair, keyRequestMessage, openSealed } from "../lib/key-open.ts";

const NOW = 1_800_000_000;
const DEAL = "Dea1Address11111111111111111111111111111111";
const LISTING = "L1st1ngAddress11111111111111111111111111111";
const DATA = new TextEncoder().encode("hour,price\n0,81.2\n");

function memBlobs() {
  const m = new Map<string, Uint8Array>();
  return { m, read: async (n: string) => m.get(n) ?? null, write: async (n: string, b: Uint8Array) => void m.set(n, b) };
}

function world(status = "Delivered") {
  const seed = new Uint8Array(randomBytes(32));
  const buyer = base58Encode(ed25519.getPublicKey(seed));
  const s = seal(DATA);
  const blobs = memBlobs();
  const view: DealView = {
    deal: DEAL, buyer, seller: base58Encode(randomBytes(32)), mint: base58Encode(randomBytes(32)), verifier: base58Encode(randomBytes(32)), status,
    amount: "6000000", stakeRequired: "0", bondBps: 1000, deadline: NOW + 3600, reviewSecs: 86_400, deliveredAt: NOW - 10,
    termsHash: "00".repeat(32), deliveryHash: bytesToHex(s.contentHash), listing: LISTING, expectedDeliveryHash: bytesToHex(s.contentHash),
  };
  const deps: DealDeps = {
    readDeal: async (d) => (d === DEAL ? view : null),
    keys: { get: async (l) => (l === LISTING ? { key: s.key, contentHash: s.contentHash } : undefined) },
    ciphertext: async (l) => (l === LISTING ? s.ciphertext : null),
    blobs, cluster: "devnet", now: () => NOW,
  };
  const request = (o: { cluster?: string; programId?: string; expires?: number; deal?: string; signer?: Uint8Array } = {}) => {
    const e = ephemeralKeyPair();
    const expires = o.expires ?? NOW + 300;
    const msg = keyRequestMessage({ cluster: o.cluster ?? "devnet", programId: o.programId ?? DEAL_ESCROW_PROGRAM_ADDRESS, deal: o.deal ?? DEAL, ephemeralPub: e.pubHex, expires });
    return { e, body: { buyer, ephemeralPub: e.pubHex, expires, signature: bytesToHex(ed25519.sign(msg, o.signer ?? seed)) } };
  };
  return { view, deps, blobs, buyer, request, contentHash: s.contentHash };
}
const why = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

test("key pickup: after delivery, sealed to the page's one-time key; the browser opens the listed data; the wallet is recorded", async () => {
  const w = world();
  const { e, body } = w.request();
  const r = await pickupKey(w.deps, DEAL, body);
  assert.ok(r.ok, JSON.stringify(r));
  const opened = await openSealed(e.secret, Buffer.from(r.sealedKey, "base64"), Buffer.from(r.ciphertext, "base64"), { buyer: w.buyer, contentHashHex: r.contentHash });
  assert.ok(opened.ok);
  assert.deepEqual(opened.data, DATA);
  assert.equal(await keyReleasedTo(w.blobs, DEAL), w.buyer);
  assert.ok(!new TextDecoder().decode(w.blobs.m.get(`releases/${DEAL}.json`)!).includes(e.pubHex), "the record names the wallet, never the one-time key");
});

test("key pickup refusals: before delivery, wrong signer, expired, other deal, signed for another cluster or program", async () => {
  for (const status of ["Open", "Funded", "Refunded", "Cancelled"]) {
    const w = world(status);
    assert.equal(why(await pickupKey(w.deps, DEAL, w.request().body)), "NOT_DELIVERED", status);
  }
  const w = world();
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ signer: new Uint8Array(randomBytes(32)) }).body)), "BAD_SIGNATURE");
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ expires: NOW - 1 }).body)), "REQUEST_EXPIRED");
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ expires: NOW + 3_600 }).body)), "REQUEST_TOO_LONG");
  // The server pins its own cluster and program: a signature made for mainnet or another program fails.
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ cluster: "mainnet-beta" }).body)), "BAD_SIGNATURE");
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ programId: "Other1111111111111111111111111111111111111" }).body)), "BAD_SIGNATURE");
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request({ deal: "Other2222222222222222222222222222222222222" }).body)), "BAD_SIGNATURE");
  // A stranger signing for themselves: custody's own check against the chain's buyer.
  const strangerSeed = new Uint8Array(randomBytes(32));
  const stranger = { ...w.request({ signer: strangerSeed }).body, buyer: base58Encode(ed25519.getPublicKey(strangerSeed)) };
  assert.equal(why(await pickupKey(w.deps, DEAL, stranger)), "WRONG_BUYER");
  assert.equal(why(await pickupKey(w.deps, "nope", w.request().body)), "BAD_DEAL");
  assert.equal(why(await pickupKey(w.deps, DEAL, { ...w.request().body, signature: "zz" })), "BAD_REQUEST");
  assert.equal(await keyReleasedTo(w.blobs, DEAL), null, "nothing recorded for refused requests");
});

test("key pickup: a plain deal or a listing with nothing in custody has no key", async () => {
  const w = world();
  w.view.listing = null;
  assert.equal(why(await pickupKey(w.deps, DEAL, w.request().body)), "NO_LISTING");
  const v = world();
  v.deps.keys = { get: async () => undefined };
  assert.equal(why(await pickupKey(v.deps, DEAL, v.request().body)), "NO_KEY");
});

test("terms: stored only when canonical and hashing to the deal's on-chain terms hash", async () => {
  const w = world();
  const terms: DealTerms = { template: "pay_on_delivery", buyer: w.view.buyer, seller: w.view.seller, serviceId: LISTING, task: "Deliver the listed data", price: 6_000_000n, deadline: NOW + 3_600, reviewSecs: 86_400 };
  const text = canonicalJson(terms);
  assert.equal(why(await storeTerms(w.deps, DEAL, text)), "TERMS_MISMATCH"); // chain says another hash
  w.view.termsHash = sha256Hex(text);
  assert.equal(why(await storeTerms(w.deps, DEAL, text)), "ok");
  assert.equal(new TextDecoder().decode(w.blobs.m.get(`terms/${DEAL}.json`)!), text);
  assert.equal(why(await storeTerms(w.deps, DEAL, JSON.stringify(JSON.parse(text), null, 2))), "NOT_CANONICAL");
  const other = canonicalJson({ ...terms, buyer: base58Encode(randomBytes(32)) });
  w.view.termsHash = sha256Hex(other);
  assert.equal(why(await storeTerms(w.deps, DEAL, other)), "TERMS_MISMATCH"); // right hash, but names another buyer
  assert.equal(why(await storeTerms(w.deps, "nope", text)), "BAD_DEAL");
  assert.equal(why(await storeTerms(w.deps, DEAL, 42)), "BAD_REQUEST");
});
