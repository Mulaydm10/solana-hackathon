/**
 * Strict schemas for the quarantined reader (PLAN §7). A schema says exactly which fields come out of
 * untrusted text and what each may hold; everything else is refused, never passed through. Text fields
 * must be plain visible text (core `isPlainText`), amounts are bigint base units from decimal strings,
 * and objects refuse unknown keys, so nothing unvetted can ride along to the planner.
 */
import { HEX32, isPlainText } from "@deal/core";

export type Path = string;
export type SchemaError = { path: Path; problem: string };
type Check<T> = (v: unknown, path: Path) => { ok: true; value: T } | { ok: false; error: SchemaError };

export type Schema<T> = { readonly check: Check<T>; /** For docs and the Claude reader's prompt later. */ readonly describe: string };
export type Infer<S> = S extends Schema<infer T> ? T : never;

const bad = (path: Path, problem: string) => ({ ok: false as const, error: { path, problem } });
const good = <T>(value: T) => ({ ok: true as const, value });
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const s = {
  /** Visible text only, up to `max` characters; `multiline` allows newlines and tabs. */
  text(o: { max: number; multiline?: boolean }): Schema<string> {
    return {
      describe: `text(max ${o.max})`,
      check: (v, p) => (isPlainText(v, o.max, o.multiline) ? good(v) : bad(p, `must be visible text of at most ${o.max} characters`)),
    };
  },
  /** One of a closed set of strings. */
  oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
    return {
      describe: `oneOf(${values.join("|")})`,
      check: (v, p) => (typeof v === "string" && values.includes(v) ? good(v as T[number]) : bad(p, `must be one of ${values.join(", ")}`)),
    };
  },
  /** A safe integer in [min, max]. */
  int(o: { min: number; max: number }): Schema<number> {
    return {
      describe: `int(${o.min}..${o.max})`,
      check: (v, p) => (Number.isSafeInteger(v) && (v as number) >= o.min && (v as number) <= o.max ? good(v as number) : bad(p, `must be an integer from ${o.min} to ${o.max}`)),
    };
  },
  /** Token base units, written as a plain decimal string ("1500000"); no exponents, signs or hex. */
  amount(o: { max: bigint }): Schema<bigint> {
    return {
      describe: `amount(<= ${o.max})`,
      check: (v, p) => {
        if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v)) return bad(p, "must be a decimal string of base units");
        const b = BigInt(v);
        return b <= o.max ? good(b) : bad(p, `must be at most ${o.max}`);
      },
    };
  },
  bool(): Schema<boolean> {
    return { describe: "bool", check: (v, p) => (typeof v === "boolean" ? good(v) : bad(p, "must be true or false")) };
  },
  hex32(): Schema<string> {
    return { describe: "hex32", check: (v, p) => (typeof v === "string" && HEX32.test(v) ? good(v) : bad(p, "must be 64 lowercase hex characters")) };
  },
  /** A base58 Solana address (shape only; the chain checks the key). */
  address(): Schema<string> {
    return { describe: "address", check: (v, p) => (typeof v === "string" && BASE58.test(v) ? good(v) : bad(p, "must be a base58 address")) };
  },
  array<T>(item: Schema<T>, o: { max: number }): Schema<T[]> {
    return {
      describe: `array(${item.describe}, max ${o.max})`,
      check: (v, p) => {
        if (!Array.isArray(v) || v.length > o.max) return bad(p, `must be a list of at most ${o.max}`);
        const out: T[] = [];
        for (const [i, x] of v.entries()) {
          const r = item.check(x, `${p}[${i}]`);
          if (!r.ok) return r;
          out.push(r.value);
        }
        return good(out);
      },
    };
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> & { optional: true } {
    return { optional: true, describe: `optional(${inner.describe})`, check: (v, p) => (v === undefined ? good(undefined) : inner.check(v, p)) };
  },
  /** Exactly these keys (optional ones may be missing); anything else is refused. */
  object<F extends Record<string, Schema<unknown>>>(fields: F): Schema<{ [K in keyof F]: Infer<F[K]> }> {
    return {
      describe: `object{${Object.entries(fields).map(([k, f]) => `${k}: ${f.describe}`).join(", ")}}`,
      check: (v, p) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) return bad(p, "must be an object");
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) if (!Object.hasOwn(fields, k)) return bad(`${p}.${k}`, "is not an allowed field");
        const out: Record<string, unknown> = {};
        for (const [k, f] of Object.entries(fields)) {
          const has = Object.hasOwn(o, k);
          if (!has && !("optional" in f)) return bad(`${p}.${k}`, "is missing");
          const r = f.check(has ? o[k] : undefined, `${p}.${k}`);
          if (!r.ok) return r;
          if (r.value !== undefined) out[k] = r.value;
        }
        return good(out as { [K in keyof F]: Infer<F[K]> });
      },
    };
  },
};

/**
 * True when some JSON object in `text` repeats a key. `JSON.parse` keeps the last one silently, so a payload
 * like {"price":"1", ..., "price":"999"} could show one value to a human and hand another to code.
 * A small scanner over the token stream; it assumes `text` already parsed as JSON.
 */
export function hasDuplicateKeys(text: string): boolean {
  // One frame per open "{" or "["; only object frames collect keys. In an object, a string is a key when
  // it comes right after "{" or ",", and a value otherwise.
  const stack: { object: boolean; keys: Set<string>; expectKey: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const top = stack[stack.length - 1];
    if (c === "{" || c === "[") stack.push({ object: c === "{", keys: new Set(), expectKey: c === "{" });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && top?.object) top.expectKey = true;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (top?.object && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return false;
}
