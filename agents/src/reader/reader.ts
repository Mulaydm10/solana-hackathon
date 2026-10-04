/**
 * Quarantined reader (PLAN §7: "untrusted text never reaches an agent with tools"). Listings, endpoint
 * replies, web pages and other agents' output go through a Reader, which has no tools at all: it turns text
 * into exactly the fields a schema allows, or refuses. The planner only ever sees those fields.
 *
 * This is the deterministic reader (structured JSON in). The Claude reader of PLAN §11 implements the same
 * interface for unstructured text; its output still goes through the same schema check.
 */
import type { Ok, Refused } from "../broker/broker.ts";
import { hasDuplicateKeys, type Schema } from "./schema.ts";

/** Hints found in the raw text, for the audit log only. Decisions never depend on them. */
export type Signal =
  | "OVERRIDE_INSTRUCTIONS"
  | "ROLE_PLAY"
  | "TOOL_SYNTAX"
  | "MONEY_COMMAND"
  | "SECRET_REQUEST"
  | "HIDDEN_TEXT"
  | "CONTRADICTS_FIELDS"
  | "ADDRESS_IN_TEXT";

export interface Reader {
  read<T>(untrusted: string, schema: Schema<T>): Promise<Ok<{ value: T; signals: Signal[] }> | Refused>;
}

const SIGNALS: [Signal, RegExp][] = [
  ["OVERRIDE_INSTRUCTIONS", /\b(ignore|disregard|forget|override|bypass|skip)\b.{0,40}\b(instructions?|rules?|prompt|polic(y|ies)|previous|above|checks?|limits?)\b|\bpre-?approved\b/i],
  ["ROLE_PLAY", /\b(you are now|act as|system prompt|developer mode|new instructions)\b|^\s*(system|assistant)\s*:/im],
  ["TOOL_SYNTAX", /<\s*\/?\s*(tool|function|tool_use|invoke|antml)[\s>:]|"(tool_calls?|function_call)"\s*:/i],
  ["MONEY_COMMAND", /\b(transfer|send|pay|wire|approve|release)\b.{0,40}\b(all|funds?|usdc|sol|tokens?|wallet|balance|budget|purchase)\b|\bpayment\b.{0,20}\b(must|should)\b.{0,20}\bgo\b/i],
  ["CONTRADICTS_FIELDS", /\b(real|actual|true|correct)\s+(price|grade|seller|amount)\b|\b(price|grade)\s+(field\s+)?is\s+(a\s+)?(typo|wrong|outdated)\b|\bgrade\s+[a-d]\+/i],
  // An address inside prose ("pay to <address> instead"), not a field that is just an address.
  ["ADDRESS_IN_TEXT", /\S\s+[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\s+\S/],
  ["SECRET_REQUEST", /\b(private key|secret key|seed phrase|mnemonic|api[_ -]?key|credential|password)s?\b/i],
  ["HIDDEN_TEXT", /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/],
];

/** Signals in the raw text and in every decoded string value (JSON escaping hides quotes and newlines). */
export function signalsIn(text: string, parsed?: unknown): Signal[] {
  const strings: string[] = [text];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  if (parsed !== undefined) walk(parsed);
  else {
    try {
      walk(JSON.parse(text));
    } catch {
      // not JSON: the raw text is all there is
    }
  }
  // ADDRESS_IN_TEXT only looks at decoded values: the raw JSON always has addresses next to other tokens.
  return SIGNALS.filter(([sig, re]) => (sig === "ADDRESS_IN_TEXT" ? strings.slice(1) : strings).some((x) => re.test(x))).map(([sig]) => sig);
}

export function createDeterministicReader(o: { maxBytes?: number } = {}): Reader {
  const maxBytes = o.maxBytes ?? 65_536;
  const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });
  return {
    async read(untrusted, schema) {
      if (typeof untrusted !== "string") return refuse("NOT_TEXT", "input must be text");
      if (new TextEncoder().encode(untrusted).length > maxBytes) return refuse("TOO_LARGE", `input is over ${maxBytes} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(untrusted);
      } catch {
        return refuse("NOT_STRUCTURED", "input is not JSON; this reader only extracts fields from structured data");
      }
      if (hasDuplicateKeys(untrusted)) return refuse("DUPLICATE_KEY", "an object repeats a key; refusing rather than guessing which one counts");
      const r = schema.check(parsed, "$");
      if (!r.ok) return refuse("SCHEMA", `${r.error.path} ${r.error.problem}`);
      return { ok: true, value: r.value, signals: signalsIn(untrusted, parsed) };
    },
  };
}
