// peaq agung setup (#228, decisions in #226): registers the two simulated machines (robot, charging pad) in agung's
// 1.0 IdentityRegistry with the operator key, which bonds each with the registry's minimum (1 PEAQ) in the same call
// and makes the operator their owner, the authorised submitter of their events. The registry and staking contracts
// are read from the EventRegistry the site writes to, so events and machines always match. Idempotent: machines
// already registered (state.json) are reused. Prints addresses, machine IDs and tx hashes only.
//
//   node --import tsx scripts/machines/activate.ts [--dry-run] [--keys-dir DIR]
//   env: PEAQ_RPC_URL (agung), PEAQ_EVENT_REGISTRY (default: agung's 1.0 EventRegistry)
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, formatEther, http, parseAbi, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { fleetAddresses, loadFleetKeys, readFleetState, writeFleetState } from "../../src/machines/setup.ts";
import { safeUrl } from "../demo-setup.ts";

const AGUNG_CHAIN_ID = 9990;
const AGUNG_EVENT_REGISTRY = "0x2DAD8905380993940e340C5cE6d313d5c2780040";
const GAS_MARGIN = 2n * 10n ** 17n; // 0.2 PEAQ for the registration transactions

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const dir = args.includes("--keys-dir") ? args[args.indexOf("--keys-dir") + 1]! : join(homedir(), ".config", "fiducia", "machines");
const rpcUrl = process.env.PEAQ_RPC_URL ?? "https://peaq-agung.api.onfinality.io/public";
const eventRegistry = (process.env.PEAQ_EVENT_REGISTRY ?? AGUNG_EVENT_REGISTRY) as Address;

function fail(lines: string[]): never {
  for (const l of lines) console.error(`✗ ${l}`);
  process.exit(1);
}

const { keys, created } = loadFleetKeys(dir, true);
const a = fleetAddresses(keys);
console.log(`keys: ${dir}${created.length ? ` (created ${created.join(", ")})` : ""}`);
console.log(`peaq operator ${a.peaqOperator} · robot machine ${a.robotPeaq} · pad machine ${a.padPeaq}`);

const pub = createPublicClient({ transport: http(rpcUrl) });
const chainId = await pub.getChainId();
if (chainId !== AGUNG_CHAIN_ID) fail([`PEAQ_RPC_URL (${safeUrl(rpcUrl)}) is chain ${chainId}, not agung (${AGUNG_CHAIN_ID}); this setup is agung only (#226)`]);
const er = parseAbi(["function identityRegistryAddress() view returns (address)", "function identityStakingAddress() view returns (address)"]);
const ir = parseAbi(["function minBond() view returns (uint256)", "function machineExists(uint256) view returns (bool)", "function machineWalletOf(uint256) view returns (address)"]);
const st = parseAbi(["function isStaked(uint256) view returns (bool)"]);
const identityRegistry = await pub.readContract({ address: eventRegistry, abi: er, functionName: "identityRegistryAddress" });
const identityStaking = await pub.readContract({ address: eventRegistry, abi: er, functionName: "identityStakingAddress" });
const minBond = await pub.readContract({ address: identityRegistry, abi: ir, functionName: "minBond" });
console.log(`agung · EventRegistry ${eventRegistry} → IdentityRegistry ${identityRegistry}, IdentityStaking ${identityStaking}, bond ${formatEther(minBond)} PEAQ${dry ? " · DRY RUN" : ""}`);

const state = readFleetState(dir);
/** A machine id from state that still belongs to this machine address, or null. */
async function existing(id: string | undefined, wallet: Address): Promise<bigint | null> {
  if (!id) return null;
  const n = BigInt(id);
  if (!(await pub.readContract({ address: identityRegistry, abi: ir, functionName: "machineExists", args: [n] }))) return null;
  const w = await pub.readContract({ address: identityRegistry, abi: ir, functionName: "machineWalletOf", args: [n] });
  return w.toLowerCase() === wallet.toLowerCase() ? n : null;
}
const robotId = await existing(state.peaq?.robotMachineId, a.robotPeaq);
const padId = await existing(state.peaq?.padMachineId, a.padPeaq);
const toRegister = [robotId === null && "robot", padId === null && "pad"].filter(Boolean) as ("robot" | "pad")[];
const balance = await pub.getBalance({ address: a.peaqOperator });
const need = BigInt(toRegister.length) * minBond + (toRegister.length ? GAS_MARGIN : 0n);
console.log(`operator balance ${formatEther(balance)} PEAQ · to register: ${toRegister.join(", ") || "none"}`);
if (balance < need) {
  fail([`fund the peaq operator ${a.peaqOperator} with ≥ ${formatEther(need)} agung PEAQ (has ${formatEther(balance)}), e.g. from the agung faucet, then run again`]);
}
if (dry) {
  console.log(toRegister.length ? `would: registerFor ${toRegister.join(" and ")} (${formatEther(minBond)} PEAQ bond each)` : "would: nothing; both machines are registered");
  process.exit(0);
}

process.env.PEAQOS_TELEMETRY ??= "0";
const { PeaqosClient } = await import("@peaqos/peaq-os-sdk");
const unused = "0x0000000000000000000000000000000000000001" as const;
const client = new PeaqosClient({
  rpcUrl, privateKey: keys.peaqOperator,
  contracts: { identityRegistry, identityStaking, eventRegistry, machineNft: unused, didRegistry: unused, batchPrecompile: unused },
});
const ids: Record<"robot" | "pad", bigint | null> = { robot: robotId, pad: padId };
for (const who of toRegister) {
  const wallet = who === "robot" ? a.robotPeaq : a.padPeaq;
  try {
    const id = await client.registerFor(wallet);
    ids[who] = BigInt(id);
    console.log(`${who}: registered and bonded as peaq machine ${id} (wallet ${wallet})`);
  } catch (e) {
    fail([`registerFor ${who} failed: ${(e as { code?: string }).code ?? (e instanceof Error ? e.name : "error")}`]);
  }
  writeFleetState(dir, {
    ...readFleetState(dir),
    peaq: { network: "agung", eventRegistry, identityRegistry, robotMachineId: (ids.robot ?? 0n).toString(), padMachineId: (ids.pad ?? 0n).toString() },
  });
}
for (const who of ["robot", "pad"] as const) {
  const staked = await pub.readContract({ address: identityStaking, abi: st, functionName: "isStaked", args: [ids[who]!] });
  console.log(`${who}: peaq machine ${ids[who]} · bonded ${staked ? "yes" : "NO (events will be refused: MachineNotBonded)"}`);
}
writeFleetState(dir, {
  ...readFleetState(dir),
  peaq: { network: "agung", eventRegistry, identityRegistry, robotMachineId: ids.robot!.toString(), padMachineId: ids.pad!.toString() },
});
console.log(`done: operator ${privateKeyToAddress(keys.peaqOperator)} owns both machines and submits their events`);
