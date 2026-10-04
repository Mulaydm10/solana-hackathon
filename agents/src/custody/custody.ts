/**
 * Encrypted data custody (PLAN §4.2). Only the content hash, the metadata and the assessment report are
 * public; the data itself is stored encrypted with a key per listing, and the key goes to a buyer only once
 * the escrow holds the buyer's money.
 *
 *   seal(data)                       -> AES-256-GCM ciphertext + a fresh 32-byte key + sha256(data)
 *   sealKeyTo(buyerWallet, key, ...) -> the key encrypted to the buyer's Solana wallet key: the ed25519 public
 *                                       key is converted to x25519, an ephemeral x25519 key agrees a secret
 *                                       with it, HKDF-SHA256 derives the wrapping key, AES-256-GCM wraps
 *   openFor(buyerSecret, sealedKey, ciphertext, expectedContentHash?)
 *                                    -> the data, or Refused: TAMPERED (wrong buyer, tampered key or data)
 *                                       or CONTENT_MISMATCH (decrypts, but sha256 is not the on-chain hash)
 *   createCustody({ readDeal })      -> releaseKey(...) only for a funded deal of this buyer, opened from this
 *                                       listing (all three read from chain, none taken from the request)
 *
 * The wrapped key is bound (as AES-GCM associated data) to the buyer's key and the content hash, so it cannot
 * be replayed for another buyer or for other data.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Decode } from "@deal/core";
import type { Ok, Refused } from "../broker/broker.ts";

const VERSION = 1;
const IV = 12;
const TAG = 16;
const KEY = 32;
const INFO = new TextEncoder().encode("deal-custody-key-v1");
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

export type Sealed = {
  /** iv (12) || ciphertext || tag (16). */
  ciphertext: Uint8Array;
  /** The per-listing key. Kept by the custody service, never published. */
  key: Uint8Array;
  /** sha256 of the plaintext: the listing's on-chain `content_hash`. */
  contentHash: Uint8Array;
};

function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return new Uint8Array(Buffer.concat([iv, body, c.getAuthTag()]));
}

/** null when the key is wrong or anything was changed. */
function gcmDecrypt(key: Uint8Array, box: Uint8Array, aad?: Uint8Array): Uint8Array | null {
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

export function seal(data: Uint8Array): Sealed {
  const key = new Uint8Array(randomBytes(KEY));
  return { ciphertext: gcmEncrypt(key, data), key, contentHash: sha256(data) };
}

const bindTo = (buyerEd: Uint8Array, contentHash: Uint8Array) =>
  new Uint8Array(Buffer.concat([Buffer.from("deal-custody-bind-v1\n"), buyerEd, contentHash]));

/**
 * Encrypts `key` to the buyer's wallet. Output: version (1) || ephemeral x25519 public key (32) || wrapped key.
 * `contentHash` is bound in, so the result only opens for this buyer and this data.
 */
export function sealKeyTo(buyerWallet: string, key: Uint8Array, contentHash: Uint8Array): Uint8Array {
  const buyerEd = base58Decode(buyerWallet);
  if (!buyerEd || buyerEd.length !== 32) throw new TypeError("buyer wallet must be a base58 ed25519 public key");
  if (key.length !== KEY || contentHash.length !== 32) throw new TypeError("key and content hash must be 32 bytes");
  const buyerX = ed25519.utils.toMontgomery(buyerEd);
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const kek = hkdf(sha256, x25519.getSharedSecret(eph, buyerX), new Uint8Array(Buffer.concat([ephPub, buyerX])), INFO, KEY);
  const wrapped = gcmEncrypt(kek, key, bindTo(buyerEd, contentHash));
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), ephPub, wrapped]));
}

/**
 * The buyer's side. `buyerSecret` is the 32-byte ed25519 seed (or a 64-byte Solana secret key).
 * `contentHash` is the listing's on-chain content hash: the key is bound to it and the data is checked against it.
 * Never throws.
 */
export function openFor(buyerSecret: Uint8Array, sealedKey: Uint8Array, ciphertext: Uint8Array, contentHash: Uint8Array): Ok<{ data: Uint8Array }> | Refused {
  try {
    if ((buyerSecret.length !== 32 && buyerSecret.length !== 64) || contentHash.length !== 32) return refuse("BAD_INPUT", "secret must be 32 or 64 bytes, content hash 32");
    if (sealedKey.length !== 1 + 32 + IV + KEY + TAG || sealedKey[0] !== VERSION) return refuse("TAMPERED", "the sealed key is not in the expected format");
    const seed = buyerSecret.subarray(0, 32);
    const buyerEd = ed25519.getPublicKey(seed);
    const buyerX = ed25519.utils.toMontgomery(buyerEd);
    const ephPub = sealedKey.subarray(1, 33);
    const kek = hkdf(sha256, x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(seed), ephPub), new Uint8Array(Buffer.concat([ephPub, buyerX])), INFO, KEY);
    const key = gcmDecrypt(kek, sealedKey.subarray(33), bindTo(buyerEd, contentHash));
    if (!key) return refuse("TAMPERED", "this key was not sealed to this wallet for this content, or it was changed");
    const data = gcmDecrypt(key, ciphertext);
    if (!data) return refuse("TAMPERED", "the ciphertext was changed or belongs to another listing");
    if (!Buffer.from(sha256(data)).equals(Buffer.from(contentHash))) return refuse("CONTENT_MISMATCH", "the data does not match the on-chain content hash");
    return { ok: true, data };
  } catch {
    return refuse("TAMPERED", "the sealed key could not be opened");
  }
}

/** What the chain says about a deal right now: `getDeal` plus its `DealLink` through @deal/chain (#66). */
export type DealFacts = {
  /** On-chain status name (chain STATUS_NAMES). */
  status: string;
  buyer: string;
  /** The listing from the deal's DealLink; null for a deal not opened from a listing. */
  listing: string | null;
};
export type ReadDeal = (deal: string) => Promise<DealFacts | null>;

/** The money is in escrow and the deal has not been unwound: Funded and every later state that pays the seller. */
export const KEY_RELEASE_STATUSES: readonly string[] = ["Funded", "Delivered", "Challenged", "Released", "Claimed", "VerifiedPass"];

export type KeyRelease = { listing: string; deal: string; buyer: string };

export type Custody = {
  /** Encrypts a listing's data; the key stays here, the ciphertext and hash are returned for storage. */
  store(listing: string, data: Uint8Array): { ciphertext: Uint8Array; contentHash: Uint8Array };
  /**
   * The key sealed to the deal's buyer, only when the chain says this deal is funded, belongs to this buyer,
   * and was opened from this listing. Nothing in the request is trusted on its own word.
   */
  releaseKey(r: KeyRelease): Promise<Ok<{ sealedKey: Uint8Array }> | Refused>;
};

export function createCustody(o: { readDeal: ReadDeal }): Custody {
  const keys = new Map<string, { key: Uint8Array; contentHash: Uint8Array }>();
  return {
    store(listing, data) {
      const s = seal(data);
      keys.set(listing, { key: s.key, contentHash: s.contentHash });
      return { ciphertext: s.ciphertext, contentHash: s.contentHash };
    },
    async releaseKey(r) {
      const k = keys.get(r.listing);
      if (!k) return refuse("NO_KEY", "no stored data for this listing");
      // A failed chain read counts as "no such deal".
      const facts = await o.readDeal(r.deal).catch(() => null);
      if (!facts) return refuse("NO_DEAL", "the chain shows no such deal");
      if (!KEY_RELEASE_STATUSES.includes(facts.status)) {
        return refuse("NOT_FUNDED", `the deal is ${facts.status}; the key is released only while the escrow holds the money`);
      }
      if (facts.buyer !== r.buyer) return refuse("WRONG_BUYER", "the key is sealed only to the deal's own buyer");
      if (facts.listing !== r.listing) return refuse("WRONG_LISTING", "this deal was not opened from this listing");
      try {
        return { ok: true, sealedKey: sealKeyTo(r.buyer, k.key, k.contentHash) };
      } catch {
        return refuse("BAD_BUYER", "the buyer is not a valid wallet key");
      }
    },
  };
}

// ---- sample-only assessment (PLAN §4.2 option 1): the assessor sees a sample, never the full data.

export type Sample = {
  mode: "sample";
  sample: Uint8Array;
  /** sha256 of the full data: what the listing commits to on chain. */
  fullHash: Uint8Array;
  sampleHash: Uint8Array;
  /** Share of the full data in the sample, basis points. */
  shareBps: number;
};

/** The first `rows` lines of line-based data (CSV keeps its header as line 1), or the first `bytes` of anything else. */
export function sampleForAssessment(data: Uint8Array, o: { lineBased: boolean; rows?: number; bytes?: number }): Sample {
  let end = Math.min(data.length, o.bytes ?? 65_536);
  if (o.lineBased) {
    let seen = 0;
    end = data.length;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 10 && ++seen === (o.rows ?? 100)) {
        end = i + 1;
        break;
      }
    }
  }
  const sample = data.slice(0, end);
  return { mode: "sample", sample, fullHash: sha256(data), sampleHash: sha256(sample), shareBps: data.length === 0 ? 10_000 : Math.floor((sample.length * 10_000) / data.length) };
}
