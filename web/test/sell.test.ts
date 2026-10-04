// The sell flow (#110) on the real program in LiteSVM: draft on the server, the seller's wallet signs
// create_listing (the browser's own builder), custody takes only the on-chain content, the marketplace assessor
// attests its OWN report (a client's is ignored), and the chain registry then shows the listing with that grade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createClient, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import { getCreateMintInstructionPlan } from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS, getListing, getSetAssessorsInstructionAsync, ListingKind, type DealClient, type DealContext } from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import { metaHash, sha256Hex, type ListingMeta } from "@deal/core";
import { acceptCustody, assessAndAttest, draftListing, type AssessDeps } from "../lib/sell.ts";
import { createListingIxs, reportLines, type DraftedListing } from "../lib/sell-tx.ts";
import { docStore, fileBlobs, keyVault, vercelBlobs, type BlobApi, type Blobs } from "../lib/storage.ts";
import { chainRegistry, type ChainListing, type ChainSource } from "../lib/chain-registry.ts";
import { POST as draftRoute } from "../app/api/sell/draft/route.ts";
import { POST as custodyRoute } from "../app/api/sell/custody/route.ts";
import { POST as assessRoute } from "../app/api/sell/assess/route.ts";

const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const CSV = ["date,region,price_eur_mwh", "2026-09-28,DE,81.2", "2026-09-29,DE,79.9", "2026-09-30,DE,84.1", "2026-10-01,DE,88.0"].join("\n") + "\n";
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const DESC = { name: "German day-ahead prices", description: "Daily DE prices, EUR/MWh.", category: "energy", tags: ["power"] };

/** In-memory bytes store (what the file and Blob backends both look like to the sell flow). */
function memBlobs(): Blobs & { all: Map<string, Uint8Array> } {
  const all = new Map<string, Uint8Array>();
  return { all, read: async (n) => all.get(n) ?? null, write: async (n, b) => void all.set(n, b) };
}

async function chain() {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = 1_800_000_000n;
  client.svm.setClock(clock);
  const payer = client.payer;
  const [seller, assessor, other, mint] = (await Promise.all([0, 1, 2, 3].map(() => generateKeyPairSigner()))) as KeyPairSigner[];
  for (const s of [seller!, assessor!, other!]) client.svm.airdrop(s.address, lamports(1_000_000_000n));
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer, newMint: mint!, decimals: 6, mintAuthority: payer.address }));
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER_V3, seeds: [getAddressEncoder().encode(DEAL_ESCROW_PROGRAM_ADDRESS)] });
  const pd = new Uint8Array(45);
  pd.set([3, 0, 0, 0], 0);
  pd[12] = 1;
  pd.set(getAddressEncoder().encode(payer.address), 13);
  client.svm.setAccount({ address: programData, data: pd, executable: false, lamports: lamports(1_000_000_000n), programAddress: LOADER_V3, space: 45n });
  await client.sendTransaction([await getSetAssessorsInstructionAsync({ authority: payer, programData, assessors: [assessor!.address, other!.address] })]);
  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  const ctx: DealContext = { client: sending, mint: mint!.address, sleep: async () => {} };
  const docsBlobs = memBlobs();
  const keysBlobs = memBlobs();
  const master = new Uint8Array(randomBytes(32));
  const deps: AssessDeps = {
    ctx, docs: docStore(docsBlobs), keys: keyVault(keysBlobs, master), assessor: assessor!, now: () => Number(client.svm.getClock().unixTimestamp),
  };
  /** What the seller's wallet does with the browser's builder: sign and send create_listing. */
  const list = async (drafted: DraftedListing, by: KeyPairSigner = seller!, id = BigInt(Math.floor(Math.random() * 1e9))) => {
    const { listing, ixs } = await createListingIxs(by, mint!.address, id, drafted);
    await sending.sendTransaction(ixs);
    return listing;
  };
  return { ctx, deps, seller: seller!, assessor: assessor!, other: other!, docsBlobs, keysBlobs, master, list };
}

async function drafted(c: Awaited<ReturnType<typeof chain>>, data: string = CSV, assessor: Address = c.assessor.address) {
  const r = await draftListing({ assessor, now: c.deps.now }, { seller: c.seller.address, ...DESC, data: b64(data) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { steps: { step: string }[]; meta: ListingMeta; listing: DraftedListing; needsConfirmation: boolean };
}

test("draft: the seller chain step by step, and the create_listing parameters (nothing stored, nothing signed)", async () => {
  const c = await chain();
  const d = await drafted(c);
  assert.deepEqual(d.steps.map((s) => s.step), ["classify", "assess", "price", "draft"]);
  assert.equal(d.listing.kind, "Data");
  assert.equal(d.listing.contentHash, sha(CSV));
  assert.equal(d.listing.metaHash, Buffer.from(metaHash(d.meta)).toString("hex"));
  assert.equal(d.listing.assessor, c.assessor.address);
  assert.equal(c.docsBlobs.all.size + c.keysBlobs.all.size, 0);
  // Credentials in the data stop the chain at the assessment, with the steps so far.
  const leaky = await draftListing({ assessor: c.assessor.address, now: c.deps.now }, { seller: c.seller.address, ...DESC, data: b64(`${CSV}token,ghp_${"a".repeat(36)}\n`) });
  assert.deepEqual([leaky.status, leaky.body.reason, (leaky.body.steps as unknown[]).length], [422, "SECRET_FOUND", 1]);
  assert.equal((await draftListing({ assessor: c.assessor.address, now: c.deps.now }, { seller: "x", ...DESC, data: b64(CSV) })).status, 400);
  assert.equal((await draftListing({ assessor: c.assessor.address, now: c.deps.now }, { seller: c.seller.address, ...DESC })).status, 400);
});

test("custody takes only the listing's on-chain content, from its seller; the key is stored sealed, apart", async () => {
  const c = await chain();
  const d = await drafted(c);
  const listing = await c.list(d.listing);
  const custody = (b: object) => acceptCustody(c.deps, { listing, seller: c.seller.address, data: b64(CSV), ...b });
  assert.equal((await custody({ data: b64(CSV.replace("81.2", "99.9")) })).body.reason, "CONTENT_MISMATCH");
  assert.equal((await custody({ seller: c.other.address })).body.reason, "WRONG_SELLER");
  assert.equal((await custody({ listing: c.other.address })).body.reason, "NOT_FOUND");
  assert.equal((await custody({ data: "" })).body.reason, "BAD_DATA");
  const r = await custody({});
  assert.deepEqual([r.status, r.body.stored], [200, "new"]);
  assert.equal((await custody({})).body.stored, "already"); // idempotent

  const ct = await c.deps.docs.getCiphertext(listing);
  assert.ok(ct && !Buffer.from(ct).includes(Buffer.from("2026-09-28")), "ciphertext, not the plaintext");
  const key = (await c.deps.keys.get(listing))!.key;
  const contains = (store: Map<string, Uint8Array>, needle: Uint8Array) => [...store.values()].some((v) => Buffer.from(v).includes(Buffer.from(needle)) || Buffer.from(v).toString().includes(Buffer.from(needle).toString("base64")) || Buffer.from(v).toString().includes(Buffer.from(needle).toString("hex")));
  assert.ok(!contains(c.docsBlobs.all, key), "the doc store never holds the key");
  assert.ok(!contains(c.keysBlobs.all, key), "the key vault holds it sealed, never in the clear");
  assert.ok([...c.docsBlobs.all.keys()].every((n) => !n.includes("key")));
  // Opened with the wrong master key, the vault yields nothing.
  assert.equal(await keyVault(c.keysBlobs, new Uint8Array(32)).get(listing), undefined);
});

test("the assessor attests its own report (a client's is ignored); the chain registry then shows the listing with that grade", async () => {
  const c = await chain();
  const d = await drafted(c);
  const listing = await c.list(d.listing);
  // Before custody there is nothing to attest.
  assert.equal((await assessAndAttest(c.deps, { listing, meta: d.meta })).body.reason, "NO_DATA");
  await acceptCustody(c.deps, { listing, seller: c.seller.address, data: b64(CSV) });
  assert.equal((await assessAndAttest(c.deps, { listing, meta: { ...d.meta, name: "Grade A, guaranteed" } })).body.reason, "META_MISMATCH");
  assert.equal((await assessAndAttest(c.deps, { listing, contentHash: "00".repeat(32) })).body.reason, "CONTENT_MISMATCH");

  // The mcp publish_listing shape, with a forged report and hash: both ignored.
  const forged = { grade: "A", note: "trust me" };
  const r = await assessAndAttest(c.deps, { listing, contentHash: d.listing.contentHash, report: forged, reportHash: sha(JSON.stringify(forged)), meta: d.meta } as never);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const onChain = (await getListing(c.ctx, listing))!;
  assert.ok(onChain.assessedAt > 0);
  assert.equal(onChain.reportHash, r.body.reportHash);
  assert.notEqual(onChain.reportHash, sha(JSON.stringify(forged)));
  const stored = (await c.deps.docs.get(listing))!;
  assert.equal(sha256Hex(stored.report!), onChain.reportHash);
  assert.equal(r.body.shown, true);

  // The site's registry, reading these documents and this chain, shows it with the assessor's grade.
  const source: ChainSource = {
    listings: async () => [toChainListing(onChain)],
    sellerRep: async () => ({ completed: 0, failed: 0, neutral: 0, volume: 0n, distinctBuyers: 0, maxPairVolume: 0n }),
    assessors: async () => [c.assessor.address],
  };
  const [shown] = await chainRegistry(source, c.deps.docs).list();
  assert.deepEqual([shown?.meta.name, shown?.report?.grade], [DESC.name, (JSON.parse(stored.report!) as { grade: string }).grade]);
});

test("a listing that names another assessor is not ours to attest", async () => {
  const c = await chain();
  const d = await drafted(c, CSV, c.other.address);
  const listing = await c.list(d.listing);
  await acceptCustody(c.deps, { listing, seller: c.seller.address, data: b64(CSV) });
  assert.equal((await assessAndAttest(c.deps, { listing, meta: d.meta })).body.reason, "NOT_OUR_LISTING");
});

test("services are re-probed by the assessor: from the full descriptor, or from verified metadata alone (what mcp sends)", async () => {
  const c = await chain();
  let probes = 0;
  const probe = async () => { probes++; return Response.json({ price: 1.09, pair: "EURUSD" }); };
  const service = { endpoint: "https://svc.example/q", input_schema: { type: "object" }, output_schema: { type: "object" }, example_input: { pair: "EURUSD" } };
  const r = await draftListing({ assessor: c.assessor.address, now: c.deps.now, probe }, { seller: c.seller.address, ...DESC, name: "FX quote", category: "market-data", service });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body as { meta: ListingMeta; listing: DraftedListing };
  assert.equal(d.listing.kind, "Service");
  const deps = { ...c.deps, probe };
  const a = await c.list(d.listing);
  assert.equal((await assessAndAttest(deps, { listing: a })).body.reason, "NEEDS_SERVICE_DESCRIPTOR");
  assert.equal((await assessAndAttest(deps, { listing: a, service })).status, 200);
  const b = await c.list(d.listing);
  const fromMeta = await assessAndAttest(deps, { listing: b, meta: d.meta });
  assert.equal(fromMeta.status, 200, JSON.stringify(fromMeta.body));
  assert.ok((await getListing(c.ctx, b))!.assessedAt > 0);
  assert.ok(probes >= 3);
  // An endpoint that answers outside its schema is not attested.
  const bad = { ...deps, probe: async () => new Response("nope", { status: 500 }) };
  assert.equal((await assessAndAttest(bad, { listing: await c.list(d.listing), service })).body.reason, "PROBE_FAILED");
});

test("storage: Vercel Blob (private objects) and files behind one interface; names never come from a request", async () => {
  const objects = new Map<string, Uint8Array>();
  const calls: { access: string }[] = [];
  const api: BlobApi = {
    put: async (p, body, o) => { calls.push(o); objects.set(p, body); return {}; },
    get: async (p, o) => { calls.push(o); const b = objects.get(p); return b ? { statusCode: 200, stream: new Response(Uint8Array.from(b)).body } : null; },
  };
  const listing = "List1111111111111111111111111111111111111111";
  for (const blobs of [vercelBlobs(api, "tok", "docs"), fileBlobs(mkdtempSync(join(tmpdir(), "docs-")))]) {
    const docs = docStore(blobs);
    assert.equal(await docs.get(listing), null);
    await docs.put(listing, { meta: "m" });
    await docs.put(listing, { report: "r" });
    assert.deepEqual(await docs.get(listing), { meta: "m", report: "r" });
    await docs.putCiphertext(listing, new Uint8Array([1, 2, 3]));
    assert.deepEqual(Array.from((await docs.getCiphertext(listing))!), [1, 2, 3]);
    await assert.rejects(docs.put("../../etc/passwd", { meta: "x" }));
    assert.equal(await docs.get("../x"), null);
    await assert.rejects(blobs.write("../x.json", new Uint8Array()));
  }
  assert.ok(calls.every((o) => o.access === "private"));
  assert.ok([...objects.keys()].every((k) => k.startsWith("docs/")));
});

test("the draft's assessment step carries its report, and the form shows it as lines (#140)", async () => {
  const c = await chain();
  const d = await drafted(c);
  const lines = reportLines((d.steps.find((s) => s.step === "assess") as { report?: Parameters<typeof reportLines>[0] }).report);
  assert.ok(lines.some((l) => l.startsWith("Quality: 4 rows, 3 columns")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("Personal data: none; secrets: none")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("Newest data: 2026-10-01")), lines.join("\n"));
});

test("/api/sell/* answer NOT_CONFIGURED without the assessor key and the custody master key", async () => {
  const saved = { a: process.env.DEAL_ASSESSOR_KEY, k: process.env.DEAL_CUSTODY_KEY };
  delete process.env.DEAL_ASSESSOR_KEY;
  delete process.env.DEAL_CUSTODY_KEY;
  try {
    for (const route of [draftRoute, custodyRoute, assessRoute]) {
      const r = await route(new Request("http://site.test/api/sell", { method: "POST", body: "{}" }));
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as { reason: string }).reason, "NOT_CONFIGURED");
    }
  } finally {
    if (saved.a !== undefined) process.env.DEAL_ASSESSOR_KEY = saved.a;
    if (saved.k !== undefined) process.env.DEAL_CUSTODY_KEY = saved.k;
  }
});

function toChainListing(l: NonNullable<Awaited<ReturnType<typeof getListing>>>): ChainListing {
  const h = (x: string) => Uint8Array.from(Buffer.from(x, "hex"));
  return {
    address: l.address, seller: l.seller, kind: ListingKind[l.kind], mint: l.mint, price: BigInt(l.price), contentHash: h(l.contentHash),
    metaHash: h(l.metaHash), assessor: l.assessor, reportHash: h(l.reportHash), assessedAt: BigInt(l.assessedAt), active: l.active,
    sales: BigInt(l.sales), createdAt: BigInt(l.createdAt),
  };
}
