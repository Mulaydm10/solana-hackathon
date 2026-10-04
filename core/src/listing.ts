/**
 * Listing metadata (PLAN §2.2, §3). Name, description, category, tags and URI live off chain; the
 * on-chain `Listing.meta_hash` binds them, so the schema is strict: unknown fields are refused rather
 * than silently hashed, and text that could render differently from its bytes is refused.
 */
import { canonicalize, hasOnlyKeys, HEX32, isObject, isPlainText, sha256Bytes, SLUG } from "./canonical.ts";
import { describeRep, type RepScore } from "./rep.ts";
import { formatAmount, type Result } from "./terms.ts";

export type ListingKind = "Data" | "Service" | "Team";
export const LISTING_KINDS: readonly ListingKind[] = ["Data", "Service", "Team"];

export const DATA_FORMATS = ["csv", "json", "jsonl", "text", "markdown", "pdf", "image", "archive"] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

type Common = {
  name: string;
  description: string;
  /** Lowercase slug, e.g. "market-data". */
  category: string;
  tags: string[];
  /** Where more detail lives (https://, ipfs:// or ar://). */
  uri?: string;
};

export type DataMeta = Common & {
  kind: "Data";
  format: DataFormat;
  sizeBytes: number;
  rows?: number;
  columns?: string[];
};

/** A JSON Schema-like description; only its shape is checked here (an object), the probe checks behaviour. */
export type JsonSchema = { readonly [k: string]: unknown };

export type ServiceMeta = Common & {
  kind: "Service";
  /** https only. */
  endpoint: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export type TeamMeta = Common & {
  kind: "Team";
  /** sha256 hex of the canonical blueprint (blueprint.ts `blueprintHash`); also the listing's content hash. */
  blueprintHash: string;
  roles: string[];
  deliverable: string;
  maxDurationSecs: number;
};

export type ListingMeta = DataMeta | ServiceMeta | TeamMeta;

export type ListingRefusal =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_KIND"
  | "UNKNOWN_FIELD"
  | "BAD_NAME"
  | "BAD_DESCRIPTION"
  | "BAD_CATEGORY"
  | "BAD_TAGS"
  | "BAD_URI"
  | "BAD_FORMAT"
  | "BAD_SIZE"
  | "BAD_ROWS"
  | "BAD_COLUMNS"
  | "BAD_ENDPOINT"
  | "BAD_SCHEMA"
  | "BAD_BLUEPRINT_HASH"
  | "BAD_ROLES"
  | "BAD_DELIVERABLE"
  | "BAD_DURATION";

export const LISTING_LIMITS = {
  name: 80,
  description: 2_000,
  tags: 10,
  columns: 500,
  roles: 8,
  deliverable: 500,
  uri: 512,
  /** 30 days, the escrow's longest window. */
  maxDurationSecs: 30 * 86_400,
} as const;

const COMMON = ["kind", "name", "description", "category", "tags"] as const;
const FIELDS: Record<ListingKind, { required: readonly string[]; optional: readonly string[] }> = {
  Data: { required: [...COMMON, "format", "sizeBytes"], optional: ["uri", "rows", "columns"] },
  Service: { required: [...COMMON, "endpoint", "inputSchema", "outputSchema"], optional: ["uri"] },
  Team: { required: [...COMMON, "blueprintHash", "roles", "deliverable", "maxDurationSecs"], optional: ["uri"] },
};

const isCount = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;

function uniqueList(v: unknown, max: number, ok: (s: string) => boolean, min = 0): v is string[] {
  return Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => typeof s === "string" && ok(s))
    && new Set(v).size === v.length;
}

function isUrl(s: unknown, schemes: readonly string[]): boolean {
  if (typeof s !== "string" || s.length > LISTING_LIMITS.uri || !isPlainText(s, LISTING_LIMITS.uri)) return false;
  try {
    const u = new URL(s);
    return schemes.includes(u.protocol) && u.host.length > 0 && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Refusals are values. On success the value is the input, unchanged, now typed. */
export function validateListingMeta(meta: unknown): Result<ListingMeta, ListingRefusal> {
  const fail = (reason: ListingRefusal) => ({ ok: false as const, reason });
  if (!isObject(meta)) return fail("NOT_AN_OBJECT");
  const kind = meta.kind as ListingKind;
  if (!LISTING_KINDS.includes(kind)) return fail("UNKNOWN_KIND");
  if (!hasOnlyKeys(meta, FIELDS[kind].required, FIELDS[kind].optional)) return fail("UNKNOWN_FIELD");

  if (!isPlainText(meta.name, LISTING_LIMITS.name)) return fail("BAD_NAME");
  if (!isPlainText(meta.description, LISTING_LIMITS.description, true)) return fail("BAD_DESCRIPTION");
  if (typeof meta.category !== "string" || !SLUG.test(meta.category)) return fail("BAD_CATEGORY");
  if (!uniqueList(meta.tags, LISTING_LIMITS.tags, (t) => SLUG.test(t))) return fail("BAD_TAGS");
  if (meta.uri !== undefined && !isUrl(meta.uri, ["https:", "ipfs:", "ar:"])) return fail("BAD_URI");

  if (kind === "Data") {
    if (!DATA_FORMATS.includes(meta.format as DataFormat)) return fail("BAD_FORMAT");
    if (!isCount(meta.sizeBytes, 1)) return fail("BAD_SIZE");
    if (meta.rows !== undefined && !isCount(meta.rows)) return fail("BAD_ROWS");
    if (meta.columns !== undefined && !uniqueList(meta.columns, LISTING_LIMITS.columns, (c) => isPlainText(c, 128), 1)) {
      return fail("BAD_COLUMNS");
    }
  } else if (kind === "Service") {
    if (!isUrl(meta.endpoint, ["https:"])) return fail("BAD_ENDPOINT");
    if (!isObject(meta.inputSchema) || !isObject(meta.outputSchema)) return fail("BAD_SCHEMA");
  } else {
    if (typeof meta.blueprintHash !== "string" || !HEX32.test(meta.blueprintHash)) return fail("BAD_BLUEPRINT_HASH");
    if (!uniqueList(meta.roles, LISTING_LIMITS.roles, (r) => SLUG.test(r), 1)) return fail("BAD_ROLES");
    if (!isPlainText(meta.deliverable, LISTING_LIMITS.deliverable)) return fail("BAD_DELIVERABLE");
    if (!isCount(meta.maxDurationSecs, 1) || meta.maxDurationSecs > LISTING_LIMITS.maxDurationSecs) return fail("BAD_DURATION");
  }
  return { ok: true, value: meta as ListingMeta };
}

/** Canonical JSON of validated metadata (sorted keys at every depth). */
export function canonicalListing(meta: ListingMeta): string {
  return canonicalize(meta as never);
}

/** sha256 of `canonicalListing`; this is `Listing.meta_hash` on chain. */
export function metaHash(meta: ListingMeta): Uint8Array {
  return sha256Bytes(canonicalListing(meta));
}

export type ListingView = {
  meta: ListingMeta;
  /** Token base units; for a Service this is per call. */
  price: bigint;
  seller: string;
  /** From the assessor's attestation, if any. */
  grade?: "A" | "B" | "C" | "D";
  rep?: RepScore;
};

function size(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The plain-text summary a buyer approves. Seller-written text is always quoted, never interpreted. */
export function describeListing(l: ListingView, opts: { decimals: number; symbol: string }): string {
  const m = l.meta;
  const price = `${formatAmount(l.price, opts.decimals)} ${opts.symbol}`;
  const lines: string[] = [`${m.kind} listing "${m.name}" in ${m.category}, sold by ${l.seller}.`];
  if (m.kind === "Data") {
    const shape = [m.format.toUpperCase(), size(m.sizeBytes)];
    if (m.rows !== undefined) shape.push(`${m.rows} rows`);
    if (m.columns) shape.push(`${m.columns.length} columns`);
    lines.push(`You get the exact file that was assessed (${shape.join(", ")}) for ${price}.`);
  } else if (m.kind === "Service") {
    lines.push(`You pay ${price} per call to ${new URL(m.endpoint).host}; a call with no valid answer is not charged.`);
  } else {
    const days = Math.ceil(m.maxDurationSecs / 86_400);
    lines.push(`A team of ${m.roles.length} agent role${m.roles.length === 1 ? "" : "s"} (${m.roles.join(", ")}) delivers "${m.deliverable}" within ${days} day${days === 1 ? "" : "s"}, for a fee of ${price}.`);
  }
  lines.push(l.grade ? `Assessed grade: ${l.grade}.` : "Not assessed yet.");
  if (l.rep) lines.push(`Seller reputation: ${describeRep(l.rep)}.`);
  return lines.join(" ");
}
