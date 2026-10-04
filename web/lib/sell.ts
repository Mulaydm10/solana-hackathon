// Server-only: the sell flow (#110, PLAN §4.1) as plain functions the /api/sell/* routes call with their deps.
//   draft   -> the seller chain step by step: classify, assess, price, draft terms; and what create_listing needs
//   custody -> takes the bytes only if sha256 equals the listing's ON-CHAIN content hash, encrypts them (the key goes
//              to the KeyVault, sealed; the ciphertext to the DocStore), and assesses them here, on the server
//   assess  -> the marketplace assessor attests its OWN report (from custody, or from probing the service), never
//              one sent by a client; it stores the listing's verified metadata and the report for the registry
// The seller signs create_listing in its own wallet; nothing here signs for the seller.
import { createHash } from "node:crypto";
import type { Address, TransactionSigner } from "@solana/kit";
import { getListing, listings, type DealContext } from "@deal/chain";
import { canonicalListing, canonicalize, metaHash, sha256Hex, validateListingMeta, type Comparable, type Json, type ListingMeta } from "@deal/core";
import { assess, classify, draftTerms, price, seal, type AssessmentReport, type ServiceInput } from "./agents-sell";
import type { KeyVault, WritableDocStore } from "./storage";

export const MAX_DATA_BYTES = 10 * 1024 * 1024;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

export type Reply = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } });
const no = (status: number, reason: string, message: string): Reply => ({ status, body: { ok: false, reason, message } });
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;

/** A service as the seller describes it (the same snake_case shape as mcp `publish_listing`). */
export type ServiceArgs = { endpoint: string; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>; example_input?: unknown };
const serviceInput = (s: ServiceArgs): ServiceInput => ({ endpoint: s.endpoint, inputSchema: s.input_schema, outputSchema: s.output_schema, exampleInput: s.example_input ?? {} });

function decodeData(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > Math.ceil(MAX_DATA_BYTES / 3) * 4 + 4) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return bytes.length > 0 && bytes.length <= MAX_DATA_BYTES ? bytes : null;
}

export type Probe = (url: string, init: RequestInit) => Promise<Response>;

/** The listing at an address, or null when there is none OR the account is something else (it would not decode). */
async function listingAt(ctx: DealContext, address: Address) {
  try {
    return await getListing(ctx, address);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------- draft

export type DraftInput = {
  seller: string; name: string; description: string; category: string; tags?: string[]; task?: string;
  /** Token base units as a decimal string; default: the suggestion's middle. */
  price?: string; deliveryHours?: number; reviewHours?: number;
  data?: string; service?: ServiceArgs;
};

export type DraftDeps = { assessor: Address; now: () => number; comparables?: (kind: "Data" | "Service") => Promise<Comparable[]>; probe?: Probe };

/** The seller chain on the seller's upload, step by step, and the create_listing parameters it leads to. */
export async function draftListing(d: DraftDeps, i: DraftInput): Promise<Reply> {
  if (!ADDRESS.test(i.seller ?? "")) return no(400, "BAD_INPUT", "seller must be a wallet address");
  if ((i.data === undefined) === (i.service === undefined)) return no(400, "BAD_INPUT", "give exactly one of data (base64) or service");
  const bytes = i.data !== undefined ? decodeData(i.data) : null;
  if (i.data !== undefined && !bytes) return no(413, "BAD_DATA", `data must be base64, 1 byte to ${MAX_DATA_BYTES} bytes`);
  const now = d.now();
  const steps: Record<string, unknown>[] = [];

  const c = classify(bytes ?? serviceInput(i.service!));
  steps.push({ step: "classify", kind: c.kind, ...(c.kind === "Data" ? { format: c.format, sizeBytes: c.sizeBytes, rows: c.table?.rows.length, columns: c.table?.columns } : {}), ...(c.kind === "Unknown" ? { reason: c.reason } : {}) });
  if (c.kind === "Unknown" || c.kind === "Team") return { status: 422, body: { ok: false, reason: "UNSUPPORTED", message: c.kind === "Team" ? "teams are listed from a blueprint" : c.reason, steps } };

  const a = await assess(c, bytes, { now, fetch: d.probe });
  if (!a.ok) return { status: 422, body: { ok: false, reason: a.reason, message: a.message, steps } };
  steps.push({ step: "assess", grade: a.report.grade, report: plain(a.report), reportHash: hex(a.reportHash), needsConfirmation: a.report.needsConfirmation });

  const suggestion = price(a.report, { comparables: (await d.comparables?.(c.kind).catch(() => [])) ?? [], seller: i.seller });
  steps.push({ step: "price", low: suggestion.low.toString(), mid: suggestion.mid.toString(), high: suggestion.high.toString(), reasons: suggestion.reasons });

  const chosen = i.price === undefined ? suggestion.mid : /^\d{1,15}$/.test(i.price) && BigInt(i.price) > 0n ? BigInt(i.price) : null;
  if (chosen === null) return { status: 400, body: { ok: false, reason: "BAD_PRICE", message: "price must be positive token base units", steps } };
  const task = i.task?.trim() || (c.kind === "Data" ? "Deliver the listed dataset exactly as assessed" : "Answer calls within the declared output schema");
  const terms = draftTerms({
    template: "pay_on_delivery", seller: i.seller, serviceId: `listing-${a.report.contentHash.slice(0, 16)}`, task, price: chosen,
    deliveryWindowSecs: (i.deliveryHours ?? 24) * 3600, reviewSecs: (i.reviewHours ?? 6) * 3600,
  }, now);
  if (!terms.ok) return { status: 422, body: { ok: false, reason: terms.reason, message: terms.message, steps } };
  steps.push({ step: "draft", terms: plain(terms.template), termsHash: hex(terms.templateHash) });

  const common = { name: i.name, description: i.description, category: i.category, tags: i.tags ?? [] };
  const meta = validateListingMeta(c.kind === "Data"
    ? { ...common, kind: "Data", format: c.format, sizeBytes: c.sizeBytes, ...(c.table ? { rows: c.table.rows.length, columns: c.table.columns } : {}) }
    : { ...common, kind: "Service", endpoint: c.endpoint, inputSchema: c.inputSchema, outputSchema: c.outputSchema });
  if (!meta.ok) return { status: 422, body: { ok: false, reason: meta.reason, message: "the listing description is not valid", steps } };

  return ok({
    steps,
    meta: plain(meta.value),
    needsConfirmation: a.report.needsConfirmation,
    // Everything create_listing takes; the seller's wallet signs it.
    listing: {
      kind: c.kind, price: chosen.toString(), contentHash: a.report.contentHash, metaHash: hex(metaHash(meta.value)),
      termsTemplateHash: hex(terms.templateHash), assessor: d.assessor,
    },
  });
}

// -------------------------------------------------------------------------------------------------- custody

export type ChainDeps = { ctx: DealContext; docs: WritableDocStore; keys: KeyVault; now: () => number };

/** POST /api/sell/custody { listing, seller, data }: the exact listed bytes only, checked against the chain. */
export async function acceptCustody(d: ChainDeps, b: { listing?: unknown; seller?: unknown; data?: unknown }): Promise<Reply> {
  if (typeof b.listing !== "string" || !ADDRESS.test(b.listing) || typeof b.seller !== "string" || !ADDRESS.test(b.seller)) {
    return no(400, "BAD_INPUT", "listing and seller must be addresses");
  }
  const bytes = decodeData(b.data);
  if (!bytes) return no(413, "BAD_DATA", `data must be base64, 1 byte to ${MAX_DATA_BYTES} bytes`);
  const l = await listingAt(d.ctx, b.listing as Address);
  if (!l) return no(404, "NOT_FOUND", "no listing at that address on chain");
  if (l.kind !== "Data") return no(409, "NOT_DATA", "only data listings have custody");
  if (l.seller !== b.seller) return no(403, "WRONG_SELLER", "this listing belongs to another seller");
  const contentHash = hex(await sha(bytes));
  if (contentHash !== l.contentHash) return no(422, "CONTENT_MISMATCH", "these bytes are not what the listing committed to on chain");
  if (await d.keys.get(b.listing)) return ok({ listing: b.listing, contentHash, stored: "already" });

  // The marketplace assessor sees the plaintext here, once (PLAN §4.2 honest limit), and keeps only its report.
  const c = classify(bytes);
  const a = c.kind === "Data" ? await assess(c, bytes, { now: d.now() }) : null;
  if (!a || !a.ok) return no(422, a ? a.reason : "UNSUPPORTED", a ? a.message : "the bytes are not recognised data");
  const sealed = seal(bytes);
  await d.docs.putCiphertext(b.listing, sealed.ciphertext);
  await d.keys.set(b.listing, { key: sealed.key, contentHash: sealed.contentHash });
  await d.docs.put(b.listing, { assessed: canonicalize(a.report as unknown as Json) });
  return ok({ listing: b.listing, contentHash, stored: "new", grade: a.report.grade });
}

const sha = async (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

// --------------------------------------------------------------------------------------------------- assess

export type AssessDeps = ChainDeps & { assessor: TransactionSigner; probe?: Probe };

/**
 * POST /api/sell/assess { listing, contentHash?, report?, reportHash?, meta?, service? } (mcp publish_listing sends
 * the first four). `report`/`reportHash` from the client are ignored: the assessor attests only its own report.
 */
export async function assessAndAttest(d: AssessDeps, b: { listing?: unknown; contentHash?: unknown; meta?: unknown; service?: unknown }): Promise<Reply> {
  if (typeof b.listing !== "string" || !ADDRESS.test(b.listing)) return no(400, "BAD_INPUT", "listing must be an address");
  const listing = b.listing as Address;
  const l = await listingAt(d.ctx, listing);
  if (!l) return no(404, "NOT_FOUND", "no listing at that address on chain");
  if (l.assessor !== d.assessor.address) return no(409, "NOT_OUR_LISTING", "this listing names another assessor");
  if (b.contentHash !== undefined && b.contentHash !== l.contentHash) return no(422, "CONTENT_MISMATCH", "contentHash is not the listing's on-chain content hash");

  // Metadata: accepted only if it hashes to the on-chain meta_hash; without it the registry does not show the listing.
  let meta: ListingMeta | null = null;
  if (b.meta !== undefined) {
    const v = validateListingMeta(typeof b.meta === "string" ? safeJson(b.meta) : b.meta);
    if (!v.ok || hex(metaHash(v.value)) !== l.metaHash) return no(422, "META_MISMATCH", "this metadata is not what the listing committed to on chain");
    meta = v.value;
    await d.docs.put(listing, { meta: canonicalListing(meta) });
  }

  let report: AssessmentReport;
  if (l.kind === "Data") {
    const assessed = (await d.docs.get(listing))?.assessed;
    if (!assessed) return no(409, "NO_DATA", "send the data to /api/sell/custody first");
    report = JSON.parse(assessed) as AssessmentReport;
  } else if (l.kind === "Service") {
    // The service's content hash covers endpoint and schemas only, so its verified metadata is enough to re-probe
    // it (what mcp publish_listing leaves behind); a full descriptor adds the example input for the probe.
    const stored = meta ?? verifiedStoredMeta((await d.docs.get(listing))?.meta, l.metaHash);
    const svc: ServiceArgs | null = isService(b.service) ? b.service
      : stored?.kind === "Service" ? { endpoint: stored.endpoint, input_schema: { ...stored.inputSchema }, output_schema: { ...stored.outputSchema } } : null;
    if (!svc) return no(422, "NEEDS_SERVICE_DESCRIPTOR", "send meta or service { endpoint, input_schema, output_schema, example_input } to re-assess it");
    const a = await assess(classify(serviceInput(svc)), null, { now: d.now(), fetch: d.probe });
    if (!a.ok) return no(422, a.reason, a.message);
    report = a.report;
  } else {
    return no(422, "UNSUPPORTED", "team listings are assessed from their blueprint");
  }
  if (report.contentHash !== l.contentHash) return no(422, "CONTENT_MISMATCH", "what the assessor assessed is not the listing's on-chain content");

  const reportCanonical = canonicalize(report as unknown as Json);
  const reportHash = sha256Hex(reportCanonical);
  const attested = await listings.attest(d.ctx, d.assessor, listing, hexBytes(l.contentHash), hexBytes(reportHash));
  if (!attested.ok) return no(502, attested.reason, attested.message);
  await d.docs.put(listing, { report: reportCanonical });
  const docs = await d.docs.get(listing);
  return ok({ listing, grade: report.grade, reportHash, signature: attested.signature, shown: Boolean(docs?.meta) });
}

function verifiedStoredMeta(text: string | undefined, onChainMetaHash: string): ListingMeta | null {
  if (!text) return null;
  const v = validateListingMeta(safeJson(text));
  return v.ok && hex(metaHash(v.value)) === onChainMetaHash ? v.value : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const isService = (s: unknown): s is ServiceArgs =>
  !!s && typeof s === "object" && typeof (s as ServiceArgs).endpoint === "string"
  && !!(s as ServiceArgs).input_schema && typeof (s as ServiceArgs).input_schema === "object"
  && !!(s as ServiceArgs).output_schema && typeof (s as ServiceArgs).output_schema === "object";
