// Production build and real routes (#99 acceptance). Builds with *canary* secrets in the environment, starts
// `next start`, requests every page, and checks that no canary, no secret's name and no server-only module text
// reaches the browser (client bundle or served HTML). Runs after the unit tests; this IS the `next build` check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58Encode } from "@deal/core";
import { FIXTURES } from "../../lib/registry.ts";
import { NAV } from "../../app/nav.ts";

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const NEXT = join(WEB, "node_modules", "next", "dist", "bin", "next");
// Random per run, assembled at runtime: nothing here is a real secret, and scanners never see a literal one.
const CANARY_KEY = `canary-anthropic-${randomBytes(12).toString("hex")}`;
const CANARY_BYTES = Array.from(randomBytes(64));
const CANARY_VERIFIER = JSON.stringify(CANARY_BYTES);
const CANARY_MISSION_TOKEN = `canary-mission-${randomBytes(24).toString("hex")}`;
const CANARY_FAUCET_BYTES = Array.from(randomBytes(64));
const CANARY_FAUCET = JSON.stringify(CANARY_FAUCET_BYTES);
const CANARY_ASSESSOR_BYTES = Array.from(randomBytes(64));
const CANARY_ASSESSOR = JSON.stringify(CANARY_ASSESSOR_BYTES);
const CANARY_CUSTODY = randomBytes(32).toString("hex");
const env = { ...process.env, DEAL_CLUSTER: "devnet", ANTHROPIC_API_KEY: CANARY_KEY, DEAL_VERIFIER_KEY: CANARY_VERIFIER, MISSION_SERVICE_URL: "http://127.0.0.1:9", MISSION_SERVICE_TOKEN: CANARY_MISSION_TOKEN, DEAL_FAUCET_KEY: CANARY_FAUCET, DEAL_ASSESSOR_KEY: CANARY_ASSESSOR, DEAL_CUSTODY_KEY: CANARY_CUSTODY, NEXT_TELEMETRY_DISABLED: "1" };

/**
 * String literals from agents' seller chain and custody (#110): server-only code, so never in the browser.
 * Not "deal-custody-key-v1": since #111 that is a public protocol constant the browser's key opener (lib/key-open.ts)
 * must use too. "deal-custody-store-v1" (the master-key store) stays server-only.
 */
const AGENTS_MARKERS = ["deal-custody-store-v1", "a service listing needs a probe transport", "remove them before listing"];

let server: ChildProcess | undefined;
let base = "";

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

before(async () => {
  const b = spawnSync(process.execPath, [NEXT, "build"], { cwd: WEB, env, encoding: "utf8" });
  assert.equal(b.status, 0, `next build failed:\n${b.stdout}\n${b.stderr}`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [NEXT, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: WEB, env, stdio: "ignore" });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("next start did not come up");
    await new Promise((r) => setTimeout(r, 300));
  }
}, { timeout: 600_000 });

after(() => server?.kill("SIGTERM"));

const page = async (path: string) => {
  const r = await fetch(base + path);
  // React separates adjacent text nodes with <!-- --> markers; drop them before matching text.
  return { status: r.status, html: (await r.text()).replaceAll("<!-- -->", "") };
};

test("every navigation page renders with the shell (nav and wallet slot)", async () => {
  for (const n of NAV) {
    const p = await page(n.href);
    assert.equal(p.status, 200, n.href);
    for (const m of NAV) assert.ok(p.html.includes(`>${m.label.replace("&", "&amp;")}</a>`), `${n.href} lacks nav link ${m.label}`);
    assert.match(p.html, /Solana devnet only/);
    assert.match(p.html, /<title>Fiducia<\/title>/);
    assert.match(p.html, /<strong>Fiducia<\/strong>/);
    assert.ok(p.html.includes("max-width: 100%") && p.html.includes("overflow-wrap: anywhere"), `${n.href} lacks the no-overflow rules`);
  }
});

test("catalogue: lists every fixture, filters by query string, never shows the seller's own grade claim as a grade", async () => {
  const all = await page("/");
  assert.ok(all.html.includes(`${FIXTURES.length} of ${FIXTURES.length} listings`));
  for (const l of FIXTURES) assert.ok(all.html.includes(l.meta.name.replace(/&/g, "&amp;")), l.meta.name);
  const svc = await page("/?kind=Service");
  assert.ok(svc.html.includes("Invoice OCR") && !svc.html.includes("Trip planner"));
  const flagged = await page("/?hideFlagged=1");
  assert.ok(!flagged.html.includes("B2B leads, DACH"));
  const junk = await page("/?kind=Admin&maxPrice=1e99&minGrade=Z");
  assert.equal(junk.status, 200);
});

test("listing page: assessor grade, reputation, price reasons; unknown listings are 404", async () => {
  const leads = FIXTURES.find((l) => l.meta.name === "B2B leads, DACH")!;
  const p = await page(`/listing/${leads.address}`);
  assert.equal(p.status, 200);
  assert.match(p.html, /data-testid="grade">B</);
  assert.match(p.html, /one buyer is over half of the volume/);
  assert.match(p.html, /data-testid="pii"/);
  assert.match(p.html, /data-testid="price-reasons"/);
  const fresh = FIXTURES.find((l) => l.report === null)!;
  assert.match((await page(`/listing/${fresh.address}`)).html, /data-testid="unattested"/);
  assert.equal((await page("/listing/does-not-exist")).status, 404);
});

test("buy flow: the listing offers Buy (wallet first), the deal page renders, the deal routes refuse bad input", async () => {
  const attested = FIXTURES.find((l) => l.kind === "Data" && l.report !== null)!;
  const listingHtml = (await page(`/listing/${attested.address}`)).html;
  assert.match(listingHtml, /data-testid="buy-connect"/);
  // The page carries the verifier's PUBLIC address only, never the secret half of its key.
  assert.ok(listingHtml.includes(base58Encode(Uint8Array.from(CANARY_BYTES.slice(32)))), "verifier public address missing");
  assert.ok(!listingHtml.includes(base58Encode(Uint8Array.from(CANARY_BYTES.slice(0, 32)))), "verifier secret served");
  const fresh = FIXTURES.find((l) => l.report === null)!;
  assert.match((await page(`/listing/${fresh.address}`)).html, /data-testid="buy-unavailable"/);
  const team = FIXTURES.find((l) => l.kind === "Team")!;
  assert.match((await page(`/listing/${team.address}`)).html, /Hire this team/);
  const deal = "Dea1Address11111111111111111111111111111111";
  const d = await page(`/deal/${deal}`);
  assert.equal(d.status, 200);
  assert.ok(d.html.includes(deal));
  assert.equal((await page("/deal/not-an-address!")).status, 404);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const k = await post(`/api/deals/${deal}/key`, { buyer: "x" });
  assert.equal(k.status, 400);
  assert.equal(((await k.json()) as { reason: string }).reason, "BAD_REQUEST");
  const t = await post(`/api/deals/${deal}/terms`, { terms: "{}" });
  assert.equal(t.status, 400);
  assert.equal(((await t.json()) as { reason: string }).reason, "NOT_CANONICAL");
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("no server secret, secret name or server-only module text reaches the browser", async () => {
  const forbidden = [
    CANARY_KEY, CANARY_VERIFIER, CANARY_BYTES.slice(0, 16).join(","), CANARY_MISSION_TOKEN, CANARY_FAUCET, CANARY_FAUCET_BYTES.slice(0, 16).join(","),
    CANARY_ASSESSOR, CANARY_ASSESSOR_BYTES.slice(0, 16).join(","), CANARY_CUSTODY,
    "ANTHROPIC_API_KEY", "DEAL_VERIFIER_KEY", "MISSION_SERVICE_TOKEN", "DEAL_FAUCET_KEY", "DEAL_ASSESSOR_KEY", "DEAL_CUSTODY_KEY", "BLOB_READ_WRITE_TOKEN",
    "must be a JSON array of 64 bytes", // lib/env.ts is server-only
    // The agents lane's seller chain and custody (#110) run on the server only: none of their code may ship.
    ...AGENTS_MARKERS,
  ];
  const client = files(join(WEB, ".next", "static")).filter((f) => /\.(js|css|json|txt|html)$/.test(f));
  assert.ok(client.length > 0, "no client assets found");
  for (const f of client) {
    const text = readFileSync(f, "utf8");
    for (const s of forbidden) assert.ok(!text.includes(s), `${s.slice(0, 24)}... found in ${f}`);
  }
  for (const path of [...NAV.map((n) => n.href), `/listing/${FIXTURES[0]!.address}`, "/deal/Dea1Address11111111111111111111111111111111", "/api/health"]) {
    const { html } = await page(path);
    for (const s of forbidden.slice(0, 3)) assert.ok(!html.includes(s), `canary served on ${path}`);
  }
  // Health says the capabilities exist, without their values.
  const h = (await (await fetch(`${base}/api/health`)).json()) as { capabilities: Record<string, boolean> };
  assert.deepEqual(h.capabilities, { drafting: true, verifier: true, missions: true, faucet: true, sell: true });
});

test("the agents markers are real: the server bundle has them (so their absence from the browser means something)", () => {
  const server = files(join(WEB, ".next", "server")).filter((f) => /\.(js|mjs|cjs)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  for (const m of AGENTS_MARKERS) assert.ok(server.includes(m), `${m} not in the server bundle`);
});

test("the test chain (LiteSVM, devDependencies) is in no runtime bundle, server or client", () => {
  const runtime = files(join(WEB, ".next")).filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.includes(`${join(".next", "cache")}`));
  assert.ok(runtime.length > 0);
  for (const f of runtime) assert.ok(!/litesvm/i.test(readFileSync(f, "utf8")), `litesvm in ${f}`);
});
