// peaq v2 network setup (#272): grows the v1 fleet into a small network. Creates (or reuses) the keys for pad2, pad3
// (Solana + peaq), the insurer, the insurance verifier and the shop; registers and bonds pad2/pad3 on agung with the
// operator key (like activate.ts); gives the shop and the insurer a buyer policy; creates a NEW fleet mission whose
// robot mandate pays [pad, pad2, pad3]; makes sure every party has a token account; and writes state.json `network`
// (roles, peaq machine ids, addresses, prices). Idempotent: whatever is still live is reused. Prints addresses and
// signatures only, never a key; never funds anything itself (it lists what is missing). Run activate.ts and
// fleet-setup.ts first (the v1 pad and robot are reused).
//
//   node --import tsx scripts/machines/network-setup.ts [--dry-run] [--keys-dir DIR] [--new-mission] [--budget USDC] [--cap USDC]
//   --dry-run: reads only (agung, devnet); prints what exists, what is missing and what it would do; sends nothing.
//   env: DEAL_RPC_URL (devnet), DEAL_MINT (the site's test USDC), PEAQ_RPC_URL (agung), PEAQ_EVENT_REGISTRY
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, createKeyPairSignerFromBytes, createSolanaRpc, type Address, type TransactionSigner } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createPublicClient, formatEther, http, parseAbi, type Address as EvmAddress } from "viem";
import { getInitPolicyInstructionAsync, getMandate, getMission, getPolicy, mandatesDigest, missionAccounts, missions, safeSend, type DealClient, type DealContext } from "@deal/chain";
import { buildNetworkState, FLEET_DEFAULTS, fleetAddresses, fleetRules, loadFleetKeys, networkAddresses, readFleetState, robotMandate, writeFleetState } from "../../src/machines/setup.ts";
import { safeUrl } from "../demo-setup.ts";

const AGUNG_CHAIN_ID = 9990;
const AGUNG_EVENT_REGISTRY = "0x2DAD8905380993940e340C5cE6d313d5c2780040";
const GAS_MARGIN = 2n * 10n ** 17n; // 0.2 PEAQ for the registration transactions
const USDC = 1_000_000n;
const SOL = 1_000_000_000n;

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const fresh = args.includes("--new-mission");
const dir = args.includes("--keys-dir") ? args[args.indexOf("--keys-dir") + 1]! : join(homedir(), ".config", "fiducia", "machines");
const rpcUrl = process.env.DEAL_RPC_URL ?? "https://api.devnet.solana.com";
const peaqRpc = process.env.PEAQ_RPC_URL ?? "https://peaq-agung.api.onfinality.io/public";
const eventRegistry = (process.env.PEAQ_EVENT_REGISTRY ?? AGUNG_EVENT_REGISTRY) as EvmAddress;
const mint = process.env.DEAL_MINT as Address | undefined;

function fail(lines: string[]): never {
  for (const l of lines) console.error(`✗ ${l}`);
  process.exit(1);
}
// Decimal USDC string -> micro-USDC, exactly (no floats): digits, optional point, up to 6 decimals, > 0.
function parseUsdc(flag: string, def: bigint): bigint {
  if (!args.includes(flag)) return def;
  const v = args[args.indexOf(flag) + 1] ?? "";
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(v);
  if (!m) fail([`${flag} must be a decimal USDC amount like 10 or 7.5 (got "${v}")`]);
  const n = BigInt(m![1]!) * USDC + BigInt((m![2] ?? "").padEnd(6, "0"));
  if (n <= 0n) fail([`${flag} must be greater than 0`]);
  return n;
}
const fmt = (n: bigint, d: bigint) => `${n / d}.${(n % d).toString().padStart(d.toString().length - 1, "0").slice(0, 3)}`;
const budget = parseUsdc("--budget", FLEET_DEFAULTS.budget);
const cap = parseUsdc("--cap", FLEET_DEFAULTS.cap);
if (cap > budget) fail([`--cap (${fmt(cap, USDC)}) cannot exceed --budget (${fmt(budget, USDC)})`]);
if (/mainnet/i.test(rpcUrl)) fail([`DEAL_RPC_URL points at mainnet (${safeUrl(rpcUrl)}); this setup is devnet only`]);
if (!mint && !dry) fail(["DEAL_MINT is not set: use the site's test USDC mint (the same as Vercel's DEAL_MINT)"]);

const { keys, created } = loadFleetKeys(dir, !dry || args.includes("--keys-dir"), { network: true });
const a = fleetAddresses(keys);
const n = networkAddresses(keys);
console.log(`keys: ${dir}${created.length ? ` (created ${created.join(", ")})` : ""}${dry ? " · DRY RUN (nothing is sent)" : ""}`);
console.log(`solana: owner ${a.owner} · robot ${a.robot} · pad ${a.pad} · pad2 ${n.pad2} · pad3 ${n.pad3}`);
console.log(`solana: insurer ${n.insurer} · verifier ${n.verifier} · shop ${n.shop}`);
console.log(`peaq: operator ${a.peaqOperator} · pad ${a.padPeaq} · pad2 ${n.pad2Peaq} · pad3 ${n.pad3Peaq}`);

const state = readFleetState(dir);
const needs: string[] = []; // everything that is missing; shown together
const wouldDo: string[] = [];

// ---------- peaq (agung): pad2 and pad3 machines ----------
const pub = createPublicClient({ transport: http(peaqRpc) });
const chainId = await pub.getChainId();
if (chainId !== AGUNG_CHAIN_ID) fail([`PEAQ_RPC_URL (${safeUrl(peaqRpc)}) is chain ${chainId}, not agung (${AGUNG_CHAIN_ID}); this setup is agung only`]);
const er = parseAbi(["function identityRegistryAddress() view returns (address)", "function identityStakingAddress() view returns (address)"]);
const ir = parseAbi(["function minBond() view returns (uint256)", "function machineExists(uint256) view returns (bool)", "function machineWalletOf(uint256) view returns (address)"]);
const st = parseAbi(["function isStaked(uint256) view returns (bool)"]);
const identityRegistry = await pub.readContract({ address: eventRegistry, abi: er, functionName: "identityRegistryAddress" });
const identityStaking = await pub.readContract({ address: eventRegistry, abi: er, functionName: "identityStakingAddress" });
const minBond = await pub.readContract({ address: identityRegistry, abi: ir, functionName: "minBond" });
console.log(`agung · EventRegistry ${eventRegistry} → IdentityRegistry ${identityRegistry}, bond ${formatEther(minBond)} PEAQ each`);

/** A machine id from state that still belongs to this wallet, or null. */
async function existing(id: string | undefined, wallet: EvmAddress): Promise<bigint | null> {
  if (!id) return null;
  const m = BigInt(id);
  if (!(await pub.readContract({ address: identityRegistry, abi: ir, functionName: "machineExists", args: [m] }))) return null;
  const w = await pub.readContract({ address: identityRegistry, abi: ir, functionName: "machineWalletOf", args: [m] });
  return w.toLowerCase() === wallet.toLowerCase() ? m : null;
}
// A re-run keeps the prices already in state.json (the owner may have edited them); otherwise the defaults.
const prices = Object.fromEntries((state.network?.pads ?? []).map((p) => [p.role, BigInt(p.pricePerKwhMicro)]));
const known = (role: string) => state.network?.pads.find((p) => p.role === role)?.machineId;
const peaqIds: Record<"pad2" | "pad3", bigint | null> = {
  pad2: await existing(known("pad2"), n.pad2Peaq), pad3: await existing(known("pad3"), n.pad3Peaq),
};
const toRegister = (["pad2", "pad3"] as const).filter((r) => peaqIds[r] === null);
const peaqBalance = await pub.getBalance({ address: a.peaqOperator });
const peaqNeed = BigInt(toRegister.length) * minBond + (toRegister.length ? GAS_MARGIN : 0n);
console.log(`operator balance ${formatEther(peaqBalance)} PEAQ · to register: ${toRegister.join(", ") || "none"}`);
if (peaqBalance < peaqNeed) needs.push(`peaq operator ${a.peaqOperator} needs ≥ ${formatEther(peaqNeed)} agung PEAQ (has ${formatEther(peaqBalance)})`);
if (toRegister.length) wouldDo.push(`registerFor ${toRegister.join(" and ")} on agung (${formatEther(minBond)} PEAQ bond each)`);
const padMachineId = state.peaq?.padMachineId;
if (!padMachineId) needs.push("the v1 pad has no peaq machine yet: run activate.ts first");

// ---------- Solana (devnet) ----------
const rpc = createSolanaRpc(rpcUrl);
const tokenBalance = async (who: Address) => {
  if (!mint) return 0n;
  const [ata] = await findAssociatedTokenPda({ owner: who, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const r = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
  return r ? BigInt(r.value.amount) : 0n;
};
const sol = (who: Address) => rpc.getBalance(who).send().then((r) => r.value);
const signers: Record<string, TransactionSigner> = {};
for (const [role, kp] of Object.entries({ owner: keys.owner, shop: keys.shop, insurer: keys.insurer })) signers[role] = await createKeyPairSignerFromBytes(kp);
const ctxFor = (s: TransactionSigner): DealContext => ({
  client: createClient().use(signerPlugin(s)).use(solanaRpc({ rpcUrl })) as unknown as DealClient, mint: mint!,
});
const ctx = ctxFor(signers.owner!);
const now = Math.floor(Date.now() / 1000);

let live = false;
const missionId0 = state.network?.mission;
if (missionId0 && !fresh) {
  const m = await getMission(ctx, missionId0 as Address);
  const md = m && (await getMandate(ctx, missionId0 as Address, a.robot));
  live = !!m && !m.closed && (state.network?.expiresAt ?? 0) > now + 3_600 && !!md && !md.revoked && BigInt(md.spent) + FLEET_DEFAULTS.perCharge <= BigInt(md.cap);
  console.log(`network mission ${missionId0}: ${live ? "live, reused" : "expired, closed, revoked or spent: a new one is created"}`);
} else console.log("network mission: none yet, one is created");

const minOwnerSol = live ? SOL / 50n : FLEET_DEFAULTS.rentLamports + SOL / 10n;
const [ownerSol, ownerUsdc] = await Promise.all([sol(a.owner as Address), tokenBalance(a.owner)]);
if (ownerSol < minOwnerSol) needs.push(`owner ${a.owner} needs ≥ ${fmt(minOwnerSol, SOL)} SOL (has ${fmt(ownerSol, SOL)})`);
if (!live && mint && ownerUsdc < budget) needs.push(`owner ${a.owner} needs ≥ ${fmt(budget, USDC)} test USDC (has ${fmt(ownerUsdc, USDC)})`);
if (!mint) needs.push("DEAL_MINT is not set (the site's test USDC mint): token balances were not checked");
// Each of these signs insurance / job transactions: 0.05 SOL for fees (and rent for the deals the buyers open).
for (const [role, who] of [["shop", n.shop], ["insurer", n.insurer], ["pad", a.pad], ["pad2", n.pad2], ["pad3", n.pad3]] as const) {
  const b = await sol(who as Address);
  if (b < SOL / 20n) needs.push(`${role} ${who} needs ≥ 0.050 SOL for fees (has ${fmt(b, SOL)})`);
}
// The shop pays the robot and the insurer holds coverage: both are buyers and need test USDC to do their part.
for (const [role, who] of [["shop", n.shop], ["insurer", n.insurer]] as const) {
  if (!mint) break;
  const b = await tokenBalance(who as Address);
  if (b < USDC) needs.push(`${role} ${who} needs test USDC to operate (has ${fmt(b, USDC)}; ≥ 1.000 suggested)`);
}
const missingPolicies: string[] = [];
for (const role of ["shop", "insurer"] as const) if (mint && !(await getPolicy(ctx, signers[role]!.address))) missingPolicies.push(role);
if (missingPolicies.length) wouldDo.push(`init buyer policy for ${missingPolicies.join(" and ")}`);
if (!live) wouldDo.push("create the network mission (rent + budget), add the robot mandate (payees pad, pad2, pad3), approve stage 0");
wouldDo.push("create any missing token accounts (robot, pads, insurer, shop)");

if (dry) {
  console.log(needs.length ? "missing (fund / run these, then run without --dry-run):" : "nothing is missing");
  for (const l of needs) console.log(`  - ${l}`);
  console.log("would:");
  for (const l of wouldDo) console.log(`  - ${l}`);
  process.exit(0);
}
if (needs.length) fail(["fund these (devnet / agung), then run again:", ...needs]);

// ---------- send: register pad2 / pad3 ----------
const ids: Record<"pad" | "pad2" | "pad3", string> = { pad: padMachineId!, pad2: peaqIds.pad2?.toString() ?? "", pad3: peaqIds.pad3?.toString() ?? "" };
if (toRegister.length) {
  process.env.PEAQOS_TELEMETRY ??= "0";
  const { PeaqosClient } = await import("@peaqos/peaq-os-sdk");
  const unused = "0x0000000000000000000000000000000000000001" as const;
  const client = new PeaqosClient({
    rpcUrl: peaqRpc, privateKey: keys.peaqOperator,
    contracts: { identityRegistry, identityStaking, eventRegistry, machineNft: unused, didRegistry: unused, batchPrecompile: unused },
  });
  for (const who of toRegister) {
    const wallet = who === "pad2" ? n.pad2Peaq : n.pad3Peaq;
    try {
      ids[who] = (await client.registerFor(wallet)).toString();
      console.log(`${who}: registered and bonded as peaq machine ${ids[who]} (wallet ${wallet})`);
    } catch (e) {
      fail([`registerFor ${who} failed: ${(e as { code?: string }).code ?? (e instanceof Error ? e.name : "error")}`]);
    }
  }
}
for (const who of ["pad2", "pad3"] as const) {
  const staked = await pub.readContract({ address: identityStaking, abi: st, functionName: "isStaked", args: [BigInt(ids[who])] });
  console.log(`${who}: peaq machine ${ids[who]} · bonded ${staked ? "yes" : "NO (events will be refused: MachineNotBonded)"}`);
}

// ---------- send: policies for the two buyers ----------
for (const role of ["shop", "insurer"] as const) {
  const s = signers[role]!;
  const c = ctxFor(s);
  if (await getPolicy(c, s.address)) continue;
  const r = await safeSend(c, s.address, async () => !!(await getPolicy(c, s.address)), async () => [
    await getInitPolicyInstructionAsync({
      buyer: s, mint: mint!,
      params: { periodSecs: 86_400, periodBudget: 10n * USDC, maxPrice: budget, approvalThreshold: 10n ** 15n, approver: s.address, allowAnySeller: true, allowedSellers: [] },
    }),
  ]);
  if (!r.ok) fail([`init policy for ${role} refused: ${r.reason} ${r.message}`]);
  console.log(`${role}: policy created · ${r.signature}`);
}

// ---------- send: the network mission (robot pays any of the three pads) ----------
let missionAddr = state.network?.mission as string | undefined;
let missionId = state.network?.missionId;
let expiresAt = state.network?.expiresAt;
const payees = [a.pad, n.pad2, n.pad3] as Address[];
if (!live) {
  expiresAt = now + FLEET_DEFAULTS.days * 86_400;
  const id = BigInt(missionId ?? state.missionId ?? "0") + 1n; // never reuse an id the v1 mission used
  const rules = fleetRules({ robot: a.robot, pads: payees, cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt });
  const made = await missions.create(ctx, signers.owner!, {
    missionId: id, budget, termsHash: rules.hash, stageCaps: [budget], expiresAt, verifier: n.verifier as Address,
    rentLamports: FLEET_DEFAULTS.rentLamports,
  });
  if (!made.ok) fail([`create mission refused: ${made.reason} ${made.message}`]);
  missionAddr = made.mission; missionId = id.toString();
  console.log(`network mission ${made.mission} created (id ${id}, ${FLEET_DEFAULTS.days} days, budget ${fmt(budget, USDC)} USDC) · ${made.signature}`);
  // Remember it at once, so a later failure resumes with the id taken (v1 mission fields are left alone).
  writeFleetState(dir, { ...readFleetState(dir), missionId, network: buildNetworkState(keys, { machineIds: ids, prices, mission: missionAddr, missionId, expiresAt }) });
  const mandate = robotMandate({ robot: a.robot, pads: payees, cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt });
  const md = await missions.addMandate(ctx, signers.owner!, made.mission, mandate);
  if (!md.ok) fail([`add mandate refused: ${md.reason} ${md.message}`]);
  console.log(`robot mandate: ${fmt(FLEET_DEFAULTS.perCharge, USDC)} USDC per charge, ${fmt(cap, USDC)} USDC cap, payees = pad, pad2, pad3 · ${md.signature}`);
  const ap = await missions.approveStage(ctx, signers.owner!, made.mission, 0, rules.hash, mandatesDigest([mandate]));
  if (!ap.ok) fail([`approve stage 0 refused: ${ap.reason} ${ap.message}`]);
  console.log(`stage 0 approved with the rules hash ${Buffer.from(rules.hash).toString("hex").slice(0, 16)}… · ${ap.signature}`);
}

// ---------- send: token accounts (the owner pays) ----------
for (const [role, who] of [["robot", a.robot], ["pad", a.pad], ["pad2", n.pad2], ["pad3", n.pad3], ["insurer", n.insurer], ["shop", n.shop]] as const) {
  const [ata] = await findAssociatedTokenPda({ owner: who as Address, mint: mint!, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const has = async () => !!(await rpc.getAccountInfo(ata, { encoding: "base64" }).send()).value;
  if (await has()) continue;
  const r = await safeSend(ctx, ata, has, async () => [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signers.owner!, owner: who as Address, mint: mint! })]);
  if (!r.ok) fail([`${role} token account refused: ${r.reason} ${r.message}`]);
  console.log(`${role} token account ${ata} · ${r.signature}`);
}

const network = buildNetworkState(keys, { machineIds: ids, prices, mission: missionAddr!, missionId, expiresAt });
writeFleetState(dir, { ...readFleetState(dir), network });
const acc = await missionAccounts(ctx, a.owner as Address, BigInt(missionId!));
console.log(`done: network mission ${missionAddr} (vault ${acc.vault}), live until ${new Date(expiresAt! * 1000).toISOString()}`);
for (const p of network.pads) console.log(`  ${p.role}: machine ${p.machineId} · ${p.address} · ${p.pricePerKwhMicro} micro-USDC/kWh`);
console.log(`  insurer ${network.insurer} · verifier ${network.verifier} · shop ${network.shop}`);
