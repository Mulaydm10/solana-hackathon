// Browser side of key pickup (#111, #125): runs in the buyer's browser, so it uses WebCrypto AES-GCM and @noble
// x25519/HKDF, never node:crypto. Byte layout is exactly agents custody's (keyrequest.ts), checked by a shared
// test vector:
//   sealed key = version 2 (1) || sender ephemeral x25519 pub (32) || iv (12) || wrapped data key (32) || tag (16)
//   wrap AAD   = "deal-custody-bind-v1\n" || buyer ed25519 pub (32) || content hash (32)
//   ciphertext = iv (12) || encrypted data || tag (16), under the data key
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58Decode } from "@deal/core";

const VERSION = 2;
const IV = 12;
const TAG = 16;
const KEY = 32;
const INFO = new TextEncoder().encode("deal-custody-key-v1");

/** A one-time x25519 key pair for one pickup; the secret never leaves this page's memory. */
export function ephemeralKeyPair(): { secret: Uint8Array; pubHex: string } {
  const secret = x25519.utils.randomSecretKey();
  return { secret, pubHex: bytesToHex(x25519.getPublicKey(secret)) };
}

/** The exact bytes the wallet signs; must equal agents `keyRequestMessage` (tested). */
export function keyRequestMessage(r: { cluster: string; programId: string; deal: string; ephemeralPub: string; expires: number }): Uint8Array {
  return new TextEncoder().encode(["deal-key-request-v1", r.cluster, r.programId, r.deal, r.ephemeralPub, String(r.expires)].join("\n"));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function gcmOpen(key: Uint8Array, box: Uint8Array, aad?: Uint8Array): Promise<Uint8Array | null> {
  if (box.length < IV + TAG) return null;
  try {
    // WebCrypto takes ArrayBuffer-backed views: copy each input (also detaches it from any shared buffer).
    const own = (b: Uint8Array) => new Uint8Array(b);
    const k = await crypto.subtle.importKey("raw", own(key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: own(box.subarray(0, IV)), ...(aad ? { additionalData: own(aad) } : {}), tagLength: 128 }, k, own(box.subarray(IV)),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

export type Opened = { ok: true; data: Uint8Array } | { ok: false; reason: "BAD_INPUT" | "TAMPERED" | "CONTENT_MISMATCH"; message: string };

/** Opens the sealed key with the one-time secret, decrypts the data and checks it against the on-chain content hash. */
export async function openSealed(secret: Uint8Array, sealedKey: Uint8Array, ciphertext: Uint8Array, binding: { buyer: string; contentHashHex: string }): Promise<Opened> {
  const buyerEd = base58Decode(binding.buyer);
  if (secret.length !== 32 || !buyerEd || buyerEd.length !== 32 || !/^[0-9a-f]{64}$/.test(binding.contentHashHex)) {
    return { ok: false, reason: "BAD_INPUT", message: "missing buyer or content hash" };
  }
  if (sealedKey.length !== 1 + 32 + IV + KEY + TAG || sealedKey[0] !== VERSION) return { ok: false, reason: "TAMPERED", message: "the sealed key is not in the expected format" };
  const contentHash = Uint8Array.from(binding.contentHashHex.match(/../g)!, (b) => parseInt(b, 16));
  const ephPub = sealedKey.subarray(1, 33);
  const mine = x25519.getPublicKey(secret);
  const kek = hkdf(sha256, x25519.getSharedSecret(secret, ephPub), concat(ephPub, mine), INFO, KEY);
  const aad = concat(new TextEncoder().encode("deal-custody-bind-v1\n"), buyerEd, contentHash);
  const key = await gcmOpen(kek, sealedKey.subarray(33), aad);
  if (!key) return { ok: false, reason: "TAMPERED", message: "this key was not sealed to this page for this buyer and content" };
  const data = await gcmOpen(key, ciphertext);
  if (!data) return { ok: false, reason: "TAMPERED", message: "the stored data was changed" };
  if (bytesToHex(sha256(data)) !== binding.contentHashHex) return { ok: false, reason: "CONTENT_MISMATCH", message: "the data is not what the listing committed to on chain" };
  return { ok: true, data };
}
