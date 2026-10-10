// Server-only wiring for Machines v2 (#273): the pads', insurer's and shop's signers, the simulate-first chains, and the
// tick hooks. With any v2 variable missing this changes nothing: the tick stays exactly the v1 tick.
import { createKeyPairSignerFromBytes, type Address, type TransactionSigner } from "@solana/kit";
import { chainChargeChain, chainInsuranceChain, chainJobChain, charge, readMachineEvents, signHeartbeat, type JobDeps, type PeaqClient } from "@deal/agents/machines";
import type { ServerEnv } from "./env";
import { runRobotCharge, type MachineDeps, type RobotTickDeps } from "./machines";
import { machineBlobs, robotRules, type MachineRuntime } from "./machines-server";
import { INSURANCE, blobNetworkStore, jsonRpcLogIo, networkPrelude, parseNetworkEnv, routeCharge, type NetworkDeps, type NetworkStore, type NotConfigured } from "./machines-network";
import { anthropicLlm } from "./robot-llm";

const signerOf = (bytes: Uint8Array) => createKeyPairSignerFromBytes(bytes);

/** Builds the v2 dependencies, or says which parts are not configured. Checks that each key matches its address in MACHINE_NETWORK. */
export async function networkDeps(rt: MachineRuntime, env: ServerEnv, raw: Record<string, string | undefined> = process.env, nowMs: () => number = Date.now):
  Promise<{ ok: true; deps: NetworkDeps; padDeps: Record<string, MachineDeps> } | { ok: false; missing: NotConfigured }> {
  const parsed = parseNetworkEnv(raw);
  if (!parsed.ok) return parsed;
  const { cfg, keys } = parsed;
  const robot = await signerOf(Uint8Array.from(JSON.parse(env.ROBOT_AGENT_KEY!) as number[]));
  const padSigners: Record<string, TransactionSigner> = {};
  for (const p of cfg.pads) {
    padSigners[p.role] = await signerOf(keys.solana[p.role]!);
    if (padSigners[p.role]!.address !== p.address) return { ok: false, missing: [{ part: "network", vars: [`${p.role === "pad" ? "PAD_KEY" : `${p.role.toUpperCase()}_KEY`} (does not match MACHINE_NETWORK)`] }] };
  }
  const insurer = await signerOf(keys.insurer);
  const shop = await signerOf(keys.shop);
  if (insurer.address !== cfg.insurer || shop.address !== cfg.shop) return { ok: false, missing: [{ part: "network", vars: ["INSURER_KEY/SHOP_KEY (do not match MACHINE_NETWORK)"] }] };

  const now = () => nowMs() / 1000;
  const blobs = machineBlobs(env, raw);
  const store: NetworkStore = blobNetworkStore(blobs);
  const robotMachineId = rt.robotMachineId;
  const registry = env.PEAQ_EVENT_REGISTRY!;
  const io = jsonRpcLogIo(env.PEAQ_RPC_URL!);
  const job: JobDeps = {
    chain: chainJobChain(rt.ctx, { signer: shop, now }, robot), peaq: rt.peaq as PeaqClient, ledger: rt.deps.ledger,
    robotSecret: Uint8Array.from(JSON.parse(env.ROBOT_AGENT_KEY!) as number[]).slice(0, 32), robotMachineId,
  };
  // One charge path per pad: the same machinery as v1 (ledger, history, peaq), with that pad's signer and meter key.
  const padDeps: Record<string, MachineDeps> = {};
  for (const p of cfg.pads) {
    const bytes = keys.solana[p.role]!;
    const chain = chainChargeChain(rt.ctx, { mission: cfg.mission, robot, pad: padSigners[p.role]!, now });
    padDeps[p.role] = {
      ...rt.deps, padId: `pad:${p.machineId}`,
      charge: (req) => charge({ chain, peaq: rt.peaq, ledger: rt.deps.ledger, padSecret: bytes.slice(0, 32), padPublic: bytes.slice(32), robotMachineId, padMachineId: p.machineId }, req),
    };
  }
  const deps: NetworkDeps = {
    cfg, robotMachineId, store, battery: rt.battery,
    signBeat: (pad, sentAt) => signHeartbeat(pad.machineId.toString(), sentAt, keys.peaq[pad.role]!),
    insuranceDeps: (pad) => ({
      chain: chainInsuranceChain(rt.ctx, { insurer, pad: padSigners[pad.role]!, verifier: cfg.verifier, now, reviewSecs: INSURANCE.reviewSecs }),
      peaq: rt.peaq, padMachineId: pad.machineId, padAddress: pad.peaqAddress,
    }),
    job,
    headBlock: () => io.blockNumber(),
    readEvents: (machineId, fromBlock) => readMachineEvents(io, registry, machineId, fromBlock),
    ...(env.ANTHROPIC_API_KEY ? { llm: anthropicLlm(env.ANTHROPIC_API_KEY) } : {}),
    ...(/^\d+$/.test(raw.PEAQ_SCORE_FROM_BLOCK ?? "") ? { scoreFromBlock: BigInt(raw.PEAQ_SCORE_FROM_BLOCK!) } : {}),
    allowedPayees: async () => ((await robotRules(rt))?.payees ?? []).map((a) => a as Address),
  };
  return { ok: true, deps, padDeps };
}

/** The v1 tick deps, plus the v2 hooks when every v2 variable is set. Otherwise the same object back. */
export async function withNetwork(base: RobotTickDeps, rt: MachineRuntime, env: ServerEnv, raw: Record<string, string | undefined> = process.env): Promise<RobotTickDeps> {
  const n = await networkDeps(rt, env, raw);
  if (!n.ok) return base;
  return {
    ...base,
    prelude: (now) => networkPrelude(n.deps, now),
    route: (dec, mandate) => routeCharge(n.deps, dec, mandate),
    charge: (amount, kWh, _by, padRole) => runRobotCharge(padRole && n.padDeps[padRole] ? n.padDeps[padRole]! : rt.deps, amount, kWh, padRole),
  };
}
