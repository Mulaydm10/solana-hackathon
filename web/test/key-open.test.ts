// The browser key opener (lib/key-open.ts) against agents custody (#125): a pinned vector both must open, the
// signed message byte-for-byte equal, and a live round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58Encode } from "@deal/core";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import { keyRequestMessage as agentsMessage, openWithX25519, seal, sealKeyToX25519 } from "../../agents/src/custody/index.ts";
import { ephemeralKeyPair, keyRequestMessage, openSealed } from "../lib/key-open.ts";

// Produced once by agents custody (seal + sealKeyToX25519) with fixed keys; pinned here so neither side can drift.
const VECTOR = {
  buyer: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB",
  secret: "0909090909090909090909090909090909090909090909090909090909090909",
  contentHash: "aa1955c8f198f9f5362ec8b055a743256df74b8eea7f4ea54bb28000bbce6817",
  sealedKey: "023fc41153ada1a1626b86b7deefbda21d581ee5dcf869de7ae39b9196c00810719d9cb38066f9231191963ee9a6450cd35a9d8b4e0b8396e189fb967e24acaeec7dd44beff69d4014cb39e96827d14a4f59965ef4805ba57d53d44fb6",
  ciphertext: "04ebcefea299c0b19f58e35cb49e97b4a56d02a682cfd6e57a1248f22d5c6b70d51f2818eed19ffad1acd5127b37b6d8e4d69745b36cec92d8d4db7a50",
  plaintext: "shared vector: hour,price\n0,81.2\n",
};

test("shared vector: the browser opener and agents custody both open it to the same plaintext", async () => {
  const web = await openSealed(hexToBytes(VECTOR.secret), hexToBytes(VECTOR.sealedKey), hexToBytes(VECTOR.ciphertext), { buyer: VECTOR.buyer, contentHashHex: VECTOR.contentHash });
  assert.ok(web.ok);
  assert.equal(new TextDecoder().decode(web.data), VECTOR.plaintext);
  const agents = openWithX25519(hexToBytes(VECTOR.secret), hexToBytes(VECTOR.sealedKey), hexToBytes(VECTOR.ciphertext), { buyer: VECTOR.buyer, contentHash: hexToBytes(VECTOR.contentHash) });
  assert.ok(agents.ok);
  assert.deepEqual(agents.data, web.data);
  // The vector really is bound to its buyer and its hash.
  assert.equal((await openSealed(hexToBytes(VECTOR.secret), hexToBytes(VECTOR.sealedKey), hexToBytes(VECTOR.ciphertext), { buyer: base58Encode(new Uint8Array(32).fill(1)), contentHashHex: VECTOR.contentHash })).ok, false);
});

test("the browser signs exactly the bytes custody verifies", () => {
  const r = { cluster: "devnet", programId: DEAL_ESCROW_PROGRAM_ADDRESS, deal: "Dea1Address11111111111111111111111111111111", ephemeralPub: "ab".repeat(32), expires: 1_800_000_300 };
  assert.deepEqual(keyRequestMessage(r), agentsMessage(r));
});

test("live round trip: agents seals to a fresh ephemeral key, the browser opens; any change is refused", async () => {
  const buyer = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(3)));
  const e = ephemeralKeyPair();
  assert.equal(e.pubHex, bytesToHex(x25519.getPublicKey(e.secret)));
  const data = new TextEncoder().encode("a".repeat(5_000));
  const s = seal(data);
  const sealed = sealKeyToX25519(hexToBytes(e.pubHex), s.key, s.contentHash, buyer);
  const binding = { buyer, contentHashHex: bytesToHex(s.contentHash) };
  const ok = await openSealed(e.secret, sealed, s.ciphertext, binding);
  assert.ok(ok.ok);
  assert.deepEqual(ok.data, data);
  const flip = (b: Uint8Array, i: number) => { const c = Uint8Array.from(b); c[i]! ^= 1; return c; };
  assert.equal((await openSealed(ephemeralKeyPair().secret, sealed, s.ciphertext, binding)).ok, false);
  assert.equal((await openSealed(e.secret, flip(sealed, 50), s.ciphertext, binding)).ok, false);
  assert.equal((await openSealed(e.secret, sealed, flip(s.ciphertext, 20), binding)).ok, false);
  const other = seal(new TextEncoder().encode("other"));
  // A key for the right buyer but presented with another listing's ciphertext fails, and so does a wrong hash.
  assert.equal((await openSealed(e.secret, sealed, other.ciphertext, binding)).ok, false);
  const wrongHash = await openSealed(e.secret, sealed, s.ciphertext, { buyer, contentHashHex: "00".repeat(32) });
  assert.equal(wrongHash.ok ? "ok" : wrongHash.reason, "TAMPERED");
});
