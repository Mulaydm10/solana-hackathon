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
import { DEAL_ESCROW_PROGRAM_ADDRESS, deals, getInitPolicyInstructionAsync, getMission, type DealClient, type DealContext } from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import type { Blueprint } from "@deal/core";
import { createBroker, createVault, liveFrom, mandateSourceFromChain, mockBooking, mockMarketData, runMission, sealCredential, type MissionEvent } from "../src/index.ts";

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
  return { client, ctx, buyer, seller, mint, balance, now };
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
      missionId: 1n, expiresAt: c.now() + 3_600n, broker: b, capabilities: ["market:read", "booking:quote", "booking:pay"],
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
      expiresAt: c.now() + 3_600n, broker: b, capabilities: ["market:read"],
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
      expiresAt: c.now() + 3_600n, broker: b, capabilities: ["market:read"],
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
      ctx: c.ctx, buyer: c.buyer, blueprint: bp, goal: "Brief", budget: 10n * USDC, missionId: 4n, expiresAt: c.now() + 3_600n,
      broker: b, capabilities: ["market:read"], workers: {}, approve: async () => true, live,
    }),
  );
  assert.deepEqual(events.map((e) => e.type), ["failed"]);
  assert.equal((events[0] as { reason: string }).reason, "UNKNOWN_CAPABILITY");
  void deals;
});
