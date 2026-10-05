// One recordable agent-team mission, end to end (#183): prepare -> fee deal -> create mission + mandates ->
// the human approves stage 1 -> the researcher spends within its mandate (and one over-cap attempt is refused
// ON CHAIN) -> the human approves stage 2 -> the writer delivers -> the product hash is delivered on the fee deal
// -> the buyer releases. Prints an Explorer link for every transaction and writes a run log without secrets.
//
//   npm run demo:mission --prefix agents -- --local     the compiled program in LiteSVM: no network, no wallet
//   npm run demo:mission --prefix agents                devnet; the first run creates .keys/demo-buyer.json and
//                                                       says what to fund it with (devnet SOL + test USDC)
//   add --step to wait for Enter before each human approval (for recording)
//
//   ANTHROPIC_API_KEY  optional: Claude researcher and writer through the broker (llm:complete); the key is
//                      sealed into the broker's vault and removed from this process's env before any worker runs
//   DEMO_BUYER         keypair file of the buyer (devnet; default .keys/demo-buyer.json)
//   DEAL_RPC_URL / DEAL_MINT / DEAL_VERIFIER / LLM_MODEL   devnet RPC, Circle devnet USDC, a fresh address, claude-opus-5-5
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createClient, createKeyPairSignerFromBytes, generateKeyPairSigner, lamports, type Address, type KeyPairSigner, type TransactionSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { airdropSigner, generatedSigner, signer as signerPlugin } from "@solana/kit-plugin-signer";
import { litesvm } from "@solana/kit-plugin-litesvm";
import {
  fetchMaybeToken, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getCreateMintInstructionPlan,
  getMintToATAInstructionPlanAsync, TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { DEAL_ESCROW_PROGRAM_ADDRESS, deals, fetchMaybeBuyerPolicy, getInitPolicyInstructionAsync, missions, policyAddress, type DealClient, type DealContext } from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import { formatAmount, type Blueprint } from "@deal/core";
import {
  claudeProvider, createBroker, createVault, liveFrom, mandateSourceFromChain, mockBooking, mockMarketData, prepareMission, runStages, sealCredential,
  LLM_MODEL, type MissionEvent,
} from "../src/index.ts";

const USDC = 1_000_000n;
const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const step = args.has("--step");
const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));
const usdc = (v: bigint) => `${formatAmount(v, 6)} USDC`;

const log: string[] = [];
const say = (line = "") => { console.log(line); log.push(line); };
const fail = (m: string): never => { say(`demo-mission: ${m}`); process.exit(1); };

const rpcUrl = env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
if (!local && /mainnet/i.test(rpcUrl)) fail("mainnet is not supported");
const link = (sig: string) => (local ? `(local) ${sig}` : `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
const addr = (a: string) => (local ? a : `https://explorer.solana.com/address/${a}?cluster=devnet`);

// The model key: sealed into the broker vault, then gone from this process's environment (workers never see it).
const master = randomBytes(32);
const sealed = [sealCredential(master, "market", "mock-market-placeholder"), sealCredential(master, "booking", "mock-booking-placeholder")];
if (env.ANTHROPIC_API_KEY) sealed.push(sealCredential(master, "llm", env.ANTHROPIC_API_KEY));
delete env.ANTHROPIC_API_KEY;
const withClaude = sealed.some((c) => c.provider === "llm");

type Chain = { ctx: DealContext; buyer: TransactionSigner; now: () => bigint; send: (ixs: never[]) => Promise<unknown> };

async function localChain(): Promise<Chain> {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
  client.svm.setClock(clock);
  const buyer = client.payer;
  const mint = await generateKeyPairSigner();
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }));
  await client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: buyer, owner: buyer.address, mint: mint.address, mintAuthority: buyer, amount: 100n * USDC, decimals: 6 }));
  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  return {
    ctx: { client: sending, mint: mint.address, sleep: async () => {} }, buyer, now: () => client.svm.getClock().unixTimestamp,
    send: (ixs) => sending.sendTransaction(ixs),
  };
}

async function devnetChain(): Promise<Chain> {
  const path = env.DEMO_BUYER ?? join(here, "../.keys/demo-buyer.json");
  if (!existsSync(path)) {
    const kp = crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
    const k = await kp;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...pkcs8.slice(-32), ...pub]), { mode: 0o600 });
    const s = await createKeyPairSignerFromBytes(Uint8Array.from([...pkcs8.slice(-32), ...pub]));
    say(`Created the demo buyer ${s.address} in ${path} (devnet only; gitignored).`);
    say("Fund it once, then run this again:");
    say("  1. devnet SOL (about 0.5): https://faucet.solana.com");
    say("  2. test USDC: the site's faucet (https://fiducia-orpin.vercel.app) or https://faucet.circle.com (Solana devnet)");
    process.exit(0);
  }
  const buyer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  const client = createClient().use(signerPlugin(buyer)).use(solanaRpc({ rpcUrl }));
  const ctx: DealContext = { client: client as unknown as DealClient, mint: (env.DEAL_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") as never };
  return { ctx, buyer, now: () => BigInt(Math.floor(Date.now() / 1000)), send: (ixs) => (client as unknown as DealClient).sendTransaction(ixs) };
}

function tripPlanner(dataSeller: Address): Blueprint {
  return {
    version: 1,
    name: "Trip planner",
    roles: [
      { name: "researcher", purpose: "Researches the trip and buys one dataset", capabilities: ["market:read", "llm:complete"], cap: 3n * USDC, perTxCap: 2n * USDC, payees: [dataSeller] },
      { name: "writer", purpose: "Writes the day-by-day plan", capabilities: ["llm:complete"], cap: 1n * USDC, perTxCap: 1n * USDC, payees: [dataSeller] },
    ],
    stages: [
      { name: "Research", roles: ["researcher"], cap: 3n * USDC, gate: "human" },
      { name: "Write", roles: ["writer"], cap: 1n * USDC, gate: "human" },
    ],
    deliverable: { description: "A day-by-day trip plan", check: "sha256" },
    maxDuration: 7_200,
  };
}

const c = local ? await localChain() : await devnetChain();
const { ctx, buyer } = c;
const tokenOf = async (owner: Address) => {
  const [ata] = await findAssociatedTokenPda({ owner, mint: ctx.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const t = await fetchMaybeToken(ctx.client.rpc as never, ata);
  return t.exists ? t.data.amount : 0n;
};

const [teamSeller, dataSeller] = (await Promise.all([0, 1].map(() => generateKeyPairSigner()))) as [KeyPairSigner, KeyPairSigner];
const verifier = (env.DEAL_VERIFIER ?? (await generateKeyPairSigner()).address) as Address;
const budget = 4n * USDC;
const fee = 1n * USDC;
const goal = env.DEMO_GOAL ?? "Plan a 3-day trip to Lisbon for two, mid-range budget";

say(`Fiducia agent-team mission demo (${local ? "local LiteSVM, compiled deal_escrow" : `devnet, ${rpcUrl}`})`);
say(`Workers: ${withClaude ? `Claude (${env.LLM_MODEL ?? LLM_MODEL}) through the broker's llm:complete` : "deterministic (set ANTHROPIC_API_KEY for Claude)"}`);
say(`Buyer ${addr(buyer.address)}`);
say(`Team seller ${teamSeller.address} · data seller ${dataSeller.address} · verifier ${verifier}`);
const have = await tokenOf(buyer.address);
if (have < budget + fee) fail(`the buyer holds ${usdc(have)}; it needs ${usdc(budget + fee)} (budget + team fee). Fund it with test USDC first.`);

// Token accounts for the sellers (paid by the buyer), and the buyer's spending policy if it has none yet.
await c.send(await Promise.all([teamSeller.address, dataSeller.address].map((owner) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: buyer, owner, mint: ctx.mint }))) as never[]);
if (!(await fetchMaybeBuyerPolicy(ctx.client.rpc as never, await policyAddress(buyer.address))).exists) {
  await c.send([await getInitPolicyInstructionAsync({
    buyer, mint: ctx.mint,
    params: { periodSecs: 86_400, periodBudget: 50n * USDC, maxPrice: 20n * USDC, approvalThreshold: 1_000n * USDC, approver: buyer.address, allowAnySeller: true, allowedSellers: [] },
  })] as never[]);
  say("Created the buyer's on-chain spending policy: 50 USDC a day, at most 20 USDC per purchase.");
}

// 1. Prepare: terms, one keypair and mandate per role, every stage's plan rendered and hashed in code.
const now = c.now();
const missionId = BigInt(Math.floor(Date.now() / 1000));
const prep = await prepareMission({
  buyer: buyer.address, blueprint: tripPlanner(dataSeller.address), goal, budget, missionId, expiresAt: now + 7_200n,
  capabilities: ["market:read", "booking:quote", "booking:pay", "llm:complete"], dealRules: { verifier },
});
if (!prep.ok) fail(`${prep.reason}: ${prep.message}`);
const p = prep.ok ? prep.value : (undefined as never);
say("");
say(`Goal: ${goal}`);
say(`Terms hash ${Buffer.from(p.terms.hash).toString("hex")} · budget ${usdc(budget)} · team fee ${usdc(fee)}`);
for (const r of p.roles) say(`  mandate ${r.role}: cap ${usdc(r.mandate.cap)}, per payment ${usdc(r.mandate.perTxCap)}, payees ${r.mandate.payees.join(", ")}`);

const ok = <T extends { ok: boolean }>(r: T, what: string): Extract<T, { ok: true }> => {
  if (!r.ok) fail(`${what} refused: ${(r as unknown as { reason: string; message: string }).reason} ${(r as unknown as { message: string }).message}`);
  return r as Extract<T, { ok: true }>;
};

// 2. The team's fee: an ordinary escrow deal committing to the same terms hash.
const feeDeal = ok(await deals.open(ctx, buyer, {
  seller: teamSeller.address, dealId: BigInt(`0x${randomBytes(8).toString("hex")}`), amount: fee, deadline: now + 7_200n, reviewSecs: 600,
  resolveSecs: 600, toleranceBps: 0, stakeRequired: 0n, bondBps: 0, verifier, termsHash: p.terms.hash,
}), "fee deal");
say(`Fee deal ${feeDeal.deal}: ${link(feeDeal.signature)}`);

// 3. The buyer funds the mission and adds one mandate per agent.
const created = ok(await missions.create(ctx, buyer, p.createParams), "create_mission");
say(`Mission ${addr(p.mission)} funded: ${link(created.signature)}`);
for (const r of p.roles) say(`Mandate for ${r.role} (agent ${r.agent.address}): ${link(ok(await missions.addMandate(ctx, buyer, p.mission, r.mandate), "add_mandate").signature)}`);

// 4. Stages: the human approves exactly the plan hash rendered in code; agents run only after that is on chain.
const source = mandateSourceFromChain(ctx, local ? c.now : undefined);
const broker = createBroker({
  vault: createVault(master, sealed), providers: [mockMarketData, mockBooking, claudeProvider({ model: env.LLM_MODEL })], mandates: source,
  now: local ? () => Number(c.now()) : undefined,
});
const workers = Object.fromEntries(["researcher", "writer"].map((r) => [r, fileURLToPath(new URL(`../workers/${r}.mjs`, import.meta.url))]));
const approved = new Set<number>();
const rl = step ? createInterface({ input: process.stdin, output: process.stdout }) : null;
let productHash = "";
for await (const e of runStages({
  ctx, broker, workers, live: liveFrom(source), prepared: p, pollMs: local ? 10 : 2_000, runner: { pollMs: local ? 200 : 2_000, maxSecs: 300 },
  workerEnv: { researcher: { TRY_OVER_CAP: "1" } },
  team: { seller: teamSeller, feeDeal: feeDeal.deal, invoice: fee },
  onWaiting: async (i) => {
    if (approved.has(i)) return;
    approved.add(i);
    const plan = p.plans[i]!;
    if (rl) await rl.question(`Press Enter to approve stage ${i} (${p.blueprint.stages[i]!.name}) as the buyer... `);
    const a = ok(await missions.approveStage(ctx, buyer, p.mission, i, plan.planHash, p.digest), `approve_stage ${i}`);
    say(`Human approved stage ${i} (${p.blueprint.stages[i]!.name}), plan hash ${Buffer.from(plan.planHash).toString("hex").slice(0, 16)}...: ${link(a.signature)}`);
  },
}) as AsyncGenerator<MissionEvent>) {
  if (e.type === "plan") say(`\nStage ${e.stage} plan (rendered in code, hash ${e.planHash.slice(0, 16)}...):\n  ${e.plan}`);
  else if (e.type === "spend") say(e.ok
    ? `Agent ${e.role} paid ${usdc(BigInt(e.amount))} to ${e.payee} within its mandate: ${link(e.signature ?? "")}`
    : `Agent ${e.role} tried to pay ${usdc(BigInt(e.amount))} to ${e.payee}: REFUSED ON CHAIN (${e.reason})`);
  else if (e.type === "result") say(`\n--- ${e.role} output ---\n${e.output}\n---`);
  else if (e.type === "refused") say(`Refused for ${e.role}: ${e.reason}`);
  else if (e.type === "failed") fail(`mission failed: ${e.reason} ${e.message}`);
  else if (e.type === "delivered") {
    productHash = e.deliverableHash;
    say(`\nTeam delivered product hash ${e.deliverableHash} on the fee deal${e.signature ? `: ${link(e.signature)}` : ""}`);
  }
}
rl?.close();
if (!productHash) fail("no product was delivered");

// 5. The buyer checks the product hash and releases the team's fee.
const released = ok(await deals.release(ctx, buyer, feeDeal.deal, Uint8Array.from(Buffer.from(productHash, "hex"))), "release");
say(`Buyer released the team fee (${usdc(fee)}) for exactly that product: ${link(released.signature)}`);
say(`Team seller balance ${usdc(await tokenOf(teamSeller.address))} · data seller balance ${usdc(await tokenOf(dataSeller.address))}`);

const dir = join(here, "../demo-runs");
mkdirSync(dir, { recursive: true });
const file = join(dir, `mission-${new Date().toISOString().replace(/[:.]/g, "-")}${local ? "-local" : ""}.log`);
writeFileSync(file, log.join("\n") + "\n");
console.log(`\nRun log: ${file}`);
process.exit(0);
