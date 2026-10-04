// Hire-a-team plumbing (#73): team blueprints, the /api/missions routes (server-only token, strict input),
// the wallet transaction builder, and event rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { blueprintHash, canonicalize, sha256Hex, validateBlueprint, DEFAULT_LIMITS, type Json } from "@deal/core";
import { createNoopSigner, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { dealAddress, getApproveStageInstructionDataDecoder, getCreateDealInstructionDataDecoder, getRevokeMandateInstruction } from "@deal/chain";
import { FIXTURES } from "../lib/registry.ts";
import { blueprintFor, TEAM_BLUEPRINTS, TRIP_DATA_SELLER, TRIP_PLANNER } from "../lib/teams.ts";
import { transactionBytes } from "../lib/wallet-tx.ts";
import { POST as prepare } from "../app/api/missions/prepare/route.ts";
import { GET as status } from "../app/api/missions/[mission]/route.ts";
import { POST as start } from "../app/api/missions/[mission]/start/route.ts";
import { describeEvent } from "../app/missions/mission-view.tsx";
import { approveStageIx, challengeIx, createMissionIx, describePlan, feeDealIx, planHashOk, releaseIx, waitingStage, type FeeDealState } from "../lib/mission-flow.ts";
import { listMissions, missionLink, saveMission } from "../lib/inbox.ts";

const BUYER = "Buyer1111111111111111111111111111111111111";
const MISSION = "Mission111111111111111111111111111111111111";
const TOKEN = "s".repeat(40);

test("every known team blueprint is valid and keyed by its own hash; the fixture Team listing finds it by content hash", () => {
  for (const [hash, bp] of Object.entries(TEAM_BLUEPRINTS)) {
    assert.ok(validateBlueprint(bp, { limits: DEFAULT_LIMITS, capabilities: ["market:read", "booking:quote", "booking:pay"] }).ok, hash);
    assert.equal(Buffer.from(blueprintHash(bp)).toString("hex"), hash);
  }
  const team = FIXTURES.find((f) => f.kind === "Team")!;
  assert.ok(blueprintFor(team.contentHash), "fixture team not hireable");
  assert.equal(blueprintFor(team.contentHash.toUpperCase()), blueprintFor(team.contentHash));
  // Any listing address works, on chain or not: only the committed content hash matters.
  assert.equal(blueprintFor("00".repeat(32)), undefined);
});

async function withService(fn: (url: string, seen: { auth: string[]; bodies: unknown[] }) => Promise<void>) {
  const seen = { auth: [] as string[], bodies: [] as unknown[] };
  const srv = createServer((req, res) => {
    seen.auth.push(req.headers.authorization ?? "");
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (b) seen.bodies.push(JSON.parse(b));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url?.endsWith("/prepare") ? { ok: true, mission: MISSION, token: "never-forwarded?" } : { ok: true, state: "running", events: [] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const saved = { u: process.env.MISSION_SERVICE_URL, t: process.env.MISSION_SERVICE_TOKEN };
  process.env.MISSION_SERVICE_URL = url;
  process.env.MISSION_SERVICE_TOKEN = TOKEN;
  try {
    await fn(url, seen);
  } finally {
    process.env.MISSION_SERVICE_URL = saved.u;
    process.env.MISSION_SERVICE_TOKEN = saved.t;
    if (saved.u === undefined) delete process.env.MISSION_SERVICE_URL;
    if (saved.t === undefined) delete process.env.MISSION_SERVICE_TOKEN;
    srv.close();
  }
}

const post = (body: unknown) => new Request("http://site/api/missions/prepare", { method: "POST", body: JSON.stringify(body) });
const params = (mission: string) => ({ params: Promise.resolve({ mission }) });

test("without the mission service configured, the routes refuse with NOT_CONFIGURED", async () => {
  delete process.env.MISSION_SERVICE_URL;
  delete process.env.MISSION_SERVICE_TOKEN;
  const r = await prepare(post({}));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { reason: string }).reason, "NOT_CONFIGURED");
});

test("prepare: strict input, the blueprint comes from the site, the token goes only to the service", async () => {
  await withService(async (_url, seen) => {
    assert.equal((await prepare(post({ team: "x", goal: "g" }))).status, 400);
    assert.equal((await prepare(post({ team: "UnknownTeam1111111111111111111111111111111", goal: "A goal", budget: "1000000", buyer: BUYER }))).status, 404);
    const r = await prepare(post({ team: "9sA4TripPlannerTeamListingAddr4444444444444", goal: "Plan Bali", budget: "10000000", buyer: BUYER, blueprint: { evil: true } }));
    assert.equal(r.status, 200);
    const sent = seen.bodies[0] as { blueprint: { name: string; roles: { cap: string }[] }; budget: string };
    assert.equal(sent.blueprint.name, "Trip planner"); // the site's blueprint, not the caller's
    assert.equal(sent.blueprint.roles[0]!.cap, "5000000");
    assert.deepEqual(seen.auth, [`Bearer ${TOKEN}`]);
    assert.ok(!JSON.stringify(await r.json()).includes(TOKEN));
  });
});

test("status and start: address-checked, passed through", async () => {
  await withService(async (_url, seen) => {
    assert.equal((await status(new Request("http://site"), params("../../etc"))).status, 400);
    assert.equal((await status(new Request("http://site"), params(MISSION))).status, 200);
    assert.equal((await start(new Request("http://site", { method: "POST" }), params(MISSION))).status, 200);
    // The fee deal is passed on to the service, address-checked; nothing else from the body is.
    const startWith = (b: unknown) => start(new Request("http://site", { method: "POST", body: JSON.stringify(b) }), params(MISSION));
    assert.equal((await startWith({ feeDeal: BUYER, extra: "x" })).status, 200);
    assert.deepEqual(seen.bodies.at(-1), { feeDeal: BUYER });
    assert.equal((await startWith({ feeDeal: "../x" })).status, 400);
    assert.ok(seen.auth.every((a) => a === `Bearer ${TOKEN}`));
  });
});

test("wallet transactions: built from generated builders, paid by the buyer, signed by nobody until the wallet does", async () => {
  const [b, m, d] = await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()));
  const buyer = createNoopSigner(b!.address);
  const ix = getRevokeMandateInstruction({ buyer, mission: m!.address, mandate: d!.address });
  const bytes = transactionBytes(buyer.address, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n }, [ix]);
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], buyer.address); // fee payer
  assert.ok(Object.values(tx.signatures).every((s) => s === null)); // nothing signed here
});

test("mission events are rendered by code; worker output is quoted, never interpreted", () => {
  assert.match(describeEvent({ type: "spend", role: "researcher", amount: "1000000", payee: "SeLLer111", ok: false, reason: "PayeeNotAllowed" }), /refused by the chain \(PayeeNotAllowed\)/);
  assert.equal(describeEvent({ type: "result", role: "writer", output: "<script>x</script>" }), "writer reported: “<script>x</script>”");
});

// ---- the hire flow's own checks (#73 acceptance: an approval of plan A cannot be replayed for plan B)

const planText = (stage: number, name: string, cap: string) => canonicalize({ mission: MISSION, stage, name, roles: ["researcher"], cap, goal: "Plan Bali" } as unknown as Json);
const DIGEST = "ab".repeat(32);

test("an approval names the plan's hash, and is only built when the plan shown hashes to it (A can't be signed as B)", async () => {
  const buyer = createNoopSigner((await generateKeyPairSigner()).address);
  const mission = (await generateKeyPairSigner()).address;
  const A = { stage: 0, plan: planText(0, "Research", "5000000"), planHash: "" };
  A.planHash = sha256Hex(A.plan);
  const B = { stage: 0, plan: planText(0, "Research", "50000000"), planHash: sha256Hex(planText(0, "Research", "50000000")) };
  assert.ok(planHashOk(A) && planHashOk(B) && A.planHash !== B.planHash);

  const a = await approveStageIx(buyer, mission, [A], 0, DIGEST);
  assert.ok(a.ok);
  const signedA = getApproveStageInstructionDataDecoder().decode(a.ix.data!);
  assert.equal(Buffer.from(signedA.planHash).toString("hex"), A.planHash);
  assert.notEqual(Buffer.from(signedA.planHash).toString("hex"), B.planHash); // the chain stores A's hash: the runtime refuses B (PLAN_MISMATCH)

  // A service that shows plan B's text under plan A's hash (or the reverse) gets nothing signed.
  const swapped = await approveStageIx(buyer, mission, [{ stage: 0, plan: B.plan, planHash: A.planHash }], 0, DIGEST);
  assert.deepEqual(!swapped.ok && swapped.reason, "PLAN_HASH_MISMATCH");
  assert.deepEqual(!(await approveStageIx(buyer, mission, [A], 1, DIGEST)).ok, true);
  assert.deepEqual(!(await approveStageIx(buyer, mission, [A], 0, "zz")).ok, true);
  assert.equal(describePlan(A.plan), "Research by researcher, spend cap 5.00 USDC");
});

test("the inbox's waiting stage is a plan without its approval", () => {
  assert.equal(waitingStage([]), null);
  assert.equal(waitingStage([{ type: "plan", stage: 0 }]), 0);
  assert.equal(waitingStage([{ type: "plan", stage: 0 }, { type: "approved", stage: 0 }]), null);
  assert.equal(waitingStage([{ type: "plan", stage: 0 }, { type: "approved", stage: 0 }, { type: "result" }, { type: "plan", stage: 1 }]), 1);
});

test("mission budget and team fee deal go in one wallet transaction, under the size limit; the fee deal is the listing's", async () => {
  const [b, v, s, l] = await Promise.all([0, 1, 2, 3].map(() => generateKeyPairSigner()));
  const buyer = createNoopSigner(b!.address);
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as never;
  const termsHash = "cd".repeat(32);
  const cm = await createMissionIx(buyer, mint, l!.address, { missionId: "281474976710655", budget: "10000000", termsHash, stageCaps: ["5000000", "1000000"], expiresAt: "1800000000", verifier: v!.address });
  const fee = await feeDealIx(buyer, { listing: { address: l!.address, seller: s!.address, price: 45_000_000n, contentHash: "ef".repeat(32) }, mint, termsHash, verifier: v!.address, deadline: 1_800_000_000n, dealId: 2n ** 64n - 1n });
  assert.equal(fee.deal, await dealAddress(buyer.address, 2n ** 64n - 1n));
  const bytes = transactionBytes(buyer.address, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n }, [cm, fee.ix]);
  assert.ok(bytes.length <= 1232, `transaction is ${bytes.length} bytes`);
  const d = getCreateDealInstructionDataDecoder().decode(fee.ix.data!);
  assert.equal(d.amount, 45_000_000n); // the listing's price
  assert.equal(Buffer.from(d.termsHash).toString("hex"), termsHash); // the mission's terms
  assert.equal(Buffer.from(d.listingContentHash).toString("hex"), "ef".repeat(32)); // refused on chain if the listing changed
  assert.equal(d.verifier, v!.address);
  assert.ok(fee.ix.accounts!.some((a) => a.address === l!.address) && fee.ix.accounts!.some((a) => a.address === s!.address));
});

test("release pays only for the final product shown; challenge only after delivery", async () => {
  const [b, s, m, deal] = await Promise.all([0, 1, 2, 3].map(() => generateKeyPairSigner()));
  const buyer = createNoopSigner(b!.address);
  const product = "12".repeat(32);
  const d: FeeDealState = { deal: deal!.address, buyer: b!.address, seller: s!.address, mint: m!.address, status: "Delivered", deliveryHash: product, listing: null };
  assert.ok((await releaseIx(buyer, d, product)).ok);
  assert.deepEqual(((r) => !r.ok && r.reason)(await releaseIx(buyer, d, "34".repeat(32))), "PRODUCT_MISMATCH");
  assert.deepEqual(((r) => !r.ok && r.reason)(await releaseIx(buyer, { ...d, status: "Funded" }, product)), "NOT_DELIVERED");
  assert.ok((await challengeIx(buyer, d)).ok);
  assert.deepEqual(((r) => !r.ok && r.reason)(await challengeIx(buyer, { ...d, status: "Released" })), "NOT_DELIVERED");
});

test("inbox memory: newest first, malformed entries dropped, blocked storage never breaks the page", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  saveMission({ mission: MISSION, feeDeal: null, team: "t", at: 1 }, store);
  saveMission({ mission: BUYER, feeDeal: MISSION, team: "t", at: 2 }, store);
  saveMission({ mission: MISSION, feeDeal: BUYER, team: "t", at: 3 }, store); // re-saving replaces
  assert.deepEqual(listMissions(store).map((x) => [x.mission, x.feeDeal]), [[MISSION, BUYER], [BUYER, MISSION]]);
  mem.set("deal.missions.v1", JSON.stringify([{ mission: "../evil", feeDeal: null, team: "t", at: 1 }, "x", null]));
  assert.deepEqual(listMissions(store), []);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(listMissions(blocked), []);
  saveMission({ mission: MISSION, feeDeal: null, team: "t", at: 1 }, blocked);
  assert.equal(missionLink({ mission: MISSION, feeDeal: BUYER }), `/missions?m=${MISSION}&fee=${BUYER}`);
});

test("the Trip planner researcher may pay the data seller and its 1 USDC purchase fits the per-payment cap; the fixture lists that blueprint", () => {
  const researcher = TRIP_PLANNER.roles.find((r) => r.name === "researcher")!;
  assert.deepEqual(researcher.payees, [TRIP_DATA_SELLER]);
  assert.ok(researcher.perTxCap >= 1_000_000n);
  const team = FIXTURES.find((f) => f.kind === "Team" && f.meta.name === "Trip planner")!;
  assert.equal(blueprintFor(team.contentHash), TRIP_PLANNER);
  assert.equal(team.meta.kind === "Team" && team.meta.blueprintHash, team.contentHash);
  // The devnet listing still commits to the first Trip planner until it is updated; it stays hireable meanwhile.
  assert.ok(blueprintFor("d0789d9f8e3dbb5c92e5f0a70b6230866f1fef26104554800dcaa7b89dafafeb"));
});
