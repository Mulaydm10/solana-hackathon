/**
 * Key pickup for browser buyers (#111, #125). A browser wallet never exposes its secret key, so the data key
 * cannot be sealed to the wallet itself. Instead:
 *   1. the browser makes a one-time x25519 key pair (in memory only);
 *   2. the wallet signs `keyRequestMessage(...)`, naming cluster, program, deal, that ephemeral public key and an
 *      expiry at most 10 minutes ahead (cluster + program so the signature is worthless anywhere else);
 *   3. custody checks the signature is the deal's buyer (`verifyKeyRequest`), runs the usual chain check, and
 *      seals the data key to the ephemeral key with the SAME binding as a wallet seal (buyer wallet + content hash);
 *   4. the browser opens it with the ephemeral secret (`openWithX25519`) and checks sha256 against the chain.
 * A replayed request only ever yields a key sealed to the honest buyer's own ephemeral key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58Decode } from "@deal/core";
import { DEAL_ESCROW_PROGRAM_ADDRESS } from "@deal/chain";
import type { Ok, Refused } from "../broker/broker.ts";

const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

/** Longest a key request may stay valid, seconds. */
export const MAX_KEY_REQUEST_SECS = 600;
/** Version byte of a key sealed to an ephemeral recipient (a wallet seal uses 1). */
export const RECIPIENT_VERSION = 2;

export type KeyRequest = {
  deal: string;
  /** The browser's one-time x25519 public key, 64 hex characters. */
  ephemeralPub: string;
  /** Unix seconds. */
  expires: number;
  cluster?: string;
  programId?: string;
};

/** The exact bytes the wallet signs (Wallet Standard `solana:signMessage`). */
export function keyRequestMessage(r: KeyRequest): Uint8Array {
  return new TextEncoder().encode(
    ["deal-key-request-v1", r.cluster ?? "devnet", r.programId ?? DEAL_ESCROW_PROGRAM_ADDRESS, r.deal, r.ephemeralPub, String(r.expires)].join("\n"),
  );
}

/** The request is well formed, not expired, at most 10 minutes ahead, and signed by `buyer`. Never throws. */
export function verifyKeyRequest(r: KeyRequest, signature: Uint8Array, buyer: string, now: number): Ok<{ recipientX25519: Uint8Array }> | Refused {
  if (!/^[0-9a-f]{64}$/.test(r.ephemeralPub)) return refuse("BAD_REQUEST", "the ephemeral key must be 64 hex characters");
  if (!Number.isSafeInteger(r.expires) || r.expires <= now) return refuse("REQUEST_EXPIRED", "the key request has expired; ask the wallet again");
  if (r.expires > now + MAX_KEY_REQUEST_SECS) return refuse("REQUEST_TOO_LONG", `a key request may be valid for at most ${MAX_KEY_REQUEST_SECS} s`);
  const pub = base58Decode(buyer);
  if (!pub || pub.length !== 32 || signature.length !== 64) return refuse("BAD_SIGNATURE", "the request is not signed by the deal's buyer");
  let ok = false;
  try {
    ok = ed25519.verify(signature, keyRequestMessage(r), pub);
  } catch {
    ok = false;
  }
  if (!ok) return refuse("BAD_SIGNATURE", "the request is not signed by the deal's buyer");
  return { ok: true, recipientX25519: hexToBytes(r.ephemeralPub) };
}

const KEY = 32;
const IV = 12;
const TAG = 16;
const INFO = new TextEncoder().encode("deal-custody-key-v1");

/** Same binding as a wallet seal: the deal's buyer wallet and the content hash (associated data). */
export const bindTo = (buyerEd: Uint8Array, contentHash: Uint8Array) =>
  new Uint8Array(Buffer.concat([Buffer.from("deal-custody-bind-v1\n"), buyerEd, contentHash]));

/** Seals `key` to an x25519 recipient: version (2) || sender ephemeral pub (32) || iv || wrapped key || tag. */
export function sealKeyToX25519(recipientX25519: Uint8Array, key: Uint8Array, contentHash: Uint8Array, buyerWallet: string): Uint8Array {
  const buyerEd = base58Decode(buyerWallet);
  if (!buyerEd || buyerEd.length !== 32) throw new TypeError("buyer wallet must be a base58 ed25519 public key");
  if (recipientX25519.length !== 32 || key.length !== KEY || contentHash.length !== 32) throw new TypeError("keys and content hash must be 32 bytes");
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const kek = hkdf(sha256, x25519.getSharedSecret(eph, recipientX25519), new Uint8Array(Buffer.concat([ephPub, recipientX25519])), INFO, KEY);
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(bindTo(buyerEd, contentHash));
  const body = Buffer.concat([c.update(key), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([RECIPIENT_VERSION]), ephPub, iv, body, c.getAuthTag()]));
}

/**
 * The browser's side: open a key sealed to the ephemeral key, decrypt the data, check it against the on-chain
 * content hash. `binding.buyer` is the deal's buyer wallet (what the seal is bound to). Never throws.
 */
export function openWithX25519(
  secret: Uint8Array, sealedKey: Uint8Array, ciphertext: Uint8Array, binding: { buyer: string; contentHash: Uint8Array },
): Ok<{ data: Uint8Array }> | Refused {
  try {
    const buyerEd = base58Decode(binding.buyer);
    if (secret.length !== 32 || !buyerEd || buyerEd.length !== 32 || binding.contentHash.length !== 32) return refuse("BAD_INPUT", "secret 32 bytes, buyer a wallet, content hash 32 bytes");
    if (sealedKey.length !== 1 + 32 + IV + KEY + TAG || sealedKey[0] !== RECIPIENT_VERSION) return refuse("TAMPERED", "the sealed key is not in the expected format");
    const ephPub = sealedKey.subarray(1, 33);
    const mine = x25519.getPublicKey(secret);
    const kek = hkdf(sha256, x25519.getSharedSecret(secret, ephPub), new Uint8Array(Buffer.concat([ephPub, mine])), INFO, KEY);
    const key = gcmOpen(kek, sealedKey.subarray(33), bindTo(buyerEd, binding.contentHash));
    if (!key) return refuse("TAMPERED", "this key was not sealed to this ephemeral key for this buyer and content");
    const data = gcmOpen(key, ciphertext);
    if (!data) return refuse("TAMPERED", "the ciphertext was changed or belongs to another listing");
    if (bytesToHex(sha256(data)) !== bytesToHex(binding.contentHash)) return refuse("CONTENT_MISMATCH", "the data does not match the on-chain content hash");
    return { ok: true, data };
  } catch {
    return refuse("TAMPERED", "the sealed key could not be opened");
  }
}

function gcmOpen(key: Uint8Array, box: Uint8Array, aad?: Uint8Array): Uint8Array | null {
  if (box.length < IV + TAG) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, box.subarray(0, IV));
    if (aad) d.setAAD(aad);
    d.setAuthTag(box.subarray(box.length - TAG));
    return new Uint8Array(Buffer.concat([d.update(box.subarray(IV, box.length - TAG)), d.final()]));
  } catch {
    return null;
  }
}
