// The team's fee deal through the mission service (#120): the buyer opens it from the Team listing, the service
// checks it on chain before taking it, and the team seller accepts it and delivers the final product hash there,
// so the buyer can release exactly that product. Real program in LiteSVM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import { fetchToken, findAssociatedTokenPda, getCreateMintInstructionPlan, getMintToATAInstructionPlanAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS, deals, getDeal, getInitPolicyInstructionAsync, getSetAssessorsInstructionAsync, listings, missions,
  type DealClient, type DealContext,
} from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import { blueprintHash, type Blueprint } from "@deal/core";
import { createBroker, createMissionService, createVault, liveFrom, mandateSourceFromChain, mockMarketData, sealCredential } from "../src/index.ts";

const USDC = 1_000_000n;
const PRICE = 20n * USDC;
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const worker = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const hexTo = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

async function chain() {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = 1_800_000_000n;
  client.svm.setClock(clock);
  const buyer = client.payer;
  const [seller, assessor, mint] = (await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()))) as [KeyPairSigner, KeyPairSigner, KeyPairSigner];
  for (const s of [seller, assessor]) client.svm.airdrop(s.address, lamports(1_000_000_000n));
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }));
  for (const [owner, amount] of [[buyer.address, 200n * USDC], [seller.address, 1n * USDC]] as const) {
    await client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: buyer, owner, mint: mint.address, mintAuthority: buyer, amount, decimals: 6 }));
  }
  await client.sendTransaction([
    await getInitPolicyInstructionAsync({
      buyer, mint: mint.address,
      params: { periodSecs: 86_400, periodBudget: 400n * USDC, maxPrice: 50n * USDC, approvalThreshold: 100n * USDC, approver: buyer.address, allowAnySeller: false, allowedSellers: [seller.address] },
    }),
  ]);
  // Assessor registry (LiteSVM loads the program non-upgradeable, so its ProgramData is written directly).
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER_V3, seeds: [getAddressEncoder().encode(DEAL_ESCROW_PROGRAM_ADDRESS)] });
  const pd = new Uint8Array(45);
  pd.set([3, 0, 0, 0], 0);
  pd[12] = 1;
  pd.set(getAddressEncoder().encode(buyer.address), 13);
  client.svm.setAccount({ address: programData, data: pd, executable: false, lamports: lamports(1_000_000_000n), programAddress: LOADER_V3, space: 45n });
  await client.sendTransaction([await getSetAssessorsInstructionAsync({ authority: buyer, programData, assessors: [assessor.address] })]);

  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  const ctx: DealContext = { client: sending, mint: mint.address, sleep: async () => {} };
  const balance = async (owner: Address) =>
    (await fetchToken(client.rpc, (await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0])).data.amount;
  const now = () => client.svm.getClock().unixTimestamp;
  return { ctx, buyer, seller, assessor, balance, now, verifier: (await generateKeyPairSigner()).address };
}

const blueprint = (seller: Address): Blueprint => ({
  version: 1,
  name: "FX brief",
  roles: [
    { name: "researcher", purpose: "Reads FX data and buys one dataset", capabilities: ["market:read"], cap: 5n * USDC, perTxCap: 2n * USDC, payees: [seller] },
    { name: "writer", purpose: "Writes the brief", capabilities: [], cap: 1n * USDC, perTxCap: 1n * USDC, payees: [seller] },
  ],
  stages: [
    { name: "Research", roles: ["researcher"], cap: 5n * USDC, gate: "human" },
    { name: "Write", roles: ["writer"], cap: 1n * USDC, gate: "human" },
  ],
  deliverable: { description: "A one-page FX brief", check: "sha256" },
  maxDuration: 3_600,
});

test("hire -> fee deal checked on chain -> stages approved -> fee deal Delivered with the product hash -> release pays the team", async () => {
  const c = await chain();
  const bp = blueprint(c.seller.address);
  // The team's Team listing, attested by a registered assessor.
  const made = await listings.create(c.ctx, c.seller, { listingId: 1n, kind: "Team", price: PRICE, contentHash: blueprintHash(bp), metaHash: new Uint8Array(32).fill(2), assessor: c.assessor.address });
  assert.ok(made.ok, JSON.stringify(made));
  assert.ok((await listings.attest(c.ctx, c.assessor, made.listing, blueprintHash(bp), new Uint8Array(32).fill(3))).ok);

  const master = randomBytes(32);
  const source = mandateSourceFromChain(c.ctx, c.now);
  const broker = createBroker({ vault: createVault(master, [sealCredential(master, "market", "mk-test-secret-123")]), providers: [mockMarketData], mandates: source, now: () => Number(c.now()) });
  const token = "t".repeat(48);
  const svc = createMissionService({
    ctx: c.ctx, broker, capabilities: ["market:read"], live: liveFrom(source), dealRules: { verifier: c.verifier }, token, pollMs: 5,
    workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
    workerEnv: { researcher: { PAYEE: c.seller.address, AMOUNT: String(1n * USDC) } }, runner: { pollMs: 200 },
    team: { seller: c.seller },
  });
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(svc.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown) =>
    fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const wire = JSON.parse(JSON.stringify(bp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const prep = await (await call("/missions/prepare", { blueprint: wire, goal: "Brief on EURUSD", budget: String(10n * USDC), missionId: "21", buyer: c.buyer.address, expiresAt: String(c.now() + 3_600n) })).json();
    assert.equal(prep.ok, true);
    const cp = prep.createParams;
    assert.ok((await missions.create(c.ctx, c.buyer, { ...cp, missionId: BigInt(cp.missionId), budget: BigInt(cp.budget), termsHash: hexTo(cp.termsHash), stageCaps: cp.stageCaps.map(BigInt), expiresAt: BigInt(cp.expiresAt), verifier: cp.verifier })).ok);
    for (const r of prep.roles) {
      const m = r.mandate;
      assert.ok((await missions.addMandate(c.ctx, c.buyer, prep.mission, { ...m, roleHash: hexTo(m.roleHash), cap: BigInt(m.cap), perTxCap: BigInt(m.perTxCap), expiresAt: BigInt(m.expiresAt) })).ok);
    }

    // The buyer's fee deals: one for the wrong terms, one not from the listing, and the right one.
    const open = async (dealId: bigint, termsHash: string, fromListing: boolean) => {
      const r = await deals.open(c.ctx, c.buyer, {
        seller: c.seller.address, dealId, amount: PRICE, deadline: c.now() + 3_600n, reviewSecs: 600, resolveSecs: 600, verifier: c.verifier,
        termsHash: hexTo(termsHash), ...(fromListing ? { listing: made.listing, listingContentHash: blueprintHash(bp) } : {}),
      });
      assert.ok(r.ok, JSON.stringify(r));
      return r.deal;
    };
    const wrongTerms = await open(1n, "ee".repeat(32), true);
    const noListing = await open(2n, prep.terms.hash, false);
    const fee = await open(3n, prep.terms.hash, true);

    const start = async (body: unknown) => { const r = await call(`/missions/${prep.mission}/start`, body); return { status: r.status, body: await r.json() }; };
    assert.deepEqual([(await start({ feeDeal: wrongTerms })).body.reason], ["FEE_DEAL_TERMS"]);
    assert.deepEqual([(await start({ feeDeal: noListing })).body.reason], ["FEE_DEAL_NO_LISTING"]);
    assert.equal((await start({ feeDeal: (await generateKeyPairSigner()).address })).body.reason, "FEE_DEAL_NOT_FOUND");
    assert.equal((await start({ feeDeal: "../x" })).status, 400);
    assert.equal((await (await call(`/missions/${prep.mission}`)).json()).state, "prepared"); // refusals leave it startable
    assert.equal((await start({ feeDeal: fee })).status, 202);

    for (const [i, plan] of prep.plans.entries()) {
      assert.ok((await missions.approveStage(c.ctx, c.buyer, prep.mission, i, hexTo(plan.planHash), hexTo(prep.digest))).ok);
      for (let k = 0; k < 400; k++) {
        const s = await (await call(`/missions/${prep.mission}`)).json();
        if (s.events.some((e: { type: string; stage?: number }) => e.type === "approved" && e.stage === i)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    let s = { state: "running", events: [] as { type: string; deliverableHash?: string }[] };
    for (let k = 0; k < 600 && s.state === "running"; k++) {
      s = await (await call(`/missions/${prep.mission}`)).json();
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(s.state, "done", JSON.stringify(s.events));
    const product = s.events.find((e) => e.type === "delivered")!.deliverableHash!;

    const d = (await getDeal(c.ctx, fee))!;
    assert.equal(d.status, "Delivered");
    assert.equal(d.deliveryHash, product); // the team delivered exactly the final product
    const before = await c.balance(c.seller.address);
    assert.ok((await deals.release(c.ctx, c.buyer, fee, hexTo(product))).ok);
    assert.equal((await c.balance(c.seller.address)) - before, PRICE);
    // The deals the service refused were never touched by the team.
    assert.deepEqual([(await getDeal(c.ctx, wrongTerms))!.status, (await getDeal(c.ctx, noListing))!.status], ["Open", "Open"]); // never accepted
  } finally {
    svc.close();
  }
});

test("without a team seller key the service refuses a fee deal, and still runs a mission without one", async () => {
  const c = await chain();
  const source = mandateSourceFromChain(c.ctx, c.now);
  const master = randomBytes(32);
  const svc = createMissionService({
    ctx: c.ctx, broker: createBroker({ vault: createVault(master, []), providers: [], mandates: source }), capabilities: [], live: liveFrom(source),
    dealRules: { verifier: c.verifier }, token: "t".repeat(48), workers: {},
  });
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(svc.address() as { port: number }).port}`;
  const call = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${"t".repeat(48)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bp = { ...blueprint(c.seller.address), roles: [{ name: "writer", purpose: "Writes", capabilities: [], cap: 1n * USDC, perTxCap: 1n * USDC, payees: [c.seller.address] }], stages: [{ name: "Write", roles: ["writer"], cap: 1n * USDC, gate: "human" as const }] };
    const wire = JSON.parse(JSON.stringify(bp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const prep = await (await call("/missions/prepare", { blueprint: wire, goal: "Brief", budget: String(5n * USDC), missionId: "22", buyer: c.buyer.address, expiresAt: String(c.now() + 3_600n) })).json();
    assert.equal(prep.ok, true, JSON.stringify(prep));
    const r = await call(`/missions/${prep.mission}/start`, { feeDeal: c.seller.address });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).reason, "NO_TEAM_SELLER");
    assert.equal((await call(`/missions/${prep.mission}/start`, {})).status, 202);
  } finally {
    svc.close();
  }
});
