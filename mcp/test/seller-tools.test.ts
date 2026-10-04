// The seller tools (#107): draft_listing and publish_listing run the agents lane's seller chain on the agent's own
// data; demand_board and my_listings read the site; call_service pays per call with limits taken from the chain.
// Chain parts run the real program in LiteSVM (chain lane's harness); the site is a recorded fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getListing, listings, type DealClient, type DealContext } from "@deal/chain";
import { metaHash, type ServiceMeta } from "@deal/core";
import { SOLANA_DEVNET } from "@deal/agents";
import { setup, hash, USDC } from "../../chain/test/harness.ts";
import { loadConfig } from "../src/config.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { ToolContext, ToolResult } from "../src/tool.ts";

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const data = (r: ToolResult) => { assert.ok(r.ok, JSON.stringify(r)); return (r as { data: Record<string, unknown> }).data; };
const reason = (r: ToolResult) => (r.ok ? "OK" : r.reason);

const CSV = ["date,region,price_eur_mwh", "2026-09-28,DE,81.2", "2026-09-29,DE,79.9", "2026-09-30,DE,84.1", "2026-10-01,DE,88.0", "2026-10-02,DE,85.5"].join("\n") + "\n";
const PII_CSV = ["name,email,amount", "Ana,ana@example.com,12", "Ben,ben@example.org,15", "Cy,cy@example.net,9"].join("\n") + "\n";
const DESCRIBE = { name: "German day-ahead power prices", description: "Daily DE day-ahead prices, EUR/MWh.", category: "energy", tags: ["power", "prices"] };

type Seen = { url: string; method: string; body: unknown };
/** A recorded stand-in for the site (and, for call_service, the seller's endpoint). */
function site(routes: Record<string, (body: unknown) => Response>) {
  const seen: Seen[] = [];
  const f = (async (u: URL | string, init?: RequestInit) => {
    const url = new URL(u.toString());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: url.toString(), method: init?.method ?? "GET", body });
    const h = routes[`${init?.method ?? "GET"} ${url.pathname}`] ?? routes[url.pathname];
    return h ? h(body) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

async function market() {
  const t = await setup();
  const assessor = await generateKeyPairSigner();
  t.client.svm.airdrop(assessor.address, 1_000_000_000n as never);
  await t.registerAssessors(assessor.address);
  const client: DealClient = {
    rpc: (t.client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { t.client.svm.expireBlockhash(); return (t.client as unknown as DealClient).sendTransaction(ixs); },
  };
  const dctx: DealContext = { client, mint: t.mint.address, sleep: async () => {} };
  const base = loadConfig({});
  assert.ok(base.ok);
  const ctx = (signer: unknown, extra: object = {}, fetchFn?: typeof fetch): ToolContext => ({
    config: { ...base.config, mint: t.mint.address, assessor: assessor.address, siteUrl: "https://site.example", rpcUrl: "http://127.0.0.1:9", ...extra },
    chain: async () => ({ ctx: dctx, signer: signer as never }),
    fetch: fetchFn,
  });
  return { t, dctx, assessor, ctx };
}

test("draft_listing: assessment, price range with reasons and terms, without a chain or a signature", async () => {
  const s = site({});
  const base = loadConfig({});
  assert.ok(base.ok);
  const d = data(await tool("draft_listing").run({ text: CSV, ...DESCRIBE, task: "Deliver the price table" }, { config: base.config, fetch: s.f }));
  assert.equal(d.kind, "Data");
  assert.match(d.grade as string, /^[ABCD]$/);
  assert.match(d.reportHash as string, /^[0-9a-f]{64}$/);
  const p = d.price as { lowUsdc: string; midUsdc: string; highUsdc: string; chosenUsdc: string; reasons: string[] };
  assert.ok(Number(p.lowUsdc) <= Number(p.midUsdc) && Number(p.midUsdc) <= Number(p.highUsdc));
  assert.equal(p.chosenUsdc, p.midUsdc);
  assert.ok(p.reasons.length > 0);
  assert.equal((d.terms as { task: string }).task, "Deliver the price table");
  assert.equal((d.meta as { kind: string; rows: number }).rows, 5);
  assert.equal((d.report as { contentHash: string }).contentHash, bytesToHex(sha256(new TextEncoder().encode(CSV))));

  // The same bytes from a file give the same report.
  const dir = mkdtempSync(join(tmpdir(), "mcp-draft-"));
  writeFileSync(join(dir, "prices.csv"), CSV);
  const fromFile = data(await tool("draft_listing").run({ file_path: join(dir, "prices.csv") }, { config: base.config }));
  assert.equal(fromFile.reportHash, d.reportHash);

  assert.equal(data(await tool("draft_listing").run({ text: PII_CSV }, { config: base.config })).needsConfirmation, true);
  assert.equal(reason(await tool("draft_listing").run({}, { config: base.config })), "BAD_INPUT");
  assert.equal(reason(await tool("draft_listing").run({ text: CSV, file_path: "/x" }, { config: base.config })), "BAD_INPUT");
  assert.equal(reason(await tool("draft_listing").run({ file_path: dir }, { config: base.config })), "BAD_INPUT");
  assert.equal(reason(await tool("draft_listing").run({ text: CSV, price_usdc: "five" }, { config: base.config })), "BAD_INPUT");
});

test("publish_listing: the agent's key lists its data, custody gets the bytes, the assessor attests separately", async () => {
  const { t, dctx, assessor, ctx } = await market();
  const s = site({ "POST /api/sell/custody": () => new Response("{}", { status: 201 }), "POST /api/sell/assess": () => new Response("{}", { status: 202 }) });
  const d = data(await tool("publish_listing").run({ text: CSV, ...DESCRIBE, price_usdc: "4.5" }, ctx(t.seller, {}, s.f)));
  assert.equal(d.attestation, "requested");
  const listing = d.listing as string;
  const l = (await getListing(dctx, listing as never))!;
  assert.equal(l.seller, t.seller.address);
  assert.equal(l.kind, "Data");
  assert.equal(l.price, String(4_500_000n));
  assert.equal(l.contentHash, bytesToHex(sha256(new TextEncoder().encode(CSV))));
  assert.equal(l.assessor, assessor.address);
  assert.equal(l.assessedAt, 0); // the agent cannot attest its own listing

  // Custody received exactly the listed bytes; the assessor service was asked, with the listing and content hash.
  const custody = s.seen.find((x) => x.url.endsWith("/api/sell/custody"))!.body as { listing: string; data: string };
  assert.equal(custody.listing, listing);
  assert.equal(Buffer.from(custody.data, "base64").toString(), CSV);
  const asked = s.seen.find((x) => x.url.endsWith("/api/sell/assess"))!.body as { listing: string; contentHash: string };
  assert.deepEqual([asked.listing, asked.contentHash], [listing, l.contentHash]);

  // Once the marketplace assessor attests, buyers see it as buyable.
  assert.ok((await listings.attest(dctx, assessor, listing as never, sha256(new TextEncoder().encode(CSV)), Uint8Array.from(Buffer.from(d.reportHash as string, "hex")))).ok);
  assert.equal(data(await tool("get_listing").run({ listing }, ctx(t.buyer))).buyable, true);
});

test("publish_listing refusals: personal data unconfirmed, unregistered assessor, no site, no signer, custody down", async () => {
  const { t, ctx } = await market();
  const s = site({ "POST /api/sell/custody": () => new Response("{}"), "POST /api/sell/assess": () => new Response("{}") });
  const args = { ...DESCRIBE, price_usdc: "2" };
  assert.equal(reason(await tool("publish_listing").run({ text: PII_CSV, ...args }, ctx(t.seller, {}, s.f))), "PII_NOT_CONFIRMED");
  assert.equal(data(await tool("publish_listing").run({ text: PII_CSV, ...args, confirm_personal_data: true }, ctx(t.seller, {}, s.f))).attestation, "requested");
  const stranger = (await generateKeyPairSigner()).address;
  assert.equal(reason(await tool("publish_listing").run({ text: CSV, ...args, assessor: stranger }, ctx(t.seller, {}, s.f))), "ASSESSOR_NOT_REGISTERED");
  assert.equal(reason(await tool("publish_listing").run({ text: CSV, ...args }, ctx(t.seller, { siteUrl: null }, s.f))), "NOT_CONFIGURED");
  assert.equal(reason(await tool("publish_listing").run({ text: CSV, ...args }, ctx(null, {}, s.f))), "NO_SIGNER");
  assert.equal(reason(await tool("publish_listing").run({ text: CSV, ...args, price_usdc: "0" }, ctx(t.seller, {}, s.f))), "BAD_INPUT");
  const down = site({});
  assert.equal(reason(await tool("publish_listing").run({ text: CSV, ...args }, ctx(t.seller, {}, down.f))), "CUSTODY_FAILED");
});

test("demand_board and my_listings read the site; my_listings never shows another seller's listing as ours", async () => {
  const { t, ctx } = await market();
  const none = site({});
  assert.equal(reason(await tool("demand_board").run({}, ctx(t.seller, {}, none.f))), "NOT_CONFIGURED");
  const groups = [{ category: "energy", requests: 3, budgets: { stated: 1, median: "5000000" }, examples: ["power prices france"] }];
  const s = site({
    "/api/demand": () => Response.json({ groups }),
    "/api/catalogue": () => Response.json({ listings: [{ address: "a", seller: t.seller.address }, { address: "b", seller: t.buyer.address }] }),
  });
  assert.deepEqual(data(await tool("demand_board").run({}, ctx(t.seller, {}, s.f))).groups, groups);
  const mine = data(await tool("my_listings").run({}, ctx(t.seller, {}, s.f)));
  assert.deepEqual(mine.listings, [{ address: "a", seller: t.seller.address }]);
  assert.match(s.seen.at(-1)!.url, new RegExp(`/api/catalogue\\?seller=${t.seller.address}$`));
  assert.equal(reason(await tool("my_listings").run({}, ctx(null, {}, s.f))), "NO_SIGNER");
  assert.equal(reason(await tool("my_listings").run({ seller: "nope" }, ctx(null, {}, s.f))), "BAD_INPUT");
});

test("call_service: what may be paid comes from the on-chain listing, never from the 402", async () => {
  const { t, dctx, assessor, ctx } = await market();
  const endpoint = "https://svc.example/v1/quote";
  const meta: ServiceMeta = {
    kind: "Service", name: "FX quote", description: "One EURUSD quote per call.", category: "market-data", tags: ["fx"], endpoint,
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
  };
  const made = await listings.create(dctx, t.seller, { listingId: 9n, kind: "Service", price: 10_000n, contentHash: hash(50), metaHash: metaHash(meta), assessor: assessor.address });
  assert.ok(made.ok);
  const listing = made.listing;
  assert.ok((await listings.attest(dctx, assessor, listing, hash(50), hash(51))).ok);

  const required = (over: object) => {
    const req = { scheme: "exact", network: SOLANA_DEVNET, amount: "10000", asset: t.mint.address, payTo: t.seller.address, maxTimeoutSeconds: 60, extra: { feePayer: t.stranger.address }, ...over };
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [req], resource: { url: endpoint } })).toString("base64");
    return site({ [`POST ${new URL(endpoint).pathname}`]: () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": header } }) });
  };
  const call = (over: object, args: object = {}) => {
    const s = required(over);
    return tool("call_service").run({ listing, body: { pair: "EURUSD" }, meta, ...args }, ctx(t.buyer, {}, s.f));
  };
  // The endpoint asks to be paid elsewhere, or more than the listing price, or in another token: nothing is signed.
  assert.equal(reason(await call({ payTo: (await generateKeyPairSigner()).address })), "NO_ACCEPTABLE_REQUIREMENTS");
  assert.equal(reason(await call({ amount: "10001" })), "NO_ACCEPTABLE_REQUIREMENTS");
  assert.equal(reason(await call({ asset: (await generateKeyPairSigner()).address })), "NO_ACCEPTABLE_REQUIREMENTS");
  assert.equal(reason(await call({}, { max_price_usdc: "0.005" })), "NO_ACCEPTABLE_REQUIREMENTS"); // the agent's own cap binds too
  // A request that matches the chain gets as far as signing (this test has no RPC, so signing fails).
  assert.equal(reason(await call({})), "SIGN_FAILED");

  // The metadata must be what the seller listed; data listings are bought with `buy`, not called.
  assert.equal(reason(await call({}, { meta: { ...meta, endpoint: "https://evil.example/q" } })), "META_MISMATCH");
  const dataListing = (await listings.create(dctx, t.seller, { listingId: 10n, kind: "Data", price: USDC, contentHash: hash(60), metaHash: hash(61), assessor: assessor.address }));
  assert.ok(dataListing.ok);
  assert.equal(reason(await tool("call_service").run({ listing: dataListing.listing, body: {} }, ctx(t.buyer))), "NOT_A_SERVICE");
  assert.equal(reason(await tool("call_service").run({ listing, body: {} }, ctx(t.buyer, { siteUrl: null }))), "NOT_CONFIGURED");
  assert.equal(reason(await tool("call_service").run({ listing, body: {}, meta }, ctx(null))), "NO_SIGNER");
});
