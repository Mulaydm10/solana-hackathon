// The market library (listings, missions, mandates) against the real program in LiteSVM: results,
// never throws; refusals carry the program's error names; uncertain sends are settled by the chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import {
  getListing,
  getMandate,
  getMission,
  listings,
  mandatesDigest,
  missions,
  getDeal,
  type DealClient,
  type DealContext,
  type MandateInput,
} from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, USDC, hash, setup } from "./harness.ts";

const http429 = () => Object.assign(new Error("Failed to send transaction"), { cause: { context: { causeMessage: "HTTP error (429)" } } });

async function market() {
  const t = await setup({
    policy: (s, a) => ({ ...DEFAULT_POLICY(s, a), periodBudget: 200n * USDC, maxPrice: 50n * USDC, approvalThreshold: 40n * USDC }),
  });
  const ctx: DealContext = { client: t.client as unknown as DealClient, mint: t.mint.address, sleep: async () => {} };
  const assessor = await generateKeyPairSigner();
  await t.registerAssessors(assessor.address);
  return { t, ctx, assessor };
}

test("listings: create, attest, update and close through the library; views read back", async () => {
  const { t, ctx, assessor } = await market();
  const bad = await listings.create(ctx, t.seller, {
    listingId: 1n, kind: "Data", price: 5n * USDC, contentHash: hash(20), metaHash: hash(21), assessor: t.seller.address,
  });
  assert.deepEqual(!bad.ok && bad.reason, "AssessorNotIndependent");
  const c = await listings.create(ctx, t.seller, {
    listingId: 1n, kind: "Data", price: 5n * USDC, contentHash: hash(20), metaHash: hash(21), assessor: assessor.address,
  });
  assert.ok(c.ok, JSON.stringify(c));
  const listing = (c as { listing: Address }).listing;
  assert.equal((await getListing(ctx, listing))?.assessedAt, 0);
  assert.equal((await listings.attest(ctx, assessor, listing, hash(20), hash(30))).ok, true);
  let v = (await getListing(ctx, listing))!;
  assert.equal(v.kind, "Data");
  assert.equal(v.reportHash, "1e".repeat(32));
  assert.ok(v.assessedAt > 0);
  assert.equal((await listings.update(ctx, t.seller, listing, { price: 6n * USDC })).ok, true);
  assert.ok((await getListing(ctx, listing))!.assessedAt > 0);
  assert.equal((await listings.update(ctx, t.seller, listing, { contentHash: hash(22) })).ok, true);
  v = (await getListing(ctx, listing))!;
  assert.equal(v.assessedAt, 0);
  assert.equal(v.price, String(6n * USDC));
  assert.equal((await listings.close(ctx, t.seller, listing)).ok, true);
  assert.equal(await getListing(ctx, listing), null);
});

test("missions: the full agent flow through the library, with the digest the UI computes", async () => {
  const { t, ctx } = await market();
  const expiresAt = t.now() + 2n * HOUR;
  const m = await missions.create(ctx, t.buyer, {
    missionId: 7n, budget: 30n * USDC, termsHash: hash(50), stageCaps: [20n * USDC, 20n * USDC], expiresAt, rentLamports: 100_000_000n,
  });
  assert.ok(m.ok, JSON.stringify(m));
  const mission = (m as { mission: Address }).mission;

  const agent = await generateKeyPairSigner();
  t.client.svm.airdrop(agent.address, lamports(1_000_000_000n));
  const mandate: MandateInput = {
    agent: agent.address, roleHash: hash(60), cap: 15n * USDC, perTxCap: 6n * USDC, payees: [t.seller.address], stageMask: 0b11, expiresAt,
  };
  assert.equal((await missions.addMandate(ctx, t.buyer, mission, mandate)).ok, true);
  const digest = mandatesDigest([mandate]);
  assert.equal((await getMission(ctx, mission))!.mandatesDigest, Buffer.from(digest).toString("hex"));

  // A digest for a different mandate set is refused; the right one opens stage 0.
  const wrong = await missions.approveStage(ctx, t.buyer, mission, 0, hash(70), mandatesDigest([{ ...mandate, cap: 16n * USDC }]));
  assert.deepEqual(!wrong.ok && wrong.reason, "MandatesChanged");
  assert.equal((await missions.approveStage(ctx, t.buyer, mission, 0, hash(70), digest)).ok, true);

  assert.equal((await missions.spend(ctx, agent, mission, t.seller.address, 2n * USDC, hash(80))).ok, true);
  const over = await missions.spend(ctx, agent, mission, t.seller.address, 7n * USDC, hash(80));
  assert.deepEqual(!over.ok && over.reason, "OverPerTxCap");

  const d = await missions.openDeal(ctx, agent, mission, {
    seller: t.seller.address, dealId: 1n, amount: 5n * USDC, deadline: t.now() + HOUR, reviewSecs: 600, toleranceBps: 500,
    verifier: t.verifier.address, termsHash: hash(7),
  }, hash(81));
  assert.ok(d.ok, JSON.stringify(d));
  const deal = (d as { deal: Address }).deal;
  await t.accept(deal);
  await t.deliver(deal, 5n * USDC, t.seller, hash(9));
  assert.equal((await missions.release(ctx, agent, mission, deal, hash(9))).ok, true);
  assert.equal((await getDeal(ctx, deal))?.status, "Released");

  const view = (await getMission(ctx, mission))!;
  assert.equal(view.spent, String(7n * USDC));
  assert.equal(view.vaultBalance, String(23n * USDC));
  assert.equal((await getMandate(ctx, mission, agent.address))!.spent, String(7n * USDC));

  assert.equal((await missions.revoke(ctx, t.buyer, mission, agent.address)).ok, true);
  const stopped = await missions.spend(ctx, agent, mission, t.seller.address, 1n * USDC, hash(80));
  assert.deepEqual(!stopped.ok && stopped.reason, "MandateRevoked");

  const before = await t.balance(t.buyer.address);
  assert.equal((await missions.close(ctx, t.buyer, mission)).ok, true);
  assert.equal((await t.balance(t.buyer.address)) - before, 23n * USDC);
  assert.equal((await getMission(ctx, mission))!.closed, true);
});

test("missions.spend: a 429 after the payment landed is settled by the chain, never paid twice", async () => {
  const { t, ctx } = await market();
  const expiresAt = t.now() + 2n * HOUR;
  const mission = ((await missions.create(ctx, t.buyer, {
    missionId: 1n, budget: 30n * USDC, termsHash: hash(50), stageCaps: [20n * USDC], expiresAt,
  })) as { mission: Address }).mission;
  const agent = await generateKeyPairSigner();
  t.client.svm.airdrop(agent.address, lamports(1_000_000_000n));
  const mandate: MandateInput = {
    agent: agent.address, roleHash: hash(60), cap: 15n * USDC, perTxCap: 6n * USDC, payees: [t.seller.address], stageMask: 1, expiresAt,
  };
  await missions.addMandate(ctx, t.buyer, mission, mandate);
  await missions.approveStage(ctx, t.buyer, mission, 0, hash(70), mandatesDigest([mandate]));

  // The transaction lands, then the RPC answers 429.
  let sends = 0;
  // LiteSVM has no signature index; the library only uses it to report the landed signature.
  const rpc = new Proxy(ctx.client.rpc, {
    get: (o, k) => (k === "getSignaturesForAddress" ? () => ({ send: async () => [{ signature: "LANDED" }] }) : (o as never)[k]),
  });
  const flaky: DealClient = {
    rpc,
    sendTransaction: async (ixs) => {
      sends++;
      await (t.client as unknown as DealClient).sendTransaction(ixs);
      throw http429();
    },
  };
  const seller0 = await t.balance(t.seller.address);
  const r = await missions.spend({ ...ctx, client: flaky }, agent, mission, t.seller.address, 3n * USDC, hash(80));
  assert.deepEqual(r, { ok: true, signature: "LANDED" });
  assert.equal(sends, 1);
  assert.equal((await t.balance(t.seller.address)) - seller0, 3n * USDC);
  assert.equal((await getMandate(ctx, mission, agent.address))!.spent, String(3n * USDC));
});

test("market views: unknown accounts read as null; a spend without a mandate is refused before sending", async () => {
  const { t, ctx } = await market();
  const nobody = (await generateKeyPairSigner()).address;
  assert.equal(await getListing(ctx, nobody), null);
  assert.equal(await getMission(ctx, nobody), null);
  const agent = await generateKeyPairSigner();
  const r = await missions.spend(ctx, agent, nobody, t.seller.address, 1n, hash(1));
  assert.deepEqual(!r.ok && r.reason, "MANDATE_NOT_FOUND");
  const c = await missions.close(ctx, t.buyer, nobody);
  assert.deepEqual(!c.ok && c.reason, "MISSION_NOT_FOUND");
});
