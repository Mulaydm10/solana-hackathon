/**
 * Canonical JSON for anything that gets hashed (listing metadata, blueprints, mission terms, messages):
 * object keys sorted at every depth, bigint as a decimal string, `undefined` keys left out, array order
 * kept. Same value -> same bytes, in every JS engine.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type Json = null | boolean | number | string | bigint | readonly Json[] | { readonly [k: string]: Json | undefined };

export function canonicalize(value: Json): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: Json | undefined): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    // Callers validate first; a non-finite number here is a bug, not user input.
    if (!Number.isFinite(v)) throw new TypeError("canonicalize: non-finite number");
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v !== null && typeof v === "object") {
    const o = v as { readonly [k: string]: Json | undefined };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (o[k] !== undefined) out[k] = normalize(o[k]);
    }
    return out;
  }
  return v;
}

export function sha256Bytes(text: string): Uint8Array {
  return sha256(new TextEncoder().encode(text));
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256Bytes(text));
}

export const HEX32 = /^[0-9a-f]{64}$/;

/** Visible text only: no control characters (newline/tab allowed where `multiline`), no bidi overrides or
 * zero-width characters, which can make an approval screen show something other than what is hashed. */
export function isPlainText(s: unknown, max: number, multiline = false): s is string {
  if (typeof s !== "string" || s.trim().length === 0 || s.length > max) return false;
  const banned = multiline
    ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
    : /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
  return !banned.test(s);
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Exactly these keys (optional ones may be missing), nothing else. */
export function hasOnlyKeys(o: object, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
