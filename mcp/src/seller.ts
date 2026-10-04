// The seller chain for the seller tools (draft_listing, publish_listing): the agents lane's own steps (#66) run on
// the agent's data, in code. Kept outside src/tools, which holds only registered tools.
import { readFileSync, statSync } from "node:fs";
import { validateListingMeta, type Comparable, type ListingMeta, type PriceSuggestion } from "@deal/core";
import { assess, classify, draftTerms, price, type AssessmentReport, type Classification, type ServiceInput, type TermsTemplate } from "@deal/agents";
import { bytesToHex } from "@noble/hashes/utils.js";
import { refuse, type ToolContext, type ToolResult } from "./tool.ts";
import { chainNow } from "./access.ts";

/** Largest file or inline text the tools read: the assessment holds it in memory. */
export const MAX_DATA_BYTES = 10 * 1024 * 1024;

/** What is being listed: exactly one of a local file, inline text, or a service descriptor. */
export type SourceArgs = {
  file_path?: string;
  text?: string;
  service?: { endpoint: string; input_schema: Record<string, unknown>; output_schema: Record<string, unknown>; example_input?: unknown };
};

export type Source = { kind: "Data"; bytes: Uint8Array } | { kind: "Service"; service: ServiceInput };

export function readSource(a: SourceArgs): { ok: true; value: Source } | { ok: false; result: ToolResult } {
  const given = [a.file_path, a.text, a.service].filter((x) => x !== undefined).length;
  if (given !== 1) return { ok: false, result: refuse("BAD_INPUT", "Give exactly one of file_path, text or service.") };
  if (a.service !== undefined) {
    const s = a.service;
    return { ok: true, value: { kind: "Service", service: { endpoint: s.endpoint, inputSchema: s.input_schema, outputSchema: s.output_schema, exampleInput: s.example_input ?? {} } } };
  }
  if (a.text !== undefined) {
    const bytes = new TextEncoder().encode(a.text);
    if (bytes.length === 0 || bytes.length > MAX_DATA_BYTES) return { ok: false, result: refuse("BAD_INPUT", `text must be 1 byte to ${MAX_DATA_BYTES} bytes.`) };
    return { ok: true, value: { kind: "Data", bytes } };
  }
  try {
    const st = statSync(a.file_path!);
    if (!st.isFile()) return { ok: false, result: refuse("BAD_INPUT", "file_path must be a regular file.") };
    if (st.size === 0 || st.size > MAX_DATA_BYTES) return { ok: false, result: refuse("TOO_LARGE", `The file must be 1 byte to ${MAX_DATA_BYTES} bytes.`) };
    return { ok: true, value: { kind: "Data", bytes: new Uint8Array(readFileSync(a.file_path!)) } };
  } catch {
    return { ok: false, result: refuse("FILE_UNREADABLE", "The file could not be read.") };
  }
}

/** The seller's description of the listing; the measured fields (format, size, rows, endpoint) come from the data. */
export type DescribeArgs = { name: string; description: string; category: string; tags?: string[] };

export function buildMeta(d: DescribeArgs, c: Classification): { ok: true; value: ListingMeta } | { ok: false; result: ToolResult } {
  const common = { name: d.name, description: d.description, category: d.category, tags: d.tags ?? [] };
  const raw =
    c.kind === "Data"
      ? { ...common, kind: "Data", format: c.format, sizeBytes: c.sizeBytes, ...(c.table ? { rows: c.table.rows.length, columns: c.table.columns } : {}) }
      : c.kind === "Service"
        ? { ...common, kind: "Service", endpoint: c.endpoint, inputSchema: c.inputSchema, outputSchema: c.outputSchema }
        : null;
  if (!raw) return { ok: false, result: refuse("UNSUPPORTED", "Only data and services can be listed from here.") };
  const v = validateListingMeta(raw);
  return v.ok ? { ok: true, value: v.value } : { ok: false, result: refuse(v.reason, "The listing description is not valid.") };
}

/** Asking prices of the same kind from the site's catalogue (best effort: none if the site is unset or down). */
async function comparables(c: ToolContext, kind: "Data" | "Service"): Promise<Comparable[]> {
  if (!c.config.siteUrl) return [];
  try {
    const u = new URL("/api/catalogue", c.config.siteUrl);
    u.searchParams.set("kind", kind);
    const r = await (c.fetch ?? fetch)(u, { headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const body = (await r.json()) as { listings?: { kind?: unknown; price?: unknown; seller?: unknown }[] };
    return (Array.isArray(body.listings) ? body.listings : []).flatMap((l) =>
      l.kind === kind && typeof l.price === "string" && /^\d{1,20}$/.test(l.price)
        ? [{ kind, price: BigInt(l.price), sold: false, ...(typeof l.seller === "string" ? { seller: l.seller } : {}) }]
        : [],
    );
  } catch {
    return [];
  }
}

export type Drafted = {
  source: Source;
  classification: Classification;
  report: AssessmentReport;
  reportHash: string;
  suggestion: PriceSuggestion;
  template: TermsTemplate;
  templateHash: string;
  now: number;
};

export type DraftOptions = {
  seller: string;
  task: string;
  /** Token base units; default: the suggestion's middle. */
  price?: bigint;
  deliveryHours: number;
  reviewHours: number;
};

/** classify -> assess -> price -> draft, all in code. Nothing is signed. */
export async function runSellerChain(c: ToolContext, source: Source, o: DraftOptions): Promise<{ ok: true; value: Drafted } | { ok: false; result: ToolResult }> {
  const now = c.chain ? await chainNow(await c.chain()).catch(() => Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000);
  const classification = classify(source.kind === "Data" ? source.bytes : source.service);
  if (classification.kind === "Unknown") return { ok: false, result: refuse("UNSUPPORTED", classification.reason) };
  const fetchFn = c.fetch ? (u: string, i: RequestInit) => c.fetch!(u, i) : undefined;
  const assessed = await assess(classification, source.kind === "Data" ? source.bytes : null, { now, fetch: fetchFn });
  if (!assessed.ok) return { ok: false, result: refuse(assessed.reason, assessed.message) };
  const suggestion = price(assessed.report, { comparables: await comparables(c, source.kind), seller: o.seller });
  const template: TermsTemplate = {
    template: "pay_on_delivery", seller: o.seller, serviceId: `draft-${assessed.report.contentHash.slice(0, 16)}`, task: o.task,
    price: o.price ?? suggestion.mid, deliveryWindowSecs: o.deliveryHours * 3600, reviewSecs: o.reviewHours * 3600,
  };
  const drafted = draftTerms(template, now);
  if (!drafted.ok) return { ok: false, result: refuse(drafted.reason, drafted.message) };
  return {
    ok: true,
    value: {
      source, classification, report: assessed.report, reportHash: bytesToHex(assessed.reportHash), suggestion, template,
      templateHash: bytesToHex(drafted.templateHash), now,
    },
  };
}
