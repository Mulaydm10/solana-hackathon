// Server-only wiring for /machines (#229): the robot and pad keys, the simulate-first devnet client, the peaq client
// and storage. Keys are parsed here from the server env and never leave this module except as signers.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { get as blobGet, put as blobPut } from "@vercel/blob";
import {
  appendTransactionMessageInstructions, compileTransaction, createClient, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { DEAL_ESCROW_PROGRAM_ADDRESS, getMandate, type DealClient, type DealContext } from "@deal/chain";
import { DEFAULT_ROBOT, chainChargeChain, charge, createPeaqClient, decideWithModel, sdkSubmit, type PeaqClient } from "@deal/agents/machines";
import type { ServerEnv } from "./env";
import { createLimiter } from "./demo";
import { anthropicLlm } from "./robot-llm";
import { blobBattery, blobDecisions, blobHistory, blobLedger, runRobotCharge, simulateFirst, type BatteryStore, type ChargeHistory, type DecisionLog, type MachineDeps, type RobotTickDeps } from "./machines";
import { USDC_DEVNET } from "./registry";
import { fileBlobs, vercelBlobs, type BlobApi, type Blobs } from "./storage";

const limiter = createLimiter();
const blobApi: BlobApi = {
  put: (pathname, body, o) => blobPut(pathname, Buffer.from(body), o),
  get: (pathname, o) => blobGet(pathname, o),
};

export type MachineRuntime = {
  deps: MachineDeps;
  ctx: DealContext;
  peaq: PeaqClient;
  history: ChargeHistory;
  battery: BatteryStore;
  decisions: DecisionLog;
  mission: Address;
  robot: Address;
  pad: Address;
  robotMachineId: bigint;
  padMachineId: bigint;
  deployment: string;
  explorerTx?: string;
};

export function machineBlobs(env: ServerEnv, raw: Record<string, string | undefined>): Blobs {
  return env.BLOB_READ_WRITE_TOKEN ? vercelBlobs(blobApi, env.BLOB_READ_WRITE_TOKEN, "machines") : fileBlobs(raw.DEAL_MACHINES_DIR ?? join(process.cwd(), ".data", "machines"));
}

let cached: { key: string; rt: Promise<MachineRuntime> } | undefined;

/** Needs the "machines" capability first (requireEnv): every machine variable is present and the cluster is devnet. */
export function machineRuntime(env: ServerEnv, raw: Record<string, string | undefined> = process.env): Promise<MachineRuntime> {
  const key = `${env.ROBOT_AGENT_KEY}|${env.PAD_KEY}|${env.MACHINE_MISSION}|${env.PEAQ_DEPLOYMENT}`;
  if (cached?.key === key) return cached.rt;
  const rt = (async (): Promise<MachineRuntime> => {
    const bytes = (s: string) => Uint8Array.from(JSON.parse(s) as number[]);
    const robotBytes = bytes(env.ROBOT_AGENT_KEY!);
    const padBytes = bytes(env.PAD_KEY!);
    const robot = await createKeyPairSignerFromBytes(robotBytes);
    const pad = await createKeyPairSignerFromBytes(padBytes);
    const rpc = createSolanaRpc(env.rpcUrl);
    // The robot pays every fee; the pad signs its own instructions (accept, deliver).
    const inner = createClient().use(signerPlugin(robot)).use(solanaRpc({ rpcUrl: env.rpcUrl })) as unknown as DealClient;
    const client = simulateFirst(inner, async (ixs) => {
      const { value: bh } = await rpc.getLatestBlockhash().send();
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(robot.address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      );
      const wire = getBase64EncodedWireTransaction(compileTransaction(msg));
      const r = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
      return r.value.err ?? null;
    });
    const ctx: DealContext = { client, mint: (env.DEAL_MINT ?? USDC_DEVNET) as Address };
    const mission = env.MACHINE_MISSION! as Address;
    const peaqCfg = { rpcUrl: env.PEAQ_RPC_URL!, deployment: env.PEAQ_DEPLOYMENT!, eventRegistry: env.PEAQ_EVENT_REGISTRY!, sourceChainId: env.PEAQ_SOURCE_CHAIN_ID! };
    const peaq = createPeaqClient(peaqCfg, { submit: sdkSubmit(peaqCfg, env.PEAQ_EVENT_KEY!), program: DEAL_ESCROW_PROGRAM_ADDRESS });
    const blobs = machineBlobs(env, raw);
    const ledger = blobLedger(blobs);
    const history = blobHistory(blobs);
    const battery = blobBattery(blobs);
    const decisions = blobDecisions(blobs);
    const robotMachineId = BigInt(env.ROBOT_MACHINE_ID!);
    const padMachineId = BigInt(env.PAD_MACHINE_ID!);
    const chain = chainChargeChain(ctx, { mission, robot, pad, now: () => Date.now() / 1000 });
    // The pad's meter key is its ed25519 seed (the first half of the 64-byte Solana keypair).
    const padSecret = padBytes.slice(0, 32);
    const padPublic = padBytes.slice(32);
    const deps: MachineDeps = {
      limit: limiter, nowSecs: () => Math.floor(Date.now() / 1000), newChargeId: () => `c${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
      padId: `pad:${padMachineId}`, robotId: `robot:${robotMachineId}`, ledger, history,
      charge: (req) => charge({ chain, peaq, ledger, padSecret, padPublic, robotMachineId, padMachineId }, req),
    };
    return { deps, ctx, peaq, history, battery, decisions, mission, robot: robot.address, pad: pad.address, robotMachineId, padMachineId, deployment: env.PEAQ_DEPLOYMENT!, explorerTx: env.PEAQ_EXPLORER_TX_URL };
  })();
  cached = { key, rt };
  rt.catch(() => { if (cached?.rt === rt) cached = undefined; });
  return rt;
}

/** The robot's rules, read from chain (never hard-coded). */
export async function robotRules(rt: MachineRuntime) {
  const m = await getMandate(rt.ctx, rt.mission, rt.robot);
  if (!m) return null;
  return { cap: m.cap, perTxCap: m.perTxCap, spent: m.spent, payees: m.payees, expiresAt: m.expiresAt, revoked: m.revoked };
}

/** What a tick needs: the stores, the mandate left (read from chain, bigint), and the internal robot charge. */
export function tickDeps(rt: MachineRuntime, env?: ServerEnv, nowSecs = Math.floor(Date.now() / 1000)): RobotTickDeps {
  const slot = Math.floor(nowSecs / 1800); // SLOT_SECS = 1800
  const deps: RobotTickDeps = {
    battery: rt.battery,
    decisions: rt.decisions,
    mandate: async () => {
      const r = await robotRules(rt);
      if (!r) return { perTxCap: 0n, cap: 0n, spent: 0n, live: false };
      return { perTxCap: BigInt(r.perTxCap), cap: BigInt(r.cap), spent: BigInt(r.spent), live: !r.revoked && r.expiresAt > nowSecs };
    },
    charge: (amount, kWh) => runRobotCharge(rt.deps, amount, kWh),
  };

  // Wire the model decider when ANTHROPIC_API_KEY is set
  if (env?.ANTHROPIC_API_KEY) {
    const llm = anthropicLlm(env.ANTHROPIC_API_KEY);
    deps.decider = async (b, mandate) => {
      // Simulated deterministic telemetry from the slot number
      const distanceToPadKm = 1 + ((slot % 7) * 0.5);
      const nextDeliveryKm = 2 + (slot % 5);
      const telemetry = {
        battery: b,
        distanceToPadKm,
        nextDeliveryKm,
        pricePerKwhMicro: DEFAULT_ROBOT.pricePerKwhMicro,
      };
      return decideWithModel(llm, telemetry, mandate, DEFAULT_ROBOT);
    };
  }

  return deps;
}
