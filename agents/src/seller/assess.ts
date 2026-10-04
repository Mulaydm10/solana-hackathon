/**
 * Step 3 of the seller chain (PLAN §4.1): assess what is listed, deterministically, and produce a report whose
 * canonical hash the assessor attests on chain.
 *   - integrity: the format parses, the size and hash are recorded
 *   - quality (tables): null rate, duplicate rows, outliers per numeric column, freshness (newest date)
 *   - safety: secrets refuse the listing; personal data (PII) is a warning the seller must confirm
 *   - Service: one probe call with the example input; the answer must fit the declared output schema
 *   - Team: the blueprint validates and every stage's capabilities resolve on mock providers (dry run)
 * Grade A-D from integrity and quality. Refusals are values.
 */
import { blueprintHash, canonicalize, sha256Bytes, validateBlueprint, type Json, type PlatformLimits } from "@deal/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Ok, Refused } from "../broker/broker.ts";
import type { Classification } from "./classify.ts";

export type Grade = "A" | "B" | "C" | "D";
export type Finding = { type: string; count: number };

export type AssessmentReport = {
  version: 1;
  kind: "Data" | "Service" | "Team";
  format?: string;
  sizeBytes?: number;
  /** sha256 hex of the listed bytes (Data) / endpoint descriptor (Service) / blueprint (Team). */
  contentHash: string;
  /** "full", or "sample" when the assessor only saw a sample (custody sampleForAssessment). */
  scope: "full" | "sample";
  integrity: { parses: boolean };
  quality?: {
    rows: number;
    columns: number;
    /** Empty cells, basis points of all cells. */
    nullBps: number;
    duplicateRows: number;
    outliers: Finding[];
    newestDate?: string;
    ageDays?: number;
  };
  safety: { pii: Finding[]; secrets: Finding[] };
  probe?: { status: number; schemaOk: boolean; latencyMs: number };
  dryRun?: { stages: number; capabilities: number };
  /** The seller must confirm before publishing (personal data found). */
  needsConfirmation: boolean;
  grade: Grade;
};

export type Assessed = Ok<{ report: AssessmentReport; reportHash: Uint8Array; grade: Grade }>;

export type AssessOpts = {
  /** Unix seconds (freshness). */
  now: number;
  scope?: "full" | "sample";
  /** Service probe transport; in production the broker's egress. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  probeTimeoutMs?: number;
  /** Team dry run. */
  team?: { limits: PlatformLimits; capabilities: readonly string[]; mockCall?: (capability: string) => Promise<boolean> };
};

const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

// Built from parts so this file is not itself flagged by secret scanners.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private-key-pem", new RegExp("-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE " + "KEY-----")],
  ["aws-access-key", new RegExp("\\b(AKIA|ASIA)[0-9A-Z]{16}\\b", "g")],
  ["github-token", new RegExp("\\bgh[pousr]_[A-Za-z0-9]{36,}\\b", "g")],
  ["slack-token", new RegExp("\\bxox[abprs]-[A-Za-z0-9-]{10,}", "g")],
  ["api-secret-key", new RegExp("\\bsk-(live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}", "g")],
  ["google-api-key", new RegExp("\\bAIza[0-9A-Za-z_-]{35}\\b", "g")],
  ["jwt", new RegExp("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", "g")],
  ["solana-keypair", new RegExp("\\[(\\s*\\d{1,3}\\s*,){63}\\s*\\d{1,3}\\s*\\]", "g")],
];

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};
const ibanOk = (s: string) => {
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
};

const PII_PATTERNS: [string, RegExp, ((m: string) => boolean)?][] = [
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["phone", /(?<![\w.])\+\d[\d ()-]{7,17}\d\b/g],
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, ibanOk],
  ["card-number", /\b\d(?:[ -]?\d){12,18}\b/g, (m) => luhn(m.replace(/\D/g, ""))],
  ["us-ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
];

function scan(text: string, patterns: [string, RegExp, ((m: string) => boolean)?][]): Finding[] {
  const out: Finding[] = [];
  for (const [type, re, ok] of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const count = [...text.matchAll(g)].filter((m) => (ok ? ok(m[0]) : true)).length;
    if (count > 0) out.push({ type, count });
  }
  return out;
}

const quantile = (sorted: number[], q: number) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo]! + (sorted[Math.ceil(pos)]! - sorted[lo]!) * (pos - lo);
};

function tableQuality(t: NonNullable<Extract<Classification, { kind: "Data" }>["table"]>, now: number) {
  const cells = t.rows.length * t.columns.length;
  const empty = t.rows.reduce((n, r) => n + r.filter((c) => c.trim() === "").length, 0);
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const r of t.rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) duplicateRows++;
    else seen.add(k);
  }
  const outliers: Finding[] = [];
  let newest: number | undefined;
  t.types.forEach((type, i) => {
    const vals = t.rows.map((r) => r[i]!.trim()).filter((v) => v !== "");
    if ((type === "int" || type === "number") && vals.length >= 8) {
      const xs = vals.map(Number).sort((a, b) => a - b);
      const q1 = quantile(xs, 0.25);
      const q3 = quantile(xs, 0.75);
      const fence = 3 * (q3 - q1);
      const count = xs.filter((x) => x < q1 - fence || x > q3 + fence).length;
      if (count > 0) outliers.push({ type: t.columns[i]!, count });
    }
    if (type === "date") for (const v of vals) newest = Math.max(newest ?? -Infinity, Date.parse(v) / 1000);
  });
  return {
    rows: t.rows.length,
    columns: t.columns.length,
    nullBps: cells === 0 ? 0 : Math.floor((empty * 10_000) / cells),
    duplicateRows,
    outliers,
    ...(newest !== undefined ? { newestDate: new Date(newest * 1000).toISOString().slice(0, 10), ageDays: Math.max(0, Math.floor((now - newest) / 86_400)) } : {}),
  };
}

export function gradeOf(q: AssessmentReport["quality"] | undefined, parses: boolean): Grade {
  if (!parses) return "D";
  if (!q) return "A";
  const dupBps = q.rows === 0 ? 0 : Math.floor((q.duplicateRows * 10_000) / q.rows);
  const outlierRows = q.outliers.reduce((n, o) => n + o.count, 0);
  const outBps = q.rows === 0 ? 0 : Math.floor((outlierRows * 10_000) / q.rows);
  if (q.nullBps <= 100 && dupBps === 0 && outBps <= 100) return "A";
  if (q.nullBps <= 500 && dupBps <= 100 && outBps <= 500) return "B";
  if (q.nullBps <= 2_000 && dupBps <= 500) return "C";
  return "D";
}

/** Shape check for a JSON-Schema-like `{ type, required, properties }` (enough for a probe). */
export function matchesSchema(v: unknown, s: Record<string, unknown>): boolean {
  const type = s.type;
  const is = (t: unknown, x: unknown): boolean =>
    t === "object" ? x !== null && typeof x === "object" && !Array.isArray(x)
    : t === "array" ? Array.isArray(x)
    : t === "integer" ? Number.isInteger(x)
    : t === "number" ? typeof x === "number" && Number.isFinite(x)
    : t === "string" ? typeof x === "string"
    : t === "boolean" ? typeof x === "boolean"
    : t === undefined;
  if (!is(type, v)) return false;
  if (type === "object") {
    const o = v as Record<string, unknown>;
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in o)) return false;
    for (const [k, sub] of Object.entries((s.properties as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      if (k in o && !matchesSchema(o[k], sub)) return false;
    }
  }
  if (type === "array" && s.items) return (v as unknown[]).every((x) => matchesSchema(x, s.items as Record<string, unknown>));
  return true;
}

const finish = (r: Omit<AssessmentReport, "grade" | "needsConfirmation">, grade: Grade): Assessed => {
  const report: AssessmentReport = { ...r, needsConfirmation: r.safety.pii.length > 0, grade };
  return { ok: true, report, reportHash: sha256Bytes(canonicalize(report as unknown as Json)), grade };
};

export async function assess(c: Classification, data: Uint8Array | null, o: AssessOpts): Promise<Assessed | Refused> {
  const scope = o.scope ?? "full";
  if (c.kind === "Unknown") return refuse("UNKNOWN_FORMAT", c.reason);

  if (c.kind === "Data") {
    if (!data) return refuse("NO_DATA", "data listings are assessed on their bytes");
    const hash = bytesToHex(sha256(data));
    const text = c.text ?? (c.json !== undefined ? JSON.stringify(c.json) : null);
    const secrets = text === null ? [] : scan(text, SECRET_PATTERNS);
    if (secrets.length > 0) return refuse("SECRET_FOUND", `the data contains credentials (${secrets.map((s) => s.type).join(", ")}); remove them before listing`);
    const pii = text === null ? [] : scan(text, PII_PATTERNS);
    const parses = !(c.format === "json" && c.json === undefined);
    if (!parses) return refuse("BROKEN_DATA", "the file looks like JSON but does not parse");
    const quality = c.table ? tableQuality(c.table, o.now) : undefined;
    return finish({ version: 1, kind: "Data", format: c.format, sizeBytes: c.sizeBytes, contentHash: hash, scope, integrity: { parses }, ...(quality ? { quality } : {}), safety: { pii, secrets } }, gradeOf(quality, parses));
  }

  if (c.kind === "Service") {
    const descriptor = canonicalize({ endpoint: c.endpoint, inputSchema: c.inputSchema, outputSchema: c.outputSchema } as unknown as Json);
    const hash = bytesToHex(sha256Bytes(descriptor));
    if (!o.fetch) return refuse("NO_PROBE", "a service listing needs a probe transport");
    const t0 = Date.now();
    let status = 0;
    let body: unknown;
    try {
      const res = await o.fetch(c.endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.exampleInput),
        signal: AbortSignal.timeout(o.probeTimeoutMs ?? 10_000),
      });
      status = res.status;
      body = await res.json().catch(() => undefined);
    } catch {
      return refuse("PROBE_FAILED", "the endpoint did not answer the probe");
    }
    const schemaOk = status >= 200 && status < 300 && body !== undefined && matchesSchema(body, c.outputSchema);
    if (!schemaOk) return refuse("PROBE_FAILED", `the probe answer (${status}) does not fit the declared output schema`);
    const secrets = scan(JSON.stringify(body), SECRET_PATTERNS);
    if (secrets.length > 0) return refuse("SECRET_FOUND", "the service answer contains credentials");
    return finish({ version: 1, kind: "Service", contentHash: hash, scope, integrity: { parses: true }, safety: { pii: scan(JSON.stringify(body), PII_PATTERNS), secrets }, probe: { status, schemaOk, latencyMs: Date.now() - t0 } }, "A");
  }

  // Team: validate, then resolve every stage's capabilities on mock providers.
  if (!o.team) return refuse("NO_CATALOGUE", "a team listing is assessed against the broker's capability catalogue");
  const v = validateBlueprint(c.blueprint, { limits: o.team.limits, capabilities: o.team.capabilities });
  if (!v.ok) return refuse("BLUEPRINT_INVALID", `${v.reason} at ${v.at}`);
  const bp = v.value;
  const mock = o.team.mockCall ?? (async () => true);
  let capabilities = 0;
  for (const stage of bp.stages) {
    for (const roleName of stage.roles) {
      for (const cap of bp.roles.find((r) => r.name === roleName)!.capabilities) {
        if (!(await mock(cap).catch(() => false))) return refuse("DRY_RUN_FAILED", `capability ${cap} failed on the mock provider in stage "${stage.name}"`);
        capabilities++;
      }
    }
  }
  return finish({ version: 1, kind: "Team", contentHash: bytesToHex(blueprintHash(bp)), scope, integrity: { parses: true }, safety: { pii: [], secrets: [] }, dryRun: { stages: bp.stages.length, capabilities } }, "A");
}
