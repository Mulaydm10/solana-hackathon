// Key pickup for browser buyers (#125): the wallet authorizes a one-time x25519 key; custody seals to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58Encode } from "@deal/core";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import {
  createCustody, keyRequestMessage, MAX_KEY_REQUEST_SECS, openWithX25519, verifyKeyRequest, type DealFacts, type KeyRequest,
} from "../src/index.ts";

const NOW = 1_800_000_000;
const DATA = new TextEncoder().encode("hour,price\n0,81.2\n1,79.5\n");
const wallet = () => {
  const seed = new Uint8Array(randomBytes(32));
  return { seed, address: base58Encode(ed25519.getPublicKey(seed)) };
};
const ephemeral = () => {
  const secret = x25519.utils.randomSecretKey();
  return { secret, pub: bytesToHex(x25519.getPublicKey(secret)) };
};
const sign = (r: KeyRequest, seed: Uint8Array) => ed25519.sign(keyRequestMessage(r), seed);
const why = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

test("the signed message names cluster, program, deal, ephemeral key and expiry, in that order", () => {
  const msg = new TextDecoder().decode(keyRequestMessage({ deal: "D1", ephemeralPub: "ab".repeat(32), expires: NOW + 60 }));
  assert.equal(msg, `deal-key-request-v1\ndevnet\n${DEAL_ESCROW_PROGRAM_ADDRESS}\nD1\n${"ab".repeat(32)}\n${NOW + 60}`);
});

test("verifyKeyRequest: wrong signer, expired, too far ahead, tampered key, other cluster are refused", () => {
  const buyer = wallet();
  const e = ephemeral();
  const r: KeyRequest = { deal: "D1", ephemeralPub: e.pub, expires: NOW + 300 };
  assert.ok(verifyKeyRequest(r, sign(r, buyer.seed), buyer.address, NOW).ok);
  assert.equal(why(verifyKeyRequest(r, sign(r, wallet().seed), buyer.address, NOW)), "BAD_SIGNATURE");
  assert.equal(why(verifyKeyRequest(r, sign(r, buyer.seed), buyer.address, NOW + 300)), "REQUEST_EXPIRED");
  const far = { ...r, expires: NOW + MAX_KEY_REQUEST_SECS + 1 };
  assert.equal(why(verifyKeyRequest(far, sign(far, buyer.seed), buyer.address, NOW)), "REQUEST_TOO_LONG");
  // The attacker swaps in their own ephemeral key after the buyer signed.
  assert.equal(why(verifyKeyRequest({ ...r, ephemeralPub: ephemeral().pub }, sign(r, buyer.seed), buyer.address, NOW)), "BAD_SIGNATURE");
  // A signature made for mainnet or another program does not work here.
  assert.equal(why(verifyKeyRequest(r, sign({ ...r, cluster: "mainnet-beta" }, buyer.seed), buyer.address, NOW)), "BAD_SIGNATURE");
  assert.equal(why(verifyKeyRequest(r, sign({ ...r, programId: "Other1111111111111111111111111111111111111" }, buyer.seed), buyer.address, NOW)), "BAD_SIGNATURE");
  assert.equal(why(verifyKeyRequest({ ...r, ephemeralPub: "zz" }, sign(r, buyer.seed), buyer.address, NOW)), "BAD_REQUEST");
});

function setup() {
  const buyer = wallet();
  const deals: Record<string, DealFacts> = {};
  const custody = createCustody({ readDeal: async (d) => deals[d] ?? null, now: () => NOW });
  const { ciphertext, contentHash } = custody.store("L1", DATA);
  deals.D1 = { status: "Delivered", buyer: buyer.address, listing: "L1" };
  return { buyer, deals, custody, ciphertext, contentHash };
}

test("a good request: the key is sealed to the ephemeral key, and the browser opens exactly the listed data", async () => {
  const { buyer, custody, ciphertext, contentHash } = setup();
  const e = ephemeral();
  const request: KeyRequest = { deal: "D1", ephemeralPub: e.pub, expires: NOW + 300 };
  const r = await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address, recipient: { request, signature: sign(request, buyer.seed) } });
  assert.ok(r.ok, JSON.stringify(r));
  const opened = openWithX25519(e.secret, r.sealedKey, ciphertext, { buyer: buyer.address, contentHash });
  assert.ok(opened.ok);
  assert.deepEqual(opened.data, DATA);
  assert.deepEqual(sha256(opened.data), contentHash);
  // The release record names the buyer's WALLET, never the ephemeral key.
  assert.equal(custody.releasedTo("D1"), buyer.address);
  assert.notEqual(custody.releasedTo("D1"), e.pub);
});

test("custody refuses: wrong signer, expired, other deal, tampered key, and nothing is recorded", async () => {
  const { buyer, deals, custody } = setup();
  deals.D2 = { status: "Delivered", buyer: buyer.address, listing: "L1" };
  const e = ephemeral();
  const req = (o: Partial<KeyRequest> = {}): KeyRequest => ({ deal: "D1", ephemeralPub: e.pub, expires: NOW + 300, ...o });
  const release = (request: KeyRequest, signature: Uint8Array, deal = "D1") =>
    custody.releaseKey({ listing: "L1", deal, buyer: buyer.address, recipient: { request, signature } }).then(why);
  assert.equal(await release(req(), sign(req(), wallet().seed)), "BAD_SIGNATURE");
  assert.equal(await release(req({ expires: NOW - 1 }), sign(req({ expires: NOW - 1 }), buyer.seed)), "REQUEST_EXPIRED");
  assert.equal(await release(req({ expires: NOW + 3_600 }), sign(req({ expires: NOW + 3_600 }), buyer.seed)), "REQUEST_TOO_LONG");
  // A request signed for deal D1 cannot unlock deal D2.
  assert.equal(await release(req(), sign(req(), buyer.seed), "D2"), "OTHER_DEAL");
  assert.equal(await release(req({ ephemeralPub: ephemeral().pub }), sign(req(), buyer.seed)), "BAD_SIGNATURE");
  assert.equal(custody.releasedTo("D1"), null);
  assert.equal(custody.releasedTo("D2"), null);
});

test("the chain check still comes first: someone else's request for my deal, or an unfunded deal, is refused", async () => {
  const { buyer, deals, custody } = setup();
  const stranger = wallet();
  const e = ephemeral();
  const request: KeyRequest = { deal: "D1", ephemeralPub: e.pub, expires: NOW + 300 };
  // A stranger signs a valid-looking request and names themselves as buyer: the chain says otherwise.
  assert.equal(why(await custody.releaseKey({ listing: "L1", deal: "D1", buyer: stranger.address, recipient: { request, signature: sign(request, stranger.seed) } })), "WRONG_BUYER");
  deals.D1 = { ...deals.D1!, status: "Refunded" };
  assert.equal(why(await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address, recipient: { request, signature: sign(request, buyer.seed) } })), "NOT_FUNDED");
});

test("a sealed key opens only with the matching ephemeral secret and binding", async () => {
  const { buyer, custody, ciphertext, contentHash } = setup();
  const e = ephemeral();
  const request: KeyRequest = { deal: "D1", ephemeralPub: e.pub, expires: NOW + 300 };
  const r = await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address, recipient: { request, signature: sign(request, buyer.seed) } });
  assert.ok(r.ok);
  assert.equal(why(openWithX25519(ephemeral().secret, r.sealedKey, ciphertext, { buyer: buyer.address, contentHash })), "TAMPERED");
  assert.equal(why(openWithX25519(e.secret, r.sealedKey, ciphertext, { buyer: wallet().address, contentHash })), "TAMPERED");
  assert.equal(why(openWithX25519(e.secret, r.sealedKey, ciphertext, { buyer: buyer.address, contentHash: sha256(new Uint8Array([1])) })), "TAMPERED");
  const bad = Uint8Array.from(r.sealedKey);
  bad[40]! ^= 1;
  assert.equal(why(openWithX25519(e.secret, bad, ciphertext, { buyer: buyer.address, contentHash })), "TAMPERED");
});

test("the wallet path is unchanged and records the wallet too", async () => {
  const { buyer, custody } = setup();
  assert.ok((await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address })).ok);
  assert.equal(custody.releasedTo("D1"), buyer.address);
});
