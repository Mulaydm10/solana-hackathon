// #227 against the real deal_escrow program in LiteSVM: the owner sets the robot's rules once (mission, mandate:
// 0.50 USDC per charge, 2 USDC cap, only the pad), then the robot pays the pad on a signed meter reading with no
// human per payment. An over-limit charge and a charge to another payee are refused by the program; nothing moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createClient, generateKeyPairSigner, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import { fetchToken, findAssociatedTokenPda, getCreateMintInstructionPlan, getMintToATAInstructionPlanAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS, getDeal, getInitPolicyInstructionAsync, mandatesDigest, missions, type DealClient, type DealContext } from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import { chainChargeChain, charge, createPeaqClient, memoryLedger, type MeterReading, type PeaqEventParams } from "../src/index.ts";

const USDC = 1_000_000n;
const T0 = 1_800_000_000n;

async function fleet() {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = T0;
  client.svm.setClock(clock);
  const owner = client.payer;
  const [robot, pad, otherPad, mint, verifier] = (await Promise.all([0, 1, 2, 3, 4].map(() => generateKeyPairSigner()))) as [KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner];
  for (const s of [robot, pad, otherPad]) client.svm.airdrop(s.address, lamports(1_000_000_000n));
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer: owner, newMint: mint, decimals: 6, mintAuthority: owner.address }));
  for (const [who, amount] of [[owner.address, 20n * USDC], [pad.address, 0n], [otherPad.address, 0n]] as const) {
    await client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: owner, owner: who, mint: mint.address, mintAuthority: owner, amount, decimals: 6 }));
  }
  await client.sendTransaction([
    await getInitPolicyInstructionAsync({
      buyer: owner, mint: mint.address,
      params: { periodSecs: 86_400, periodBudget: 50n * USDC, maxPrice: 10n * USDC, approvalThreshold: 10n ** 15n, approver: owner.address, allowAnySeller: true, allowedSellers: [] },
    }),
  ]);
  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  const ctx: DealContext = { client: sending, mint: mint.address, sleep: async () => {} };
  const balance = async (who: Address) =>
    (await fetchToken(client.rpc, (await findAssociatedTokenPda({ owner: who, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0])).data.amount;

  // The owner sets the rules once: a one-stage "fleet day" mission, the robot's mandate, stage 0 approved.
  const made = await missions.create(ctx, owner, {
    missionId: 1n, budget: 3n * USDC, termsHash: new Uint8Array(32).fill(4), stageCaps: [3n * USDC], expiresAt: T0 + 21_600n, verifier: verifier.address, rentLamports: 100_000_000n,
  });
  assert.ok(made.ok, JSON.stringify(made));
  const mandate = { agent: robot.address, roleHash: new Uint8Array(32).fill(5), cap: 2n * USDC, perTxCap: USDC / 2n, payees: [pad.address], stageMask: 1, expiresAt: T0 + 21_600n };
  assert.ok((await missions.addMandate(ctx, owner, made.mission, mandate)).ok);
  assert.ok((await missions.approveStage(ctx, owner, made.mission, 0, new Uint8Array(32).fill(6), mandatesDigest([mandate]))).ok);
  return { ctx, owner, robot, pad, otherPad, mission: made.mission, vault: made.vault, balance, now: () => Number(client.svm.getClock().unixTimestamp) };
}

const padSecret = new Uint8Array(32).fill(9);
const reading = (price: bigint, nonce: string): MeterReading => ({
  padId: "pad-1", robotId: "robot-1", kWh: "1.250", startedAt: Number(T0), endedAt: Number(T0) + 600, priceMicroUsdc: price, nonce,
});

function deps(f: Awaited<ReturnType<typeof fleet>>, payee = f.pad) {
  const events: PeaqEventParams[] = [];
  const peaq = createPeaqClient({ rpcUrl: "x", deployment: "agung-2026-08-28", eventRegistry: "0x1", sourceChainId: 5 }, {
    program: DEAL_ESCROW_PROGRAM_ADDRESS, now: f.now, submit: async (p) => (events.push(p), { txHash: `0x${events.length}` }),
  });
  const chain = chainChargeChain(f.ctx, { mission: f.mission, robot: f.robot, pad: payee, now: f.now });
  return { events, d: { chain, peaq, ledger: memoryLedger(), padSecret, padPublic: ed25519.getPublicKey(padSecret), robotMachineId: 13n, padMachineId: 12n } };
}

test("robot pays the pad 0.40 USDC on the signed meter reading, then peaq events; a repeat moves nothing", async () => {
  const f = await fleet();
  const { d, events } = deps(f);
  const before = await f.balance(f.pad.address);
  const r = await charge(d, { chargeId: "charge-1", amount: 400_000n, reading: reading(400_000n, "n1") });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await f.balance(f.pad.address)) - before, 400_000n, "the pad was paid exactly 0.40");
  const deal = await getDeal(f.ctx, r.deal);
  assert.equal(deal?.status, "Released");
  assert.equal(deal?.seller, f.pad.address);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.value, 40);
  const again = await charge(d, { chargeId: "charge-1", amount: 400_000n, reading: reading(400_000n, "n1") });
  assert.ok(again.ok);
  assert.equal((await f.balance(f.pad.address)) - before, 400_000n, "no second payment");
  assert.equal(events.length, 2, "no second peaq event");
});

test("0.60 USDC is over the per-charge limit: refused by the program (OverPerTxCap), the vault keeps its money", async () => {
  const f = await fleet();
  const { d, events } = deps(f);
  const vaultBefore = (await fetchToken((f.ctx.client as DealClient).rpc as never, f.vault)).data.amount;
  const r = await charge(d, { chargeId: "charge-over", amount: 600_000n, reading: reading(600_000n, "n2") });
  assert.deepEqual(r, { ok: false, reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" });
  assert.equal((await fetchToken((f.ctx.client as DealClient).rpc as never, f.vault)).data.amount, vaultBefore);
  assert.equal(events.length, 0);
});

test("a charge to a pad the owner did not allow is refused by the program (PayeeNotAllowed)", async () => {
  const f = await fleet();
  const { d } = deps(f, f.otherPad);
  const r = await charge(d, { chargeId: "charge-other", amount: 400_000n, reading: reading(400_000n, "n3") });
  assert.equal((r as { reason: string }).reason, "PayeeNotAllowed");
});

test("the 2 USDC mandate cap holds across charges (OverMandateCap on the fifth 0.50)", async () => {
  const f = await fleet();
  const { d } = deps(f);
  for (let i = 0; i < 4; i++) assert.ok((await charge(d, { chargeId: `cap-${i}`, amount: USDC / 2n, reading: reading(USDC / 2n, `c${i}`) })).ok);
  const r = await charge(d, { chargeId: "cap-4", amount: USDC / 2n, reading: reading(USDC / 2n, "c4") });
  assert.equal((r as { reason: string }).reason, "OverMandateCap");
});
