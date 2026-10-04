// Encrypted custody (PLAN §4.2, #67).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode } from "@deal/core";
import { createCustody, openFor, sampleForAssessment, seal, sealKeyTo } from "../src/index.ts";

const wallet = () => {
  const seed = new Uint8Array(randomBytes(32));
  return { address: base58Encode(ed25519.getPublicKey(seed)), seed, solanaSecret: new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]) };
};
const DATA = new TextEncoder().encode("hour,price_eur_mwh\n0,81.2\n1,79.5\n2,77.0\n");
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

test("round trip: the buyer opens exactly the listed data, with a 32- or 64-byte secret", () => {
  const buyer = wallet();
  const s = seal(DATA);
  assert.deepEqual(s.contentHash, sha256(DATA));
  assert.ok(!Buffer.from(s.ciphertext).includes(Buffer.from("price_eur_mwh")), "ciphertext leaks plaintext");
  const sk = sealKeyTo(buyer.address, s.key, s.contentHash);
  for (const secret of [buyer.seed, buyer.solanaSecret]) {
    const r = openFor(secret, sk, s.ciphertext, s.contentHash);
    assert.ok(r.ok);
    assert.deepEqual(r.data, DATA);
  }
});

test("a different wallet cannot open it", () => {
  const s = seal(DATA);
  const sk = sealKeyTo(wallet().address, s.key, s.contentHash);
  assert.equal(reason(openFor(wallet().seed, sk, s.ciphertext, s.contentHash)), "TAMPERED");
});

test("tampering is rejected: ciphertext, sealed key, or a key for other content", () => {
  const buyer = wallet();
  const s = seal(DATA);
  const sk = sealKeyTo(buyer.address, s.key, s.contentHash);
  for (const i of [0, 12, s.ciphertext.length - 1]) {
    const bad = Uint8Array.from(s.ciphertext);
    bad[i]! ^= 1;
    assert.equal(reason(openFor(buyer.seed, sk, bad, s.contentHash)), "TAMPERED", `ciphertext byte ${i}`);
  }
  for (const i of [0, 1, 40, sk.length - 1]) {
    const bad = Uint8Array.from(sk);
    bad[i]! ^= 1;
    assert.equal(reason(openFor(buyer.seed, bad, s.ciphertext, s.contentHash)), "TAMPERED", `sealed key byte ${i}`);
  }
  assert.equal(reason(openFor(buyer.seed, sk.subarray(0, 20), s.ciphertext, s.contentHash)), "TAMPERED");
  assert.equal(reason(openFor(buyer.seed, sk, s.ciphertext.subarray(0, 10), s.contentHash)), "TAMPERED");
  // The key is bound to the content hash: presenting it with another listing's hash fails.
  assert.equal(reason(openFor(buyer.seed, sk, s.ciphertext, sha256(new Uint8Array([1])))), "TAMPERED");
});

test("data that decrypts but is not the on-chain content is refused (seller swapped the file)", () => {
  const buyer = wallet();
  const listed = seal(DATA);
  const other = seal(new TextEncoder().encode("something else"));
  // A dishonest custodian wraps the other file's key but binds it to the listed hash.
  const sk = sealKeyTo(buyer.address, other.key, listed.contentHash);
  assert.equal(reason(openFor(buyer.seed, sk, other.ciphertext, listed.contentHash)), "CONTENT_MISMATCH");
});

test("each seal uses a fresh key and nonce; each key seal uses a fresh ephemeral key", () => {
  const a = seal(DATA);
  const b = seal(DATA);
  assert.notDeepEqual(a.key, b.key);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  const buyer = wallet();
  assert.notDeepEqual(sealKeyTo(buyer.address, a.key, a.contentHash), sealKeyTo(buyer.address, a.key, a.contentHash));
});

test("the ed25519 -> x25519 conversion matches noble's reference on both sides", () => {
  const buyer = wallet();
  const eph = x25519.utils.randomSecretKey();
  const fromPub = x25519.getSharedSecret(eph, ed25519.utils.toMontgomery(ed25519.getPublicKey(buyer.seed)));
  const fromSecret = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(buyer.seed), x25519.getPublicKey(eph));
  assert.deepEqual(fromPub, fromSecret);
});

test("the key is never released before the deal is Funded on chain", async () => {
  const funded = new Set<string>();
  const checks: string[] = [];
  const custody = createCustody({ isFunded: async (d) => (checks.push(d), funded.has(d)) });
  const buyer = wallet();
  const { ciphertext, contentHash } = custody.store("L1", DATA);
  assert.equal(reason(await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address })), "NOT_FUNDED");
  funded.add("D1");
  const r = await custody.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address });
  assert.ok(r.ok);
  assert.deepEqual((openFor(buyer.seed, r.sealedKey, ciphertext, contentHash) as { data: Uint8Array }).data, DATA);
  assert.deepEqual(checks, ["D1", "D1"]);
  assert.equal(reason(await custody.releaseKey({ listing: "nope", deal: "D1", buyer: buyer.address })), "NO_KEY");
  assert.equal(reason(await custody.releaseKey({ listing: "L1", deal: "D1", buyer: "not-a-wallet" })), "BAD_BUYER");
  // A chain read that fails counts as not funded.
  const flaky = createCustody({ isFunded: async () => { throw new Error("rpc down"); } });
  flaky.store("L1", DATA);
  assert.equal(reason(await flaky.releaseKey({ listing: "L1", deal: "D1", buyer: buyer.address })), "NOT_FUNDED");
});

test("sample-only assessment: the assessor gets a prefix; the full hash is what the listing commits to", () => {
  const s = sampleForAssessment(DATA, { lineBased: true, rows: 2 });
  assert.equal(new TextDecoder().decode(s.sample), "hour,price_eur_mwh\n0,81.2\n");
  assert.deepEqual(s.fullHash, sha256(DATA));
  assert.deepEqual(s.sampleHash, sha256(s.sample));
  assert.ok(s.shareBps > 0 && s.shareBps < 10_000);
  const b = sampleForAssessment(DATA, { lineBased: false, bytes: 5 });
  assert.equal(b.sample.length, 5);
  assert.equal(sampleForAssessment(DATA, { lineBased: true, rows: 1_000 }).shareBps, 10_000);
});
