/**
 * Step 2 of the seller chain (PLAN §4.1): what is being listed. Deterministic: file signatures first, then a
 * strict text sniff. Tables report their columns, a type per column and the row count. Services and team
 * blueprints are classified from their declared shape (the probe and the dry run happen in `assess`).
 */
import { validateBlueprint, type PlatformLimits } from "@deal/core";

export type DataFormat = "csv" | "json" | "jsonl" | "text" | "markdown" | "pdf" | "image" | "archive";
export type ColumnType = "int" | "number" | "bool" | "date" | "string" | "empty";

export type Table = { columns: string[]; types: ColumnType[]; rows: string[][] };

export type Classification =
  | { kind: "Data"; format: DataFormat; sizeBytes: number; table?: Table; json?: unknown; text?: string }
  | { kind: "Service"; endpoint: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; exampleInput: unknown }
  | { kind: "Team"; blueprint: unknown }
  | { kind: "Unknown"; reason: string };

export type ServiceInput = { endpoint: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; exampleInput: unknown };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

function magic(b: Uint8Array): DataFormat | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || startsWith(b, [0xff, 0xd8, 0xff]) || startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "image";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image"; // RIFF....WEBP
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x1f, 0x8b]) || startsWith(b, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return "archive";
  return null;
}

/** RFC 4180-ish CSV: quoted fields, "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (quoted) return null;
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function cellType(v: string): ColumnType {
  const s = v.trim();
  if (s === "") return "empty";
  if (/^[+-]?\d+$/.test(s)) return "int";
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(s)) return "number";
  if (/^(true|false)$/i.test(s)) return "bool";
  if (DATE.test(s) && !Number.isNaN(Date.parse(s))) return "date";
  return "string";
}

/** The narrowest type every non-empty cell fits (int < number; anything mixed is string). */
function columnType(cells: string[]): ColumnType {
  const seen = new Set(cells.map(cellType).filter((t) => t !== "empty"));
  if (seen.size === 0) return "empty";
  if (seen.size === 1) return [...seen][0]!;
  if ([...seen].every((t) => t === "int" || t === "number")) return "number";
  return "string";
}

function asTable(rows: string[][]): Table | null {
  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!header || header.length < 2 || body.length === 0) return null;
  if (body.some((r) => r.length !== header.length)) return null;
  return { columns: header, types: header.map((_, i) => columnType(body.map((r) => r[i]!))), rows: body };
}

function classifyBytes(b: Uint8Array): Classification {
  const m = magic(b);
  if (m) return { kind: "Data", format: m, sizeBytes: b.length };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return { kind: "Unknown", reason: "binary data with no known file signature" };
  }
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "Unknown", reason: "empty" };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "Data", format: "json", sizeBytes: b.length, json: JSON.parse(trimmed) };
    } catch {
      // maybe JSON Lines, or broken JSON (assess reports it)
    }
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length > 1) {
      try {
        return { kind: "Data", format: "jsonl", sizeBytes: b.length, json: lines.map((l) => JSON.parse(l)) };
      } catch {
        // fall through
      }
    }
    return { kind: "Data", format: "json", sizeBytes: b.length, text };
  }
  if (trimmed.includes(",")) {
    const rows = parseCsv(text);
    const table = rows && asTable(rows);
    if (table) return { kind: "Data", format: "csv", sizeBytes: b.length, table, text };
  }
  if (/^#{1,6} |\n#{1,6} |\n[-*] |\[[^\]]+\]\([^)]+\)|```/.test(text)) return { kind: "Data", format: "markdown", sizeBytes: b.length, text };
  return { kind: "Data", format: "text", sizeBytes: b.length, text };
}

export function classify(input: Uint8Array | ServiceInput | { blueprint: unknown }): Classification {
  if (input instanceof Uint8Array) return classifyBytes(input);
  if ("blueprint" in input) return { kind: "Team", blueprint: input.blueprint };
  if (typeof input.endpoint !== "string" || !input.endpoint.startsWith("https://")) return { kind: "Unknown", reason: "a service endpoint must be https" };
  return { kind: "Service", ...input };
}

/** Team blueprints are validated here; capabilities come from the broker's catalogue (passed in). */
export function classifyTeam(blueprint: unknown, ctx: { limits: PlatformLimits; capabilities: readonly string[] }) {
  return validateBlueprint(blueprint, ctx);
}
