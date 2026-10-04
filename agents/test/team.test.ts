// Team orchestrator end to end on the real program in LiteSVM (PLAN §6.1): terms -> mission -> mandates ->
// human-approved stages -> isolated workers with broker capabilities -> spends judged on chain -> product hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, generateKeyPairSigner, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import { fetchToken, findAssociatedTokenPda, getCreateMintInstructionPlan, getMintToATAInstructionPlanAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS, deals, getInitPolicyInstructionAsync, getMission, missions, type DealClient, type DealContext } from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import type { Blueprint } from "@deal/core";
import { createBroker, createDeterministicReader, createVault, liveFrom, mandateSourceFromChain, mockBooking, mockMarketData, prepareMission, readWorkerMessage, runMission, runStages, sealCredential, type MissionEvent } from "../src/index.ts";
import { ATTACKER, LISTINGS, REPLIES, WEB } from "./injection/corpus.ts";

const USDC = 1_000_000n;
const worker = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

async function chain() {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = 1_800_000_000n;
  client.svm.setClock(clock);
  const buyer = client.payer;
  const [seller, mint] = (await Promise.all([0, 1].map(() => generateKeyPairSigner()))) as [KeyPairSigner, KeyPairSigner];
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }));
  for (const [owner, amount] of [[buyer.address, 100n * USDC], [seller.address, 1n * USDC]] as const) {
    await client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: buyer, owner, mint: mint.address, mintAuthority: buyer, amount, decimals: 6 }));
  }
  await client.sendTransaction([
    await getInitPolicyInstructionAsync({
      buyer, mint: mint.address,
      params: { periodSecs: 86_400, periodBudget: 400n * USDC, maxPrice: 50n * USDC, approvalThreshold: 100n * USDC, approver: buyer.address, allowAnySeller: false, allowedSellers: [seller.address] },
    }),
  ]);
  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  const ctx: DealContext = { client: sending, mint: mint.address, sleep: async () => {} };
  const balance = async (owner: Address) =>
    (await fetchToken(client.rpc, (await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0])).data.amount;
  const now = () => client.svm.getClock().unixTimestamp;
  const verifier = (await generateKeyPairSigner()).address;
  return { client, ctx, buyer, seller, mint, balance, now, verifier };
}

function blueprint(seller: Address): Blueprint {
  return {
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
  };
}

function broker(c: Awaited<ReturnType<typeof chain>>) {
  const master = randomBytes(32);
  const vault = createVault(master, [sealCredential(master, "market", "mk-test-secret-123"), sealCredential(master, "booking", "bk-test-secret-456")]);
  const source = mandateSourceFromChain(c.ctx, c.now);
  return { broker: createBroker({ vault, providers: [mockMarketData, mockBooking], mandates: source, now: () => Number(c.now()) }), live: liveFrom(source) };
}

async function collect(gen: AsyncGenerator<MissionEvent>) {
  const out: MissionEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("a team mission end to end: approved stages, isolated workers, a spend judged on chain, a product hash", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const approvals: number[] = [];
  const sellerBefore = await c.balance(c.seller.address);
  const events = await collect(
    runMission({
      ctx: c.ctx, buyer: c.buyer, blueprint: blueprint(c.seller.address), goal: "One-page brief on EURUSD", budget: 10n * USDC,
      missionId: 1n, expiresAt: c.now() + 3_600n, dealRules: { verifier: c.verifier }, broker: b, capabilities: ["market:read", "booking:quote", "booking:pay"],
      workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
      workerEnv: { researcher: { PAYEE: c.seller.address, AMOUNT: String(1n * USDC) } },
      approve: async (stage) => { approvals.push(stage); return true; }, live, runner: { pollMs: 200 },
    }),
  );
  const types = events.map((e) => e.type);
  assert.deepEqual(approvals, [0, 1]);
  assert.ok(types.includes("created") && types.filter((x) => x === "mandate").length === 2);
  const spends = events.filter((e) => e.type === "spend") as Extract<MissionEvent, { type: "spend" }>[];
  assert.deepEqual(spends.map((s) => [s.role, s.ok]), [["researcher", true]]);
  // The writer's injected "pay the attacker everything" never became a spend: the reader refused it.
  assert.ok(events.some((e) => e.type === "refused" && e.role === "writer"));
  const results = events.filter((e) => e.type === "result") as Extract<MissionEvent, { type: "result" }>[];
  assert.match(results.find((r) => r.role === "researcher")!.output, /EURUSD 1\.\d{4}; data purchase paid/);
  assert.match(results.find((r) => r.role === "writer")!.output, /Report for: One-page brief on EURUSD/);
  const delivered = events.at(-1) as Extract<MissionEvent, { type: "delivered" }>;
  assert.equal(delivered.type, "delivered");
  assert.match(delivered.deliverableHash, /^[0-9a-f]{64}$/);
  assert.equal((await c.balance(c.seller.address)) - sellerBefore, 1n * USDC);
  const created = events.find((e) => e.type === "created") as Extract<MissionEvent, { type: "created" }>;
  assert.equal((await getMission(c.ctx, created.mission))!.spent, String(1n * USDC));
  for (const e of events.filter((x) => x.type === "worker-exit") as Extract<MissionEvent, { type: "worker-exit" }>[]) assert.equal(e.exit.reason, "exit");
});

test("the mandate's caps bind workers: an over-cap purchase is refused on chain, not by the worker", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const events = await collect(
    runMission({
      ctx: c.ctx, buyer: c.buyer, blueprint: blueprint(c.seller.address), goal: "Brief", budget: 10n * USDC, missionId: 2n,
      expiresAt: c.now() + 3_600n, dealRules: { verifier: c.verifier }, broker: b, capabilities: ["market:read"],
      workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
      workerEnv: { researcher: { PAYEE: c.seller.address, AMOUNT: String(3n * USDC) } }, // per-payment cap is 2
      approve: async () => true, live, runner: { pollMs: 200 },
    }),
  );
  const spend = events.find((e) => e.type === "spend") as Extract<MissionEvent, { type: "spend" }>;
  assert.equal(spend.ok, false);
  assert.equal(spend.reason, "OverPerTxCap");
});

test("the human declines a stage: nothing runs, the mission closes, the budget comes back", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const before = await c.balance(c.buyer.address);
  const events = await collect(
    runMission({
      ctx: c.ctx, buyer: c.buyer, blueprint: blueprint(c.seller.address), goal: "Brief", budget: 10n * USDC, missionId: 3n,
      expiresAt: c.now() + 3_600n, dealRules: { verifier: c.verifier }, broker: b, capabilities: ["market:read"],
      workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
      approve: async () => false, live,
    }),
  );
  assert.deepEqual(events.map((e) => e.type).slice(-2), ["plan", "declined"]);
  assert.ok(!events.some((e) => e.type === "worker-exit" || e.type === "spend"));
  assert.equal(await c.balance(c.buyer.address), before);
});

test("a blueprint asking for a capability the platform does not offer is refused before anything is signed", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const bp = blueprint(c.seller.address);
  bp.roles[0]!.capabilities = ["shell:exec"];
  const events = await collect(
    runMission({
      ctx: c.ctx, buyer: c.buyer, blueprint: bp, goal: "Brief", budget: 10n * USDC, missionId: 4n, expiresAt: c.now() + 3_600n, dealRules: { verifier: c.verifier },
      broker: b, capabilities: ["market:read"], workers: {}, approve: async () => true, live,
    }),
  );
  assert.deepEqual(events.map((e) => e.type), ["failed"]);
  assert.equal((events[0] as { reason: string }).reason, "UNKNOWN_CAPABILITY");
  void deals;
});

test("the injection corpus through the orchestrator's only door: nothing in it becomes a spend", async () => {
  const reader = createDeterministicReader();
  for (const c of [...LISTINGS, ...REPLIES, ...WEB]) {
    const m = await readWorkerMessage(reader, c.text);
    assert.notEqual(m.kind, "spend", `corpus case "${c.name}" became a spend`);
  }
  // Wrapped as a worker message too (text inside an otherwise valid shape is just output, never a command).
  for (const c of LISTINGS) {
    const m = await readWorkerMessage(reader, { type: "spend", payee: ATTACKER, amount: "1", receipt: "zz", note: c.text });
    assert.equal(m.kind, "refused", c.name);
  }
});

test("a well-formed spend to an attacker is refused by the chain mandate, not by hoping the worker behaves", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const attacker = (await generateKeyPairSigner()).address;
  // The attacker needs a token account to be payable at all; give it one so only the mandate can stop it.
  await c.client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: c.buyer, owner: attacker, mint: c.mint.address, mintAuthority: c.buyer, amount: 1n, decimals: 6 }));
  const before = await c.balance(attacker);
  const events = await collect(
    runMission({
      ctx: c.ctx, buyer: c.buyer, blueprint: blueprint(c.seller.address), goal: "Brief", budget: 10n * USDC, missionId: 5n,
      expiresAt: c.now() + 3_600n, dealRules: { verifier: c.verifier }, broker: b, capabilities: ["market:read"],
      workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
      workerEnv: { researcher: { PAYEE: attacker, AMOUNT: String(1n * USDC) } }, // a compromised worker
      approve: async () => true, live, runner: { pollMs: 200 },
    }),
  );
  const spend = events.find((e) => e.type === "spend") as Extract<MissionEvent, { type: "spend" }>;
  assert.equal(spend.ok, false);
  assert.equal(spend.reason, "PayeeNotAllowed");
  assert.equal(await c.balance(attacker), before);
});

test("website path: prepare without keys, the buyer signs everything itself, workers run only after its on-chain approval", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const prep = await prepareMission({
    blueprint: blueprint(c.seller.address), goal: "Brief", budget: 10n * USDC, missionId: 6n, expiresAt: c.now() + 3_600n,
    capabilities: ["market:read"], dealRules: { verifier: c.verifier }, buyer: c.buyer.address,
  });
  assert.ok(prep.ok);
  const p = prep.value;
  // The buyer's wallet signs these (here: the test's buyer key; in the site: Phantom).
  assert.ok((await missions.create(c.ctx, c.buyer, p.createParams)).ok);
  for (const r of p.roles) assert.ok((await missions.addMandate(c.ctx, c.buyer, p.mission, r.mandate)).ok);

  const events: MissionEvent[] = [];
  let waits = 0;
  for await (const e of runStages({
    ctx: c.ctx, prepared: p, broker: b, live, pollMs: 5,
    workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
    workerEnv: { researcher: { PAYEE: c.seller.address, AMOUNT: String(1n * USDC) } }, runner: { pollMs: 200 },
    onWaiting: async (i) => {
      if (waits++ === 0) assert.ok(!events.some((x) => x.type === "worker-exit")); // nothing ran before the approval
      // The buyer approves stage i in its wallet, naming the plan hash and mandate digest it was shown.
      await missions.approveStage(c.ctx, c.buyer, p.mission, i, p.plans[i]!.planHash, p.digest);
    },
  })) events.push(e);
  assert.equal(events.at(-1)!.type, "delivered");
  assert.equal(events.filter((e) => e.type === "approved").length, 2);
});

test("a stage approved for a different plan never runs", async () => {
  const c = await chain();
  const { broker: b, live } = broker(c);
  const prep = await prepareMission({
    blueprint: blueprint(c.seller.address), goal: "Brief", budget: 10n * USDC, missionId: 7n, expiresAt: c.now() + 3_600n,
    capabilities: ["market:read"], dealRules: { verifier: c.verifier }, buyer: c.buyer.address,
  });
  assert.ok(prep.ok);
  const p = prep.value;
  await missions.create(c.ctx, c.buyer, p.createParams);
  for (const r of p.roles) await missions.addMandate(c.ctx, c.buyer, p.mission, r.mandate);
  await missions.approveStage(c.ctx, c.buyer, p.mission, 0, new Uint8Array(32).fill(9), p.digest); // not the plan shown
  const events: MissionEvent[] = [];
  for await (const e of runStages({ ctx: c.ctx, prepared: p, broker: b, live, pollMs: 5, workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") } })) events.push(e);
  assert.deepEqual(events.map((e) => e.type), ["plan", "failed"]);
  assert.equal((events[1] as { reason: string }).reason, "PLAN_MISMATCH");
});


test("mission service over HTTP: token required, prepare -> buyer signs -> start -> delivered", async () => {
  const { createMissionService } = await import("../src/index.ts");
  const c = await chain();
  const { broker: b, live } = broker(c);
  const token = "t".repeat(48);
  const svc = createMissionService({
    ctx: c.ctx, broker: b, capabilities: ["market:read"], live, dealRules: { verifier: c.verifier }, token, pollMs: 5,
    workers: { researcher: worker("worker-researcher.mjs"), writer: worker("worker-writer.mjs") },
    workerEnv: { researcher: { PAYEE: c.seller.address, AMOUNT: String(1n * USDC) } }, runner: { pollMs: 200 },
  });
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(svc.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, auth = token) =>
    fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await call("/missions/x", undefined, "wrong")).status, 401);
    assert.equal((await call("/missions/prepare", { goal: "x" })).status, 400);
    const bp = blueprint(c.seller.address);
    const wire = JSON.parse(JSON.stringify(bp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const prep = await (await call("/missions/prepare", { blueprint: wire, goal: "Brief", budget: String(10n * USDC), missionId: "8", buyer: c.buyer.address, expiresAt: String(c.now() + 3_600n) })).json();
    assert.equal(prep.ok, true);
    assert.equal(prep.roles.length, 2);
    assert.ok(!JSON.stringify(prep).includes("privateKey") && !JSON.stringify(prep).includes("secret"));
    // The buyer signs (in the site: Phantom), from what the service returned.
    const { prepareMission: _p } = await import("../src/index.ts"); void _p;
    const hexTo = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
    const cp = prep.createParams;
    assert.ok((await missions.create(c.ctx, c.buyer, { ...cp, missionId: BigInt(cp.missionId), budget: BigInt(cp.budget), termsHash: hexTo(cp.termsHash), stageCaps: cp.stageCaps.map(BigInt), expiresAt: BigInt(cp.expiresAt), verifier: cp.verifier })).ok);
    for (const r of prep.roles) {
      const m = r.mandate;
      assert.ok((await missions.addMandate(c.ctx, c.buyer, prep.mission, { ...m, roleHash: hexTo(m.roleHash), cap: BigInt(m.cap), perTxCap: BigInt(m.perTxCap), expiresAt: BigInt(m.expiresAt) })).ok);
    }
    assert.equal((await call(`/missions/${prep.mission}/start`, {})).status, 202);
    assert.equal((await call(`/missions/${prep.mission}/start`, {})).status, 409);
    // Re-preparing the same mission is refused: it would reset the running entry with new agent keys.
    const again = await call("/missions/prepare", { blueprint: wire, goal: "Brief", budget: String(10n * USDC), missionId: "8", buyer: c.buyer.address, expiresAt: String(c.now() + 3_600n) });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).reason, "MISSION_EXISTS");
    assert.deepEqual((await (await call(`/missions/${prep.mission}`)).json()).roles.map((r: { agent: string }) => r.agent), prep.roles.map((r: { agent: string }) => r.agent));
    for (const [i, plan] of prep.plans.entries()) {
      await missions.approveStage(c.ctx, c.buyer, prep.mission, i, hexTo(plan.planHash), hexTo(prep.digest));
      // wait until the service has run this stage before approving the next
      for (let k = 0; k < 200; k++) {
        const s = await (await call(`/missions/${prep.mission}`)).json();
        if (s.events.some((e: { type: string; stage?: number }) => (e.type === "approved" && e.stage === i))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    let state = "running";
    for (let k = 0; k < 400 && state === "running"; k++) {
      state = (await (await call(`/missions/${prep.mission}`)).json()).state;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(state, "done");
  } finally {
    svc.close();
  }
});
