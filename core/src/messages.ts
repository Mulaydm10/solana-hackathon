/**
 * Typed inter-agent messages (PLAN §3, §7). Agents talk only in these: a closed set of types, each with a
 * strict body, signed with the sender's ed25519 key (its Solana wallet key). Anything that does not parse,
 * has an unknown field, a bad signature, the wrong mission or an unknown sender is dropped: free text inside
 * a body is data to show, never a command to follow.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalize, hasOnlyKeys, HEX32, isObject, isPlainText, SLUG, type Json } from "./canonical.ts";
import type { Result } from "./terms.ts";

export const MESSAGE_TYPES = ["task", "result", "need-approval", "report"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const APPROVAL_REASONS = ["STAGE_GATE", "OVER_CAP", "NEW_PAYEE", "ELEVATED_CAPABILITY"] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

export type TaskBody = { taskId: string; to: string; inputHash: string; summary: string };
export type ResultBody = { taskId: string; ok: boolean; outputHash: string; summary: string };
export type NeedApprovalBody = { taskId: string; reason: ApprovalReason; amount?: string; planHash?: string };
export type ReportBody = { summary: string; spent: string; receipts: string[] };

type Bodies = { task: TaskBody; result: ResultBody; "need-approval": NeedApprovalBody; report: ReportBody };

export type UnsignedMessage<T extends MessageType = MessageType> = {
  [K in T]: {
    type: K;
    /** Sender's ed25519 public key, base58 (its Solana address). */
    from: string;
    /** Mission account address, base58. */
    mission: string;
    stage: number;
    /** Per-sender counter; receivers drop anything not above the last seq they accepted from that sender. */
    seq: number;
    body: Bodies[K];
  };
}[T];

export type Message<T extends MessageType = MessageType> = UnsignedMessage<T> & { /** 64-byte ed25519 signature, hex. */ sig: string };

export type MessageRefusal =
  | "TOO_LARGE"
  | "UNPARSEABLE"
  | "BAD_SHAPE"
  | "UNKNOWN_TYPE"
  | "BAD_BODY"
  | "BAD_SIGNATURE"
  | "WRONG_MISSION"
  | "UNKNOWN_SENDER"
  | "REPLAYED";

export const MAX_MESSAGE_BYTES = 16_384;
const DOMAIN = "deal-agent-msg-v1\n";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

// ---- base58 (Bitcoin alphabet, as Solana addresses) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** null on any character outside the alphabet. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A 32-byte key in its one canonical base58 spelling (so one key can't appear under two names). */
const isKey = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length > 44) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32 && base58Encode(b) === s;
};

/** The exact bytes that are signed: a domain prefix (so a message signature is never valid for anything else)
 * plus the canonical JSON of everything except `sig`. */
export function signingBytes(m: UnsignedMessage<MessageType>): Uint8Array {
  const { type, from, mission, stage, seq, body } = m as UnsignedMessage;
  return new TextEncoder().encode(DOMAIN + canonicalize({ type, from, mission, stage, seq, body } as unknown as Json));
}

/** `secretKey` is the 32-byte ed25519 seed (the first half of a Solana 64-byte secret key). */
export function signMessage<T extends MessageType>(m: UnsignedMessage<T>, secretKey: Uint8Array): Message<T> {
  return { ...m, sig: bytesToHex(ed25519.sign(signingBytes(m as UnsignedMessage), secretKey.slice(0, 32))) } as Message<T>;
}

export function publicKeyOf(secretKey: Uint8Array): string {
  return base58Encode(ed25519.getPublicKey(secretKey.slice(0, 32)));
}

function bodyOk(type: MessageType, b: unknown): boolean {
  if (!isObject(b)) return false;
  switch (type) {
    case "task":
      return hasOnlyKeys(b, ["taskId", "to", "inputHash", "summary"]) && typeof b.taskId === "string" && ID.test(b.taskId)
        && typeof b.to === "string" && SLUG.test(b.to) && typeof b.inputHash === "string" && HEX32.test(b.inputHash)
        && isPlainText(b.summary, 500, true);
    case "result":
      return hasOnlyKeys(b, ["taskId", "ok", "outputHash", "summary"]) && typeof b.taskId === "string" && ID.test(b.taskId)
        && typeof b.ok === "boolean" && typeof b.outputHash === "string" && HEX32.test(b.outputHash)
        && isPlainText(b.summary, 500, true);
    case "need-approval":
      return hasOnlyKeys(b, ["taskId", "reason"], ["amount", "planHash"]) && typeof b.taskId === "string" && ID.test(b.taskId)
        && APPROVAL_REASONS.includes(b.reason as ApprovalReason)
        && (b.amount === undefined || (typeof b.amount === "string" && DECIMAL.test(b.amount)))
        && (b.planHash === undefined || (typeof b.planHash === "string" && HEX32.test(b.planHash)));
    case "report":
      return hasOnlyKeys(b, ["summary", "spent", "receipts"]) && isPlainText(b.summary, 2_000, true)
        && typeof b.spent === "string" && DECIMAL.test(b.spent) && Array.isArray(b.receipts) && b.receipts.length <= 64
        && b.receipts.every((r) => typeof r === "string" && HEX32.test(r));
  }
}

export type OpenOpts = {
  /** The mission this receiver works for. */
  mission: string;
  /** Senders allowed on this mission (the mandate agents and the orchestrator). */
  senders: readonly string[];
  /** Last accepted seq per sender; when given, a message at or below it is REPLAYED. */
  lastSeq?: ReadonlyMap<string, number>;
};

/**
 * Parse, check and verify a raw message (a JSON string or an already-parsed value). Never throws; every
 * failure is a refusal the caller drops. Unknown fields anywhere are refused, so nothing unsigned rides along.
 */
export function openMessage(raw: unknown, opts: OpenOpts): Result<Message, MessageRefusal> {
  const fail = (reason: MessageRefusal) => ({ ok: false as const, reason });
  let v: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_MESSAGE_BYTES) return fail("TOO_LARGE");
    try {
      v = JSON.parse(raw);
    } catch {
      return fail("UNPARSEABLE");
    }
  }
  if (!isObject(v) || !hasOnlyKeys(v, ["type", "from", "mission", "stage", "seq", "body", "sig"])) return fail("BAD_SHAPE");
  if (!MESSAGE_TYPES.includes(v.type as MessageType)) return fail("UNKNOWN_TYPE");
  if (!isKey(v.from) || !isKey(v.mission)) return fail("BAD_SHAPE");
  if (!Number.isSafeInteger(v.stage) || (v.stage as number) < 0 || (v.stage as number) > 7) return fail("BAD_SHAPE");
  if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 0) return fail("BAD_SHAPE");
  if (typeof v.sig !== "string" || !/^[0-9a-f]{128}$/.test(v.sig)) return fail("BAD_SHAPE");
  if (!bodyOk(v.type as MessageType, v.body)) return fail("BAD_BODY");

  const m = v as unknown as Message;
  let valid = false;
  try {
    valid = ed25519.verify(hexToBytes(m.sig), signingBytes(m), base58Decode(m.from)!);
  } catch {
    valid = false;
  }
  if (!valid) return fail("BAD_SIGNATURE");
  if (m.mission !== opts.mission) return fail("WRONG_MISSION");
  if (!opts.senders.includes(m.from)) return fail("UNKNOWN_SENDER");
  const last = opts.lastSeq?.get(m.from);
  if (last !== undefined && m.seq <= last) return fail("REPLAYED");
  return { ok: true, value: m };
}
