// Seller chain (PLAN §4.1, #66): classify -> assess -> price -> draft -> publish, and the sale step.
// Fake secrets in fixtures are assembled at runtime so secret scanners never see a literal one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58Encode, canonicalize, DEFAULT_LIMITS, sha256Bytes, type Blueprint, type Json } from "@deal/core";
import {
  assess, classify, createCustody, draftTerms, gradeOf, openFor, price, publish, sealedKeyStore, sell,
  type AssessmentReport, type ChainListingDeps, type DealFacts,
} from "../src/index.ts";

const NOW = Date.parse("2026-10-04T00:00:00Z") / 1000;
const enc = (s: string) => new TextEncoder().encode(s);
const days = (n: number) => new Date((NOW - n * 86_400) * 1000).toISOString().slice(0, 10);
const SELLER = base58Encode(randomBytes(32));
const ASSESSOR = base58Encode(randomBytes(32));

const CLEAN_CSV = enc(["date,zone,price_eur_mwh,volume", ...Array.from({ length: 20 }, (_, i) => `${days(i + 2)},DE,${80 + (i % 7)}.5,${1000 + i * 3}`)].join("\n") + "\n");
const PII_CSV = enc(["name,email,iban,amount", "Ana,ana@example.com,DE89370400440532013000,12", "Ben,ben@example.org,DE89370400440532013000,15", "Cy,cy@example.net,,9"].join("\n") + "\n");
const KEY_FILE = enc(`config:\n  provider: openai\n  key: ${"sk-" + "live-" + "Q".repeat(28)}\n`);
const AWS_FILE = enc(`aws_access_key_id = ${"AK" + "IA" + "ABCDEFGHIJKLMNOP"}\n`);
const PEM_FILE = enc(`-----BEGIN ${"PRIVATE"} KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n`);
const BROKEN_JSON = enc('{"rows": [1, 2, 3], "note": "unterminated');
const DIRTY_CSV = enc(["a,b,c", ...Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? ",," : `${i},${i % 3 === 0 ? "" : "x"},${i === 7 ? 99999 : i}`)), "1,x,1", "1,x,1"].join("\n") + "\n");

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) assert.fail(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return r as Extract<T, { ok: true }>;
};
const why = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

// ---- classify

test("classify: file signatures, JSON, JSON Lines, CSV with quotes, Markdown, text, binary", () => {
  const kind = (b: Uint8Array) => { const c = classify(b); return c.kind === "Data" ? c.format : c.kind; };
  assert.equal(kind(enc("%PDF-1.7\n...")), "pdf");
  assert.equal(kind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image");
  assert.equal(kind(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), "archive");
  assert.equal(kind(enc('{"a":1}')), "json");
  assert.equal(kind(enc('{"a":1}\n{"a":2}\n')), "jsonl");
  assert.equal(kind(enc("# Title\n\nSome *text* and [a link](https://x.example).")), "markdown");
  assert.equal(kind(enc("just some plain words")), "text");
  assert.equal(kind(Uint8Array.from([0xff, 0xfe, 0x00, 0x81])), "Unknown");
  const c = classify(enc('name,quote,n\n"Doe, Jane","said ""hi""",3\nRoe,x,4\n'));
  assert.ok(c.kind === "Data" && c.table);
  assert.deepEqual(c.table.rows[0], ["Doe, Jane", 'said "hi"', "3"]);
  assert.deepEqual(c.table.types, ["string", "string", "int"]);
  const t = classify(CLEAN_CSV);
  assert.ok(t.kind === "Data" && t.table);
  assert.deepEqual(t.table.types, ["date", "string", "number", "int"]);
  assert.equal(classify({ endpoint: "http://insecure.example", inputSchema: {}, outputSchema: {}, exampleInput: {} }).kind, "Unknown");
});

// ---- assess: the fixture corpus

const A = (b: Uint8Array) => assess(classify(b), b, { now: NOW });

test("clean CSV: grade A, fresh, no warnings; the report hash is the canonical report's sha256", async () => {
  const r = ok(await A(CLEAN_CSV));
  assert.equal(r.grade, "A");
  assert.equal(r.report.contentHash, bytesToHex(sha256(CLEAN_CSV)));
  assert.deepEqual(r.report.safety, { pii: [], secrets: [] });
  assert.equal(r.report.quality?.ageDays, 2);
  assert.equal(r.report.needsConfirmation, false);
  assert.deepEqual(r.reportHash, sha256Bytes(canonicalize(r.report as unknown as Json)));
  assert.deepEqual((ok(await A(CLEAN_CSV))).reportHash, r.reportHash, "deterministic");
});

test("CSV with personal data: listed only after the seller confirms; findings are counted, never copied", async () => {
  const r = ok(await A(PII_CSV));
  assert.equal(r.report.needsConfirmation, true);
  assert.deepEqual(r.report.safety.pii, [{ type: "email", count: 3 }, { type: "iban", count: 2 }]);
  assert.ok(!JSON.stringify(r.report).includes("ana@example.com"));
});

test("a file with a credential is refused, whatever the kind of credential", async () => {
  for (const f of [KEY_FILE, AWS_FILE, PEM_FILE, enc(JSON.stringify({ wallet: Array.from({ length: 64 }, (_, i) => i) }))]) {
    assert.equal(why(await A(f)), "SECRET_FOUND");
  }
});

test("broken JSON is refused; dirty tables get lower grades", async () => {
  assert.equal(why(await A(BROKEN_JSON)), "BROKEN_DATA");
  const d = ok(await A(DIRTY_CSV));
  assert.ok(d.grade === "C" || d.grade === "D", d.grade);
  assert.ok(d.report.quality!.duplicateRows >= 1);
  assert.deepEqual(d.report.quality!.outliers, [{ type: "c", count: 1 }]);
  assert.equal(gradeOf(undefined, false), "D");
});

const quoteSvc = { endpoint: "https://quotes.example/v1", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["pair", "price"], properties: { pair: { type: "string" }, price: { type: "number" } } }, exampleInput: { pair: "SOLUSDC" } };
const stubFetch = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("service: the probe answer must fit the declared schema; failures and credentials in answers are refused", async () => {
  const c = classify(quoteSvc);
  const good = ok(await assess(c, null, { now: NOW, fetch: stubFetch(200, { pair: "SOLUSDC", price: 150.25 }) }));
  assert.equal(good.grade, "A");
  assert.equal(good.report.probe?.schemaOk, true);
  assert.equal(why(await assess(c, null, { now: NOW, fetch: stubFetch(200, { pair: "SOLUSDC" }) })), "PROBE_FAILED");
  assert.equal(why(await assess(c, null, { now: NOW, fetch: stubFetch(500, { pair: "x", price: 1 }) })), "PROBE_FAILED");
  assert.equal(why(await assess(c, null, { now: NOW, fetch: async () => { throw new Error("down"); } })), "PROBE_FAILED");
  assert.equal(why(await assess(c, null, { now: NOW, fetch: stubFetch(200, { pair: "sk-" + "live-" + "Z".repeat(30), price: 1 }) })), "SECRET_FOUND");
  assert.equal(why(await assess(c, null, { now: NOW })), "NO_PROBE");
});

const blueprint: Blueprint = {
  version: 1, name: "Trip planner",
  roles: [{ name: "researcher", purpose: "Find flights", capabilities: ["booking:search"], cap: 30_000_000n, perTxCap: 10_000_000n }],
  stages: [{ name: "Research", roles: ["researcher"], cap: 30_000_000n, gate: "human" }],
  deliverable: { description: "A plan", check: "sha256" }, maxDuration: 86_400,
};

test("team: the blueprint validates and dry-runs every capability on mock providers", async () => {
  const team = { limits: DEFAULT_LIMITS, capabilities: ["booking:search"] };
  const c = classify({ blueprint });
  const r = ok(await assess(c, null, { now: NOW, team }));
  assert.deepEqual(r.report.dryRun, { stages: 1, capabilities: 1 });
  assert.equal(why(await assess(c, null, { now: NOW, team: { ...team, capabilities: [] } })), "BLUEPRINT_INVALID");
  assert.equal(why(await assess(c, null, { now: NOW, team: { ...team, mockCall: async () => false } })), "DRY_RUN_FAILED");
});

// ---- price and draft

test("price: the assessment feeds the suggestion (grade, coverage, freshness), never the other way", async () => {
  const r = ok(await A(CLEAN_CSV));
  const comps = [5_000_000n, 5_000_000n, 5_000_000n].map((p) => ({ kind: "Data" as const, price: p, sold: true }));
  const s = price(r.report, { comparables: comps });
  assert.equal(s.mid, 6_000_000n); // grade A: +20%
  const dirty = ok(await A(DIRTY_CSV));
  assert.ok(price(dirty.report, { comparables: comps }).mid < s.mid);
});

const template = { template: "pay_on_delivery" as const, seller: SELLER, serviceId: "listing-1", task: "Deliver the EU power price file", price: 6_000_000n, deliveryWindowSecs: 3_600, reviewSecs: 86_400 };

test("draft: a template the escrow accepts, hashed for terms_template_hash; bad terms are refused", () => {
  const d = ok(draftTerms(template, NOW));
  assert.deepEqual(d.templateHash, sha256Bytes(canonicalize(template as unknown as Json)));
  assert.equal(why(draftTerms({ ...template, price: 0n }, NOW)), "ZERO_PRICE");
  assert.equal(why(draftTerms({ ...template, deliveryWindowSecs: 40 * 86_400 }, NOW)), "DEADLINE_TOO_FAR");
});

// ---- publish and sell

function chainStub(o: { failCreate?: boolean; failAttest?: boolean } = {}) {
  const calls: string[] = [];
  const attested: { listing: string; contentHash: string; reportHash: string }[] = [];
  const stored = new Map<string, Uint8Array>();
  const deps: ChainListingDeps = {
    ensureTokenAccount: async (owner) => void calls.push(`ensureTokenAccount:${owner === SELLER}`),
    createListing: async (p) => {
      calls.push("createListing");
      return o.failCreate ? { ok: false, reason: "AssessorNotRegistered", message: "x" } : { ok: true, listing: `L-${p.listingId}` };
    },
    attest: async (p) => {
      calls.push("attest");
      attested.push({ listing: p.listing, contentHash: bytesToHex(p.contentHash), reportHash: bytesToHex(p.reportHash) });
      return o.failAttest ? { ok: false, reason: "NotAssessor", message: "x" } : { ok: true };
    },
    storeCiphertext: async (l, c) => void (calls.push("storeCiphertext"), stored.set(l, c)),
  };
  return { deps, calls, attested, stored };
}

const META = { kind: "Data", name: "EU power prices", description: "Daily day-ahead prices", category: "energy", tags: ["prices"], format: "csv", sizeBytes: CLEAN_CSV.length };

async function published(o: Parameters<typeof chainStub>[0] = {}) {
  const r = ok(await A(CLEAN_CSV));
  const chain = chainStub(o);
  const deals: Record<string, DealFacts> = {};
  const custody = createCustody({ readDeal: async (d) => deals[d] ?? null });
  const out = await publish({ seller: SELLER, listingId: 1n, meta: META, price: 6_000_000n, report: r.report, reportHash: r.reportHash, template, assessor: ASSESSOR, data: CLEAN_CSV }, chain.deps, custody);
  return { r, chain, custody, deals, out };
}

test("publish: token account, create, encrypted custody, then attest with exactly the assessed report hash", async () => {
  const { r, chain, out } = await published();
  const p = ok(out);
  assert.deepEqual(chain.calls, ["ensureTokenAccount:true", "createListing", "storeCiphertext", "attest"]);
  assert.deepEqual(chain.attested, [{ listing: "L-1", contentHash: bytesToHex(sha256(CLEAN_CSV)), reportHash: bytesToHex(r.reportHash) }]);
  assert.deepEqual(p.contentHash, sha256(CLEAN_CSV));
  assert.ok(!Buffer.from(chain.stored.get("L-1")!).includes(Buffer.from("price_eur_mwh")), "custody stores ciphertext only");
});

test("publish refuses: unconfirmed personal data, bad metadata, mismatches; a failed create never attests", async () => {
  const pii = ok(await A(PII_CSV));
  const custody = createCustody({ readDeal: async () => null });
  const base = { seller: SELLER, listingId: 2n, meta: { ...META, sizeBytes: PII_CSV.length }, price: 6_000_000n, report: pii.report, reportHash: pii.reportHash, template, assessor: ASSESSOR, data: PII_CSV };
  assert.equal(why(await publish(base, chainStub().deps, custody)), "PII_NOT_CONFIRMED");
  const confirmed = chainStub();
  ok(await publish({ ...base, confirmedPii: true }, confirmed.deps, custody));
  const clean = ok(await A(CLEAN_CSV));
  const b2 = { ...base, report: clean.report, reportHash: clean.reportHash, data: CLEAN_CSV, meta: META };
  assert.equal(why(await publish({ ...b2, meta: { ...META, note: "x" } }, chainStub().deps, custody)), "UNKNOWN_FIELD");
  assert.equal(why(await publish({ ...b2, meta: { ...META, kind: "Service" } }, chainStub().deps, custody)), "UNKNOWN_FIELD");
  assert.equal(why(await publish({ ...b2, price: 1n }, chainStub().deps, custody)), "TEMPLATE_MISMATCH");
  assert.equal(why(await publish({ ...b2, data: enc("swapped after assessment") }, chainStub().deps, custody)), "CONTENT_CHANGED");
  assert.equal(why(await publish(b2, chainStub().deps)), "NO_CUSTODY");
  const failing = chainStub({ failCreate: true });
  assert.equal(why(await publish(b2, failing.deps, custody)), "AssessorNotRegistered");
  assert.ok(!failing.calls.includes("attest"));
});

test("sell: delivery is submitted first, then the key goes to the deal's buyer, who opens exactly the listed data", async () => {
  const { chain, custody, deals, out } = await published();
  const p = ok(out);
  const seed = new Uint8Array(randomBytes(32));
  const buyer = base58Encode(ed25519.getPublicKey(seed));
  deals.D1 = { status: "Funded", buyer, listing: p.listing };
  const order: string[] = [];
  const submitDelivery = async (deal: string, h: Uint8Array) => {
    order.push("submitDelivery");
    assert.deepEqual(h, p.contentHash); // delivery hash = listed content hash (DealLink check on chain)
    deals[deal] = { ...deals[deal]!, status: "Delivered" };
    return { ok: true as const };
  };
  const r = ok(await sell({ listing: p.listing, deal: "D1", buyer, contentHash: p.contentHash, price: 6_000_000n }, custody, { submitDelivery }));
  order.push("released");
  assert.deepEqual(order, ["submitDelivery", "released"]);
  const opened = openFor(seed, r.sealedKey, chain.stored.get(p.listing)!, p.contentHash);
  assert.ok(opened.ok);
  assert.deepEqual(opened.data, CLEAN_CSV);
  // If delivery is refused on chain, no key leaves custody.
  deals.D2 = { status: "Funded", buyer, listing: p.listing };
  assert.equal(why(await sell({ listing: p.listing, deal: "D2", buyer, contentHash: p.contentHash, price: 1n }, custody, {
    submitDelivery: async () => ({ ok: false, reason: "InvoiceMismatch", message: "x" }),
  })), "InvoiceMismatch");
});

test("sealed key store: keys survive a restart, encrypted under the master key and bound to their listing", async () => {
  let doc = null as string | null;
  const backing = { read: () => doc, write: (d: string) => void (doc = d) };
  const master = new Uint8Array(randomBytes(32));
  const custody = createCustody({ readDeal: async () => null, keys: sealedKeyStore(master, backing) });
  const { contentHash } = custody.store("L1", CLEAN_CSV);
  assert.ok(doc && !doc.includes(bytesToHex(contentHash)), "no plaintext in the stored document");
  const again = sealedKeyStore(master, backing);
  assert.deepEqual(again.get("L1")?.contentHash, contentHash);
  // A box copied to another listing, or opened with another master key, does not open.
  const parsed = JSON.parse(doc!) as Record<string, string>;
  backing.write(JSON.stringify({ ...parsed, L2: parsed.L1 }));
  assert.equal(again.get("L2"), undefined);
  assert.equal(sealedKeyStore(new Uint8Array(randomBytes(32)), backing).get("L1"), undefined);
  assert.throws(() => sealedKeyStore(new Uint8Array(5), backing));
});

void ({} as AssessmentReport);
