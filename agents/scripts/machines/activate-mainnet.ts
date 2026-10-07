// peaq MAINNET fallback (#241): activates the two simulated machines (robot, charging pad) with Economics 2.0
// `activateMachine` on peaq mainnet (chain 3338), Entry tier (about $0.02 bond per machine per year). Their DID key is
// each machine's Solana ed25519 key, binding the peaq identity to the wallet that pays (or is paid) on Solana.
// Always previews first (exact PEAQ cost, nothing sent). Spends only with --spend, capped by maxNetPeaqAmount.
// Idempotent: a machine already activated (same type + credential subject => same machine ID) is reused.
//
//   node --import tsx scripts/machines/activate-mainnet.ts [--spend] [--keys-dir DIR]
//   env: PEAQ_RPC_URL (optional, peaq mainnet)
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, formatEther, http } from "viem";
import { fleetAddresses, loadFleetKeys, machineActivation, PEAQ_MAINNET, readFleetState, writeFleetState } from "../../src/machines/setup.ts";
import { safeUrl } from "../demo-setup.ts";

const args = process.argv.slice(2);
const spend = args.includes("--spend");
const dir = args.includes("--keys-dir") ? args[args.indexOf("--keys-dir") + 1]! : join(homedir(), ".config", "fiducia", "machines");
const rpcUrl = process.env.PEAQ_RPC_URL ?? PEAQ_MAINNET.rpcUrl;
const GAS_MARGIN = 5n * 10n ** 17n; // 0.5 PEAQ for activations and the first events

function fail(lines: string[]): never {
  for (const l of lines) console.error(`✗ ${l}`);
  process.exit(1);
}
const code = (e: unknown) => (e as { code?: string }).code ?? (e instanceof Error ? e.name : "error");

const { keys } = loadFleetKeys(dir, true);
const a = fleetAddresses(keys);
const pub = createPublicClient({ transport: http(rpcUrl) });
const chainId = await pub.getChainId();
if (chainId !== PEAQ_MAINNET.chainId) fail([`PEAQ_RPC_URL (${safeUrl(rpcUrl)}) is chain ${chainId}, not peaq mainnet (${PEAQ_MAINNET.chainId})`]);
console.log(`peaq mainnet · operator ${a.peaqOperator} · ${spend ? "SPEND (real PEAQ)" : "preview only (nothing is sent; add --spend to activate)"}`);

process.env.PEAQOS_TELEMETRY ??= "0";
const { PeaqosClient } = await import("@peaqos/peaq-os-sdk");
const unused = "0x0000000000000000000000000000000000000001" as const;
const client = new PeaqosClient<"tokenomics20">({
  rpcUrl, privateKey: keys.peaqOperator,
  contracts: { eventRegistry: PEAQ_MAINNET.eventRegistry, identityRegistry: unused, identityStaking: unused, machineNft: unused, didRegistry: unused, batchPrecompile: unused },
  tokenomics20: { deploymentId: "peaq-mainnet" },
});

type Plan = { role: "robot" | "pad"; params: ReturnType<typeof machineActivation>; machineId: bigint; net: bigint; active: boolean };
const plans: Plan[] = [];
for (const role of ["robot", "pad"] as const) {
  const params = machineActivation(role, role === "robot" ? keys.robot : keys.pad, a.peaqOperator);
  let preview;
  try {
    preview = await client.previewMachineActivation(params);
  } catch (e) {
    // An already-active machine cannot be previewed again: look it up by its deterministic id instead.
    const id = await client.computeMachineId(params.machineType, params.credentialSubject).catch(() => null);
    const owner = id === null ? null : await client.getMachineOwner(id).catch(() => null);
    if (id !== null && owner) {
      plans.push({ role, params, machineId: id, net: 0n, active: true });
      console.log(`${role}: already active as peaq machine ${id} (owner ${owner})`);
      continue;
    }
    fail([`preview for ${role} failed: ${code(e)}`]);
  }
  const p = preview;
  plans.push({ role, params, machineId: p.machineId, net: p.netPeaqAmount, active: false });
  console.log(`${role}: machine ${p.machineId} · Entry tier · bond ${formatEther(p.netPeaqAmount)} PEAQ`);
}

const toPay = plans.filter((p) => !p.active).reduce((s, p) => s + p.net, 0n);
const balance = await pub.getBalance({ address: a.peaqOperator });
const need = toPay + GAS_MARGIN;
console.log(`total bonds ${formatEther(toPay)} PEAQ + ~${formatEther(GAS_MARGIN)} gas margin · operator holds ${formatEther(balance)} PEAQ`);
if (balance < need) fail([`fund the operator ${a.peaqOperator} on peaq mainnet with ≥ ${formatEther(need)} PEAQ (has ${formatEther(balance)})`]);
if (!spend) {
  console.log("ready: run again with --spend to activate");
  process.exit(0);
}

for (const p of plans.filter((x) => !x.active)) {
  try {
    const r = await client.activateMachine({ ...p.params, expectedMachineId: p.machineId, maxNetPeaqAmount: (p.net * 12n) / 10n + 1n });
    console.log(`${p.role}: activated as peaq machine ${r.machineId}`);
  } catch (e) {
    fail([`activateMachine for ${p.role} failed: ${code(e)}`]);
  }
}
const robot = plans.find((p) => p.role === "robot")!.machineId;
const pad = plans.find((p) => p.role === "pad")!.machineId;
writeFleetState(dir, {
  ...readFleetState(dir),
  peaq: { network: PEAQ_MAINNET.deployment, eventRegistry: PEAQ_MAINNET.eventRegistry, identityRegistry: "2.0 MachineRegistry", robotMachineId: robot.toString(), padMachineId: pad.toString() },
});
console.log(`done: robot ${robot}, pad ${pad} on peaq mainnet; MCR: https://mcr.peaq.xyz/mcr/did:peaq:${robot}`);
