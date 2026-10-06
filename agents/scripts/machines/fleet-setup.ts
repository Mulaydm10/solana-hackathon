// Fleet setup on Solana devnet (#228): the owner sets the robot's rules once. Creates (or reuses) the keys, the
// owner's buyer policy, a one-stage "fleet day" mission funded with the budget and rent, the robot's mandate
// (per-charge limit, total cap, only the pad), approves stage 0 with the sha256 of the rules document, and makes sure
// the pad has a token account. Idempotent: a re-run reuses everything still live. Prints addresses and signatures
// only; never funds anything itself (it says what is missing).
//
//   node --import tsx scripts/machines/fleet-setup.ts [--dry-run] [--new-mission] [--keys-dir DIR]
//   env: DEAL_RPC_URL (devnet), DEAL_MINT (the site's test USDC), DEAL_VERIFIER (a verifier address, not the owner)
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getInitPolicyInstructionAsync, getMandate, getMission, getPolicy, mandatesDigest, missionAccounts, missions, safeSend, type DealClient, type DealContext } from "@deal/chain";
import { FLEET_DEFAULTS, fleetAddresses, fleetRules, loadFleetKeys, readFleetState, robotMandate, writeFleetState } from "../../src/machines/setup.ts";
import { safeUrl } from "../demo-setup.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const fresh = args.includes("--new-mission");
const dir = args.includes("--keys-dir") ? args[args.indexOf("--keys-dir") + 1]! : join(homedir(), ".config", "fiducia", "machines");
const rpcUrl = process.env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
const mint = process.env.DEAL_MINT as Address | undefined;
const verifier = process.env.DEAL_VERIFIER as Address | undefined;
const USDC = 1_000_000n;
const SOL = 1_000_000_000n;
const fmt = (n: bigint, d: bigint) => `${n / d}.${(n % d).toString().padStart(d.toString().length - 1, "0").slice(0, 3)}`;

function fail(lines: string[]): never {
  for (const l of lines) console.error(`✗ ${l}`);
  process.exit(1);
}
const problems: string[] = [];
if (/mainnet/i.test(rpcUrl)) problems.push(`DEAL_RPC_URL points at mainnet (${safeUrl(rpcUrl)}); this setup is devnet only`);
if (!mint) problems.push("DEAL_MINT is not set: use the site's test USDC mint (the same as Vercel's DEAL_MINT)");
if (!verifier) problems.push("DEAL_VERIFIER is not set: the mission's verifier address (must not be the owner)");
if (problems.length) fail(problems);

const { keys, created } = loadFleetKeys(dir, true);
const a = fleetAddresses(keys);
console.log(`keys: ${dir}${created.length ? ` (created ${created.join(", ")})` : ""}`);
console.log(`owner ${a.owner} · robot ${a.robot} · pad ${a.pad}`);
console.log(`rpc ${safeUrl(rpcUrl)} · mint ${mint} · verifier ${verifier}${dry ? " · DRY RUN (nothing is sent)" : ""}`);
if (verifier === a.owner) fail(["DEAL_VERIFIER is the owner; the program refuses that (BadMission)"]);

const owner = await createKeyPairSignerFromBytes(keys.owner);
const rpc = createSolanaRpc(rpcUrl);
const client = createClient().use(signerPlugin(owner)).use(solanaRpc({ rpcUrl })) as unknown as DealClient;
const ctx: DealContext = { client, mint: mint! };

// ---------- what exists, what is missing ----------
const state = readFleetState(dir);
const now = Math.floor(Date.now() / 1000);
const tokenBalance = async (who: Address) => {
  const [ata] = await findAssociatedTokenPda({ owner: who, mint: mint!, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const r = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
  return r ? BigInt(r.value.amount) : 0n;
};
const [ownerSol, robotSol, ownerUsdc] = await Promise.all([
  rpc.getBalance(a.owner).send().then((r) => r.value), rpc.getBalance(a.robot).send().then((r) => r.value), tokenBalance(a.owner),
]);
let live = false;
if (state.mission && !fresh) {
  const m = await getMission(ctx, state.mission as Address);
  const md = m && (await getMandate(ctx, state.mission as Address, a.robot));
  live = !!m && !m.closed && (state.expiresAt ?? 0) > now + 3_600 && !!md && !md.revoked && BigInt(md.spent) + FLEET_DEFAULTS.perCharge <= BigInt(md.cap);
  console.log(`mission ${state.mission}: ${live ? "live, reused" : "expired, closed, revoked or spent: a new one is created"}`);
}
const needs: string[] = [];
const minOwnerSol = live ? SOL / 50n : FLEET_DEFAULTS.rentLamports + SOL / 10n;
if (ownerSol < minOwnerSol) needs.push(`owner ${a.owner} needs ≥ ${fmt(minOwnerSol, SOL)} SOL (has ${fmt(ownerSol, SOL)})`);
if (robotSol < SOL / 20n) needs.push(`robot ${a.robot} needs ≥ 0.05 SOL for charge fees (has ${fmt(robotSol, SOL)})`);
if (!live && ownerUsdc < FLEET_DEFAULTS.budget) needs.push(`owner ${a.owner} needs ≥ ${fmt(FLEET_DEFAULTS.budget, USDC)} test USDC (has ${fmt(ownerUsdc, USDC)})`);
if (needs.length) fail(["fund these devnet wallets, then run again:", ...needs]);
if (dry) {
  console.log(live ? "would: check the pad's token account" : "would: init policy (if none), create mission, add mandate, approve stage 0, create the pad's token account");
  process.exit(0);
}

// ---------- the owner's one-time rules ----------
if (!(await getPolicy(ctx, a.owner))) {
  const r = await safeSend(ctx, a.owner, async () => !!(await getPolicy(ctx, a.owner)), async () => [
    await getInitPolicyInstructionAsync({
      buyer: owner, mint: mint!,
      params: { periodSecs: 86_400, periodBudget: 10n * USDC, maxPrice: FLEET_DEFAULTS.budget, approvalThreshold: 10n ** 15n, approver: a.owner, allowAnySeller: true, allowedSellers: [] },
    }),
  ]);
  if (!r.ok) fail([`init policy refused: ${r.reason} ${r.message}`]);
  console.log(`policy created · ${r.signature}`);
}

if (!live) {
  const expiresAt = now + FLEET_DEFAULTS.days * 86_400;
  const missionId = BigInt(state.missionId ?? "0") + 1n;
  const rules = fleetRules({ robot: a.robot, pad: a.pad, cap: FLEET_DEFAULTS.cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt });
  const made = await missions.create(ctx, owner, {
    missionId, budget: FLEET_DEFAULTS.budget, termsHash: rules.hash, stageCaps: [FLEET_DEFAULTS.budget], expiresAt, verifier: verifier!,
    rentLamports: FLEET_DEFAULTS.rentLamports,
  });
  if (!made.ok) fail([`create mission refused: ${made.reason} ${made.message}`]);
  console.log(`mission ${made.mission} created (id ${missionId}, ${FLEET_DEFAULTS.days} days, budget ${fmt(FLEET_DEFAULTS.budget, USDC)} USDC) · ${made.signature}`);
  writeFleetState(dir, { ...state, missionId: missionId.toString(), mission: made.mission, expiresAt });
  const mandate = robotMandate({ robot: a.robot, pad: a.pad, cap: FLEET_DEFAULTS.cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt });
  const md = await missions.addMandate(ctx, owner, made.mission, mandate);
  if (!md.ok) fail([`add mandate refused: ${md.reason} ${md.message}`]);
  console.log(`robot mandate: ${fmt(FLEET_DEFAULTS.perCharge, USDC)} USDC per charge, ${fmt(FLEET_DEFAULTS.cap, USDC)} USDC cap, payee = pad only · ${md.signature}`);
  const ap = await missions.approveStage(ctx, owner, made.mission, 0, rules.hash, mandatesDigest([mandate]));
  if (!ap.ok) fail([`approve stage 0 refused: ${ap.reason} ${ap.message}`]);
  console.log(`stage 0 approved with the rules hash ${Buffer.from(rules.hash).toString("hex").slice(0, 16)}… · ${ap.signature}`);
}

// ---------- the pad can be paid ----------
const [padAta] = await findAssociatedTokenPda({ owner: a.pad, mint: mint!, tokenProgram: TOKEN_PROGRAM_ADDRESS });
if (!(await rpc.getAccountInfo(padAta, { encoding: "base64" }).send()).value) {
  const r = await safeSend(ctx, padAta, async () => !!(await rpc.getAccountInfo(padAta, { encoding: "base64" }).send()).value, async () => [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: a.pad, mint: mint! }),
  ]);
  if (!r.ok) fail([`pad token account refused: ${r.reason} ${r.message}`]);
  console.log(`pad token account ${padAta} · ${r.signature}`);
}
const s = readFleetState(dir);
const acc = await missionAccounts(ctx, a.owner, BigInt(s.missionId!));
console.log(`done: mission ${s.mission} (vault ${acc.vault}), live until ${new Date(s.expiresAt! * 1000).toISOString()}`);

