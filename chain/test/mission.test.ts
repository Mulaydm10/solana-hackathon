// Missions and agent mandates (deal_escrow v3, PLAN §2.3). A buyer funds a mission; each team agent
// gets a mandate; nothing is spent before the buyer approves a stage; every token an agent moves is
// counted against every cap; refunds never reduce `spent`; revoke and close work in one transaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPairSigner, getAddressEncoder, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ListingKind,
  PROGRAM_ERRORS,
  dealAddress,
  fetchBuyerPolicy,
  fetchDeal,
  fetchMandate,
  fetchMission,
  findLinkPda,
  findListingPda,
  findMandatePda,
  findMissionAuthPda,
  findMissionPda,
  getAddMandateInstruction,
  getAgentChallengeInstructionAsync,
  getAgentOpenDealInstructionAsync,
  getAgentReleaseInstructionAsync,
  getAgentSpendInstructionAsync,
  getApproveStageInstructionAsync,
  getAttestListingInstruction,
  getCloseMissionInstructionAsync,
  getCreateListingInstructionAsync,
  getCreateMissionInstructionAsync,
  getRevokeMandateInstruction,
  policyAddress,
  registryAddress,
  repPairAddress,
  sellerRepAddress,
} from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, USDC, hash, programErrorCode, setup } from "./harness.ts";

const code = (name: string) => 6000 + PROGRAM_ERRORS.indexOf(name);
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => programErrorCode(e));
const enc = getAddressEncoder();
const le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
};

type MandateOpts = { cap?: bigint; perTx?: bigint; payees?: Address[]; stageMask?: number; expiresAt?: bigint };

/** Mirrors the program's running digest over mandates, so a test (or a UI) can name what it approves. */
function nextDigest(prev: Uint8Array, agent: Address, roleHash: Uint8Array, m: Required<MandateOpts>): Uint8Array {
  const h = createHash("sha256");
  for (const part of [prev, enc.encode(agent), roleHash, Uint8Array.of(m.stageMask), le(m.cap), le(m.perTx), le(m.expiresAt), ...m.payees.map((p) => enc.encode(p))]) {
    h.update(part as Uint8Array);
  }
  return new Uint8Array(h.digest());
}

async function kit(budget = 30n * USDC, stageCaps = [20n * USDC, 20n * USDC], extra: { maxBondBps?: number; minStakeBps?: number } = {}) {
  const t = await setup({
    policy: (s, a) => ({ ...DEFAULT_POLICY(s, a), periodBudget: 200n * USDC, maxPrice: 50n * USDC, approvalThreshold: 40n * USDC }),
  });
  const missionId = 1n;
  const [mission] = await findMissionPda({ buyer: t.buyer.address, missionId });
  const [auth] = await findMissionAuthPda({ mission });
  const authPolicy = await policyAddress(auth);
  const vault = (await findAssociatedTokenPda({ owner: auth, mint: t.mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const expiresAt = t.now() + 2n * HOUR;
  await t.send([
    await getCreateMissionInstructionAsync({
      buyer: t.buyer, approver: budget > 40n * USDC ? t.approver : undefined, mint: t.mint.address,
      buyerToken: await t.ata(t.buyer.address), missionId, budget, termsHash: hash(50), teamListing: t.stranger.address, stageCaps, expiresAt, rentLamports: 100_000_000n,
      verifier: t.verifier.address, minReviewSecs: 600n, minResolveSecs: 600n, maxToleranceBps: 500, maxBondBps: extra.maxBondBps ?? 1000, minStakeBps: extra.minStakeBps ?? 0,
    }),
  ]);
  let digest: Uint8Array = new Uint8Array(32);
  const agents: KeyPairSigner[] = [];
  const addMandate = async (o: MandateOpts = {}, agent?: KeyPairSigner) => {
    const a = agent ?? (await generateKeyPairSigner());
    t.client.svm.airdrop(a.address, lamports(1_000_000_000n));
    const m = { cap: o.cap ?? 10n * USDC, perTx: o.perTx ?? 5n * USDC, payees: o.payees ?? [t.seller.address], stageMask: o.stageMask ?? 0b11, expiresAt: o.expiresAt ?? expiresAt };
    const [mandate] = await findMandatePda({ mission, agent: a.address });
    await t.send([
      getAddMandateInstruction({
        buyer: t.buyer, mission, mandate, agent: a.address, roleHash: hash(60), cap: m.cap, perTxCap: m.perTx,
        payees: m.payees, stageMask: m.stageMask, expiresAt: m.expiresAt,
      }),
    ]);
    digest = nextDigest(digest, a.address, hash(60), m);
    agents.push(a);
    return a;
  };
  const approve = async (stage: number, d: Uint8Array = digest, approver?: KeyPairSigner) =>
    t.send([await getApproveStageInstructionAsync({ buyer: t.buyer, approver, mission, stage, planHash: hash(70 + stage), mandatesDigest: d })]);
  const spend = async (agent: KeyPairSigner, amount: bigint, payee: Address = t.seller.address, listing?: Address, withRegistry = true) =>
    t.send([
      await getAgentSpendInstructionAsync({
        agent, mission, mint: t.mint.address, payeeToken: await t.ata(payee), listing, amount, receiptHash: hash(80),
        registry: listing && withRegistry ? await registryAddress() : undefined,
      }),
    ]);
  let nextDeal = 1n;
  const openDeal = async (agent: KeyPairSigner, amount: bigint, o: { seller?: Address; bondBps?: number; listing?: Address; reviewSecs?: bigint; verifier?: Address; toleranceBps?: number; stake?: bigint } = {}) => {
    const dealId = nextDeal++;
    const seller = o.seller ?? t.seller.address;
    const deal = await dealAddress(auth, dealId);
    await t.send([
      await getAgentOpenDealInstructionAsync({
        agent, mission, seller, authPolicy, mint: t.mint.address, deal,
        dealVault: (await findAssociatedTokenPda({ owner: deal, mint: t.mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
        sellerRep: await sellerRepAddress(seller, t.mint.address), repPair: await repPairAddress(seller, auth, t.mint.address),
        listing: o.listing, link: o.listing ? (await findLinkPda({ deal }))[0] : undefined,
        registry: o.listing ? await registryAddress() : undefined, listingContentHash: new Uint8Array(32),
        dealId, amount, deadline: t.now() + HOUR, reviewSecs: o.reviewSecs ?? 600n, resolveSecs: 600n, toleranceBps: o.toleranceBps ?? 500, stakeRequired: o.stake ?? 0n,
        bondBps: o.bondBps ?? 0, verifier: o.verifier ?? t.verifier.address, termsHash: hash(7), receiptHash: hash(81),
      }),
    ]);
    return deal;
  };
  const dealVault = async (deal: Address) => (await findAssociatedTokenPda({ owner: deal, mint: t.mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const release = async (agent: KeyPairSigner, deal: Address, h: Uint8Array) => {
    const d = (await fetchDeal(t.client.rpc, deal)).data;
    return t.send([
      await getAgentReleaseInstructionAsync({
        agent, mission, mandate: agent.address === t.buyer.address ? undefined : (await findMandatePda({ mission, agent: agent.address }))[0], deal, authPolicy, mint: t.mint.address, dealVault: await dealVault(deal), sellerToken: await t.ata(d.seller),
        sellerRep: await sellerRepAddress(d.seller, t.mint.address), repPair: await repPairAddress(d.seller, auth, t.mint.address),
        link: (await findLinkPda({ deal }))[0], expectedDeliveryHash: h,
      }),
    ]);
  };
  const challenge = async (agent: KeyPairSigner, deal: Address) =>
    t.send([
      await getAgentChallengeInstructionAsync({
        agent, mission, mandate: agent.address === t.buyer.address ? undefined : (await findMandatePda({ mission, agent: agent.address }))[0],
        deal, mint: t.mint.address, dealVault: await dealVault(deal),
      }),
    ]);
  const revoke = async (agent: KeyPairSigner, by = t.buyer) =>
    t.send([getRevokeMandateInstruction({ buyer: by, mission, mandate: (await findMandatePda({ mission, agent: agent.address }))[0] })]);
  const close = async (by: KeyPairSigner = t.buyer) =>
    t.send([
      await getCloseMissionInstructionAsync({
        actor: by, mission, buyer: t.buyer.address, policy: t.policy, mint: t.mint.address, buyerToken: await t.ata(t.buyer.address),
      }),
    ]);
  const state = async () => (await fetchMission(t.client.rpc, mission)).data;
  const vaultBalance = async () => t.balance(auth);
  return { t, mission, auth, authPolicy, vault, expiresAt, addMandate, approve, spend, openDeal, release, challenge, revoke, close, state, vaultBalance, digest: () => digest };
}

test("create_mission: the budget moves into the mission vault and is charged to the buyer's policy", async () => {
  const k = await kit();
  assert.equal(await k.vaultBalance(), 30n * USDC);
  assert.equal((await fetchBuyerPolicy(k.t.client.rpc, k.t.policy)).data.periodSpent, 30n * USDC);
  const m = await k.state();
  assert.equal(m.budget, 30n * USDC);
  assert.equal(m.stages.length, 2);
  assert.equal(m.mandatesLocked, false);
  // The authority's policy carries the buyer's allowlist and max price for agents' deals.
  const ap = (await fetchBuyerPolicy(k.t.client.rpc, k.authPolicy)).data;
  assert.deepEqual([...ap.allowedSellers], [k.t.seller.address]);
  assert.equal(ap.maxPrice, 30n * USDC);
  assert.equal(ap.buyer, k.auth);
});

test("create_mission: approver above the threshold, valid stages and expiry", async () => {
  const t = await setup({ policy: (s, a) => ({ ...DEFAULT_POLICY(s, a), periodBudget: 200n * USDC, maxPrice: 50n * USDC, approvalThreshold: 10n * USDC }) });
  const mk = async (missionId: bigint, o: { budget?: bigint; stageCaps?: bigint[]; expiresAt?: bigint; approver?: KeyPairSigner } = {}) =>
    t.send([
      await getCreateMissionInstructionAsync({
        buyer: t.buyer, approver: o.approver, mint: t.mint.address, buyerToken: await t.ata(t.buyer.address), missionId,
        budget: o.budget ?? 20n * USDC, termsHash: hash(50), teamListing: t.stranger.address, stageCaps: o.stageCaps ?? [10n * USDC],
        expiresAt: o.expiresAt ?? t.now() + HOUR, rentLamports: 0n,
        verifier: t.verifier.address, minReviewSecs: 0n, minResolveSecs: 60n, maxToleranceBps: 500, maxBondBps: 1000, minStakeBps: 0,
      }),
    ]);
  assert.equal(await errOf(mk(1n)), code("ApprovalRequired"));
  assert.equal(await errOf(mk(2n, { approver: t.approver, stageCaps: [] })), code("BadMission"));
  assert.equal(await errOf(mk(3n, { approver: t.approver, stageCaps: [21n * USDC] })), code("BadMission"));
  assert.equal(await errOf(mk(4n, { approver: t.approver, expiresAt: t.now() })), code("BadMission"));
  assert.equal(await errOf(mk(5n, { approver: t.approver, budget: 300n * USDC })), code("OverPeriodBudget"));
  await mk(6n, { approver: t.approver });
});

test("add_mandate: caps fit the budget, stages exist, the buyer is not an agent; locked after the first approval", async () => {
  const k = await kit();
  assert.equal(await errOf(k.addMandate({ cap: 31n * USDC, perTx: 1n })), code("OverMissionBudget"));
  assert.equal(await errOf(k.addMandate({ cap: 5n * USDC, perTx: 6n * USDC })), code("BadMandate"));
  assert.equal(await errOf(k.addMandate({ stageMask: 0b100 })), code("BadMandate")); // stage 2 does not exist
  assert.equal(await errOf(k.addMandate({ stageMask: 0 })), code("BadMandate"));
  assert.equal(await errOf(k.addMandate({}, k.t.buyer as KeyPairSigner)), code("BadMandate"));
  await k.addMandate({ cap: 20n * USDC });
  assert.equal(await errOf(k.addMandate({ cap: 11n * USDC })), code("OverMissionBudget")); // 20 + 11 > 30
  await k.addMandate({ cap: 10n * USDC });
  assert.equal((await k.state()).mandateCount, 2);
  assert.deepEqual([...(await k.state()).mandatesDigest], [...k.digest()]);
  await k.approve(0);
  assert.equal(await errOf(k.addMandate({ cap: 1n * USDC, perTx: 1n })), code("MandatesLocked"));
});

test("approve_stage: binds the mandate set, goes in order, and needs the approver above the threshold", async () => {
  const k = await kit(60n * USDC, [20n * USDC, 50n * USDC]);
  await k.addMandate();
  assert.equal(await errOf(k.approve(0, hash(1))), code("MandatesChanged"));
  assert.equal(await errOf(k.approve(1)), code("BadStage"));
  await k.approve(0);
  assert.equal(await errOf(k.approve(0)), code("BadStage")); // not again
  assert.equal(await errOf(k.approve(1)), code("ApprovalRequired")); // 50 > 40 threshold
  await k.approve(1, k.digest(), k.t.approver);
  const m = await k.state();
  assert.equal(m.currentStage, 1);
  assert.deepEqual([...m.stages[1]!.planHash], [...hash(71)]);
});

test("agent_spend: nothing before approval; then every cap, payee and stage rule holds", async () => {
  const k = await kit(30n * USDC, [12n * USDC, 20n * USDC]);
  const a = await k.addMandate({ cap: 15n * USDC, perTx: 5n * USDC, stageMask: 0b01 });
  const b = await k.addMandate({ cap: 15n * USDC, perTx: 10n * USDC, stageMask: 0b11 });
  assert.equal(await errOf(k.spend(a, 1n * USDC)), code("StageNotApproved"));
  await k.approve(0);
  assert.equal(await errOf(k.spend(a, 6n * USDC)), code("OverPerTxCap"));
  assert.equal(await errOf(k.spend(a, 1n * USDC, k.t.stranger.address)), code("PayeeNotAllowed"));
  const before = await k.t.balance(k.t.seller.address);
  await k.spend(a, 5n * USDC);
  await k.spend(b, 6n * USDC);
  assert.equal((await k.t.balance(k.t.seller.address)) - before, 11n * USDC);
  assert.equal(await errOf(k.spend(b, 2n * USDC)), code("OverStageCap")); // stage 0: 11 + 2 > 12
  await k.approve(1);
  assert.equal(await errOf(k.spend(a, 1n * USDC)), code("NotThisStage")); // a works in stage 0 only
  await k.spend(b, 9n * USDC);
  assert.equal(await errOf(k.spend(b, 1n * USDC)), code("OverMandateCap")); // b: 6 + 9 = 15
  const m = await k.state();
  assert.equal(m.spent, 20n * USDC);
  assert.equal(await k.vaultBalance(), 10n * USDC);
  assert.equal((await fetchMandate(k.t.client.rpc, (await findMandatePda({ mission: k.mission, agent: b.address }))[0])).data.spent, 15n * USDC);
});

test("agent_spend: an agent cannot use another agent's mandate, and outsiders cannot spend", async () => {
  const k = await kit();
  const a = await k.addMandate();
  await k.approve(0);
  const outsider = await generateKeyPairSigner();
  k.t.client.svm.airdrop(outsider.address, lamports(1_000_000_000n));
  const [mandateA] = await findMandatePda({ mission: k.mission, agent: a.address });
  const r = await errOf(
    k.t.send([
      await getAgentSpendInstructionAsync({
        agent: outsider, mission: k.mission, mandate: mandateA, mint: k.t.mint.address, payeeToken: await k.t.ata(k.t.seller.address),
        amount: 1n * USDC, receiptHash: hash(80),
      }),
    ]),
  );
  assert.ok(r !== null);
  assert.equal(await k.vaultBalance(), 30n * USDC);
});

test("empty payee list: only the seller of an active, attested listing in this mint", async () => {
  const k = await kit();
  const a = await k.addMandate({ payees: [] });
  await k.approve(0);
  const assessor = await generateKeyPairSigner();
  await k.t.registerAssessors(assessor.address);
  await k.t.send([
    await getCreateListingInstructionAsync({
      seller: k.t.seller, mint: k.t.mint.address, listingId: 1n, kind: ListingKind.Service, price: 1n * USDC,
      contentHash: hash(20), metaHash: hash(21), termsTemplateHash: hash(22), assessor: assessor.address,
    }),
  ]);
  const [listing] = await findListingPda({ seller: k.t.seller.address, listingId: 1n });
  assert.equal(await errOf(k.spend(a, 1n * USDC)), code("PayeeNotAllowed")); // no listing given
  assert.equal(await errOf(k.spend(a, 1n * USDC, k.t.seller.address, listing)), code("PayeeNotAllowed")); // not attested
  await k.t.send([getAttestListingInstruction({ assessor, listing, contentHash: hash(20), reportHash: hash(30), registry: await registryAddress() })]);
  assert.equal(await errOf(k.spend(a, 1n * USDC, k.t.stranger.address, listing)), code("PayeeNotAllowed")); // payee is not the seller
  assert.equal(await errOf(k.spend(a, 1n * USDC, k.t.seller.address, listing, false)), code("PayeeNotAllowed")); // no registry, no trust
  await k.spend(a, 1n * USDC, k.t.seller.address, listing);
  assert.equal((await k.state()).spent, 1n * USDC);
});

test("revoke: one transaction stops the agent; expiry does too", async () => {
  const k = await kit();
  const a = await k.addMandate();
  const b = await k.addMandate();
  await k.approve(0);
  await k.spend(a, 1n * USDC);
  assert.equal(await errOf(k.revoke(a, k.t.stranger)), code("Unauthorized"));
  await k.revoke(a);
  assert.equal(await errOf(k.spend(a, 1n * USDC)), code("MandateRevoked"));
  await k.spend(b, 1n * USDC); // others keep working
  k.t.warp(2n * HOUR + 1n);
  assert.equal(await errOf(k.spend(b, 1n * USDC)), code("MissionExpired"));
});

test("agent_open_deal: a normal escrow deal with the mission as buyer, counted against every cap", async () => {
  const k = await kit();
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  assert.equal(await errOf(k.openDeal(a, 5n * USDC)), code("StageNotApproved"));
  await k.approve(0);
  assert.equal(await errOf(k.openDeal(a, 9n * USDC)), code("OverPerTxCap"));
  assert.equal(await errOf(k.openDeal(a, 1n * USDC, { seller: k.t.stranger.address })), code("PayeeNotAllowed"));
  const deal = await k.openDeal(a, 5n * USDC, { bondBps: 1000 });
  const d = (await fetchDeal(k.t.client.rpc, deal)).data;
  assert.equal(d.buyer, k.auth);
  assert.equal(d.amount, 5n * USDC);
  assert.equal(await k.vaultBalance(), 25n * USDC);
  assert.equal((await k.state()).spent, 5n * USDC);
  // Seller works as usual; the agent releases; reputation counts the mission as the buyer.
  await k.t.accept(deal);
  await k.t.deliver(deal, 5n * USDC, k.t.seller, hash(9));
  const before = await k.t.balance(k.t.seller.address);
  await k.release(a, deal, hash(9));
  assert.equal((await k.t.balance(k.t.seller.address)) - before, 5n * USDC);
  assert.equal((await k.t.rep(k.t.seller.address))!.completed, 1n);
});

test("the buyer's allowlist and max price still bind deals an agent opens", async () => {
  const k = await kit();
  const a = await k.addMandate({ payees: [k.t.seller.address, k.t.stranger.address] });
  await k.approve(0);
  assert.equal(await errOf(k.openDeal(a, 1n * USDC, { seller: k.t.stranger.address })), code("SellerNotAllowed"));
});

test("agent_challenge: the bond counts as spend; a refund returns to the vault but never reduces spent", async () => {
  const k = await kit();
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 6n * USDC });
  await k.approve(0);
  const deal = await k.openDeal(a, 5n * USDC, { bondBps: 1000 });
  await k.t.accept(deal);
  await k.t.deliver(deal, 5n * USDC, k.t.seller, hash(9));
  await k.challenge(a, deal);
  assert.equal((await k.state()).spent, 5_500_000n); // 5 + 0.5 bond
  assert.equal(await k.vaultBalance(), 24_500_000n);
  // Verifier upholds the challenge: order + bond come back to the mission vault.
  await k.t.resolve(deal, false);
  assert.equal(await k.vaultBalance(), 30n * USDC);
  assert.equal((await k.state()).spent, 5_500_000n); // refunds never reduce spent
  // The cap still sees the earlier outflow: 5.5 spent, so only 4.5 left on this mandate.
  assert.equal(await errOf(k.spend(a, 5n * USDC)), code("OverMandateCap"));
});

test("close_mission: buyer any time, anyone after expiry; tokens and SOL go back; spends stop", async () => {
  const k = await kit();
  const a = await k.addMandate();
  await k.approve(0);
  await k.spend(a, 4n * USDC);
  assert.equal(await errOf(k.close(k.t.stranger)), code("Unauthorized"));
  const tokens0 = await k.t.balance(k.t.buyer.address);
  await k.close();
  assert.equal((await k.t.balance(k.t.buyer.address)) - tokens0, 26n * USDC);
  assert.equal(await k.vaultBalance(), 0n);
  assert.equal(k.t.client.svm.getBalance(k.auth) ?? 0n, 0n);
  // The unspent 26 is credited back to the buyer's budget; the 4 spent stays charged.
  assert.equal((await fetchBuyerPolicy(k.t.client.rpc, k.t.policy)).data.periodSpent, 4n * USDC);
  assert.equal(await errOf(k.spend(a, 1n * USDC)), code("MissionClosed"));
  await k.close(); // sweeping again is harmless
});

test("after expiry anyone may close and sweep a deal refund that arrives later", async () => {
  const k = await kit();
  const a = await k.addMandate();
  await k.approve(0);
  const deal = await k.openDeal(a, 5n * USDC);
  k.t.warp(2n * HOUR + 1n);
  await k.close(k.t.stranger); // expired: anyone
  const tokens0 = await k.t.balance(k.t.buyer.address);
  await k.t.refund(deal); // the deal's deadline also passed; its refund lands in the mission vault
  assert.equal(await k.vaultBalance(), 5n * USDC);
  await k.close(k.t.stranger);
  assert.equal((await k.t.balance(k.t.buyer.address)) - tokens0, 5n * USDC);
});

test("agents cannot weaken a deal's protections: verifier, review window and tolerance are the buyer's", async () => {
  const k = await kit();
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  await k.approve(0);
  assert.equal(await errOf(k.openDeal(a, 1n * USDC, { reviewSecs: 0n })), code("DealTermsNotAllowed")); // seller could claim at once
  assert.equal(await errOf(k.openDeal(a, 1n * USDC, { verifier: k.t.seller.address })), code("DealTermsNotAllowed")); // seller's own judge
  assert.equal(await errOf(k.openDeal(a, 1n * USDC, { toleranceBps: 2_000 })), code("DealTermsNotAllowed"));
  assert.equal((await k.state()).spent, 0n); // nothing was charged by the refused attempts
  await k.openDeal(a, 1n * USDC);
});

test("only the agent that opened a deal (or the buyer) may release or challenge it", async () => {
  const k = await kit();
  const opener = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  const rogue = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  await k.approve(0);
  const deal = await k.openDeal(opener, 5n * USDC, { bondBps: 1000 });
  await k.t.accept(deal);
  await k.t.deliver(deal, 5n * USDC, k.t.seller, hash(9));
  assert.equal(await errOf(k.release(rogue, deal, hash(9))), code("NotDealOpener"));
  assert.equal(await errOf(k.challenge(rogue, deal)), code("NotDealOpener"));
  await k.challenge(opener, deal);
  assert.equal((await fetchDeal(k.t.client.rpc, deal)).data.status, 3); // Challenged
});

test("the buyer can still challenge after revoking the agent and closing the mission", async () => {
  const k = await kit();
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  await k.approve(0);
  const deal = await k.openDeal(a, 5n * USDC, { bondBps: 1000 });
  const other = await k.openDeal(a, 2n * USDC);
  for (const d of [deal, other]) {
    await k.t.accept(d);
    await k.t.deliver(d, (await fetchDeal(k.t.client.rpc, d)).data.amount, k.t.seller, hash(9));
  }
  await k.revoke(a); // the buyer saw something wrong
  assert.equal(await errOf(k.challenge(a, deal)), code("MandateRevoked"));
  // The vault still holds 25; the buyer challenges as itself; the bond is charged to the mission.
  await k.challenge(k.t.buyer as KeyPairSigner, deal);
  assert.equal((await fetchDeal(k.t.client.rpc, deal)).data.status, 3);
  assert.equal((await k.state()).spent, 7_500_000n); // 5 + 2 opened, plus the 0.5 bond
  // The buyer closes the mission; the other delivered deal can still be released by the buyer.
  await k.close();
  const before = await k.t.balance(k.t.seller.address);
  await k.release(k.t.buyer as KeyPairSigner, other, hash(9));
  assert.equal((await k.t.balance(k.t.seller.address)) - before, 2n * USDC);
  assert.equal(await errOf(k.release(a, other, hash(9))), code("MissionClosed")); // closed is checked first
});

test("the buyer also bounds the bond and the seller's stake on agents' deals", async () => {
  const k = await kit(30n * USDC, [20n * USDC, 20n * USDC], { maxBondBps: 1000, minStakeBps: 2000 });
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  await k.approve(0);
  assert.equal(await errOf(k.openDeal(a, 5n * USDC, { bondBps: 5000, stake: 1n * USDC })), code("DealTermsNotAllowed")); // bond too high
  assert.equal(await errOf(k.openDeal(a, 5n * USDC, { stake: 999_999n })), code("DealTermsNotAllowed")); // stake under 20%
  await k.openDeal(a, 5n * USDC, { stake: 1n * USDC, bondBps: 1000 });
});

test("a pre-funded MissionDeal address cannot block an agent's purchase", async () => {
  const k = await kit();
  const a = await k.addMandate({ cap: 10n * USDC, perTx: 8n * USDC });
  await k.approve(0);
  const { findMissionDealPda } = await import("../src/index.ts");
  const deal = await dealAddress(k.auth, 1n); // the openDeal helper's first deal id
  const [record] = await findMissionDealPda({ deal });
  k.t.client.svm.airdrop(record, lamports(1_000n)); // a griefer sends dust to the predictable address
  await k.openDeal(a, 2n * USDC);
  const { fetchMissionDeal } = await import("../src/index.ts");
  assert.equal((await fetchMissionDeal(k.t.client.rpc, record)).data.agent, a.address);
});

