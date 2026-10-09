// One-time setup for the machine demo (#228): the keys, the owner's rules document, the robot's mandate, and the
// state the setup scripts keep. Pure and file-only, so it is unit-tested; the network calls are in
// agents/scripts/machines/. Nothing here prints or returns a private key except to the caller that writes a file.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getBase58Decoder, type Address } from "@solana/kit";
import { privateKeyToAddress } from "viem/accounts";
import type { MandateInput } from "@deal/chain";

const USDC = 1_000_000n;

/** The demo's limits (plan §2): defaults for the owner's one-time rules. */
export const FLEET_DEFAULTS = {
  budget: 3n * USDC,
  cap: 2n * USDC,
  perCharge: USDC / 2n,
  /** How long the fleet mission and the robot's mandate stay live (the program allows up to 30 days). */
  days: 21,
  /** SOL the mission holds to pay rent for the deals the robot opens. */
  rentLamports: 100_000_000n,
} as const;

export type FleetKeys = {
  /** Solana keypairs (64-byte arrays: seed then public key), devnet only. */
  owner: Uint8Array;
  robot: Uint8Array;
  pad: Uint8Array;
  /** peaq (EVM) keys, 0x + 64 hex, agung only: the operator registers both machines and writes their events. */
  peaqOperator: `0x${string}`;
  robotPeaq: `0x${string}`;
  padPeaq: `0x${string}`;
};

const SOLANA_KEYS = ["owner", "robot", "pad"] as const;
const PEAQ_KEYS = ["peaqOperator", "robotPeaq", "padPeaq"] as const;

const solanaKeypair = (): Uint8Array => {
  const seed = randomBytes(32);
  const out = new Uint8Array(64);
  out.set(seed, 0);
  out.set(ed25519.getPublicKey(seed), 32);
  return out;
};
const evmKey = (): `0x${string}` => `0x${randomBytes(32).toString("hex")}`;

/** The base58 address of a 64-byte Solana keypair (its last 32 bytes). */
export const solanaAddress = (kp: Uint8Array): Address => getBase58Decoder().decode(kp.slice(32)) as Address;

function checkSolana(name: string, kp: Uint8Array) {
  if (kp.length !== 64 || !ed25519.getPublicKey(kp.slice(0, 32)).every((b, i) => b === kp[32 + i])) throw new TypeError(`${name}: not a valid 64-byte Solana keypair`);
}

/**
 * Loads the six keys from `dir`, creating any that are missing when `create` is set. Files are 0600, never in a repo.
 * Returns which keys were created, so a script can say so without printing them.
 */
export function loadFleetKeys(dir: string, create: boolean): { keys: FleetKeys; created: string[] } {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const read = (name: string, make: () => string): string => {
    const p = join(dir, `${name}.key`);
    if (!existsSync(p)) {
      if (!create) throw new Error(`missing key ${name} in ${dir} (run without --dry-run once to create it)`);
      writeFileSync(p, make(), { mode: 0o600 });
      chmodSync(p, 0o600);
      created.push(name);
    }
    return readFileSync(p, "utf8").trim();
  };
  const k: Partial<FleetKeys> = {};
  for (const n of SOLANA_KEYS) {
    k[n] = Uint8Array.from(JSON.parse(read(n, () => JSON.stringify(Array.from(solanaKeypair())))) as number[]);
    checkSolana(n, k[n]!);
  }
  for (const n of PEAQ_KEYS) {
    const v = read(n, evmKey);
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new TypeError(`${n}: not a 0x + 64 hex key`);
    k[n] = v as `0x${string}`;
  }
  return { keys: k as FleetKeys, created };
}

/** Public addresses only: what the scripts print. */
export function fleetAddresses(k: FleetKeys) {
  return {
    owner: solanaAddress(k.owner), robot: solanaAddress(k.robot), pad: solanaAddress(k.pad),
    peaqOperator: privateKeyToAddress(k.peaqOperator), robotPeaq: privateKeyToAddress(k.robotPeaq), padPeaq: privateKeyToAddress(k.padPeaq),
  };
}

/** The payee list: `pads` (several pads, #269) or the single `pad`. */
function payeeList(o: { pad?: Address; pads?: Address[] }): Address[] {
  const list = o.pads ?? (o.pad ? [o.pad] : []);
  if (list.length === 0) throw new TypeError("a pad address (pad or pads) is required");
  return list;
}

/** The rules the owner approves once, as a document; its sha256 is the stage-0 plan hash. */
export function fleetRules(o: { robot: Address; pad?: Address; pads?: Address[]; cap: bigint; perCharge: bigint; expiresAt: number }) {
  const payees = payeeList(o);
  const doc = {
    kind: "fiducia-fleet-rules-v1",
    machine: "simulated delivery robot", payee: "simulated charging pad",
    robot: o.robot, ...(o.pads ? { pads: payees } : { pad: payees[0] }), // the single-pad document (and its hash) is unchanged
    perChargeMaxMicroUsdc: o.perCharge.toString(), totalCapMicroUsdc: o.cap.toString(), expiresAt: o.expiresAt,
    settlement: "escrow, released on the sha256 of the pad's signed meter reading",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return { doc, bytes, hash: sha256(bytes) };
}

/** The robot's mandate: per-charge limit, total cap, only the pad, stage 0, until the mission expires. */
export function robotMandate(o: { robot: Address; pad?: Address; pads?: Address[]; cap: bigint; perCharge: bigint; expiresAt: number }): MandateInput {
  return {
    agent: o.robot, roleHash: sha256(new TextEncoder().encode("fiducia-role:robot-charging")), cap: o.cap, perTxCap: o.perCharge,
    payees: payeeList(o), stageMask: 1, expiresAt: BigInt(o.expiresAt),
  };
}

/** What the scripts remember between runs (no keys). */
export type FleetState = {
  missionId?: string;
  mission?: string;
  expiresAt?: number;
  peaq?: { network: string; eventRegistry: string; identityRegistry: string; robotMachineId: string; padMachineId: string };
};

export const readFleetState = (dir: string): FleetState => {
  const p = join(dir, "state.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as FleetState) : {};
};
export const writeFleetState = (dir: string, s: FleetState) => writeFileSync(join(dir, "state.json"), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });

/**
 * The site's server env for /machines (contracts/web.md), written to a 0600 file for `vercel env add`; never printed.
 * Refuses until both the fleet mission and the peaq machines exist.
 */
export function machineEnv(k: FleetKeys, s: FleetState, o: { peaqRpcUrl?: string; explorerTxUrl?: string } = {}): Record<string, string> {
  if (!s.mission || !s.peaq) throw new Error("run fleet-setup and activate first: the mission or the peaq machines are missing");
  return {
    ROBOT_AGENT_KEY: JSON.stringify(Array.from(k.robot)),
    PAD_KEY: JSON.stringify(Array.from(k.pad)),
    MACHINE_MISSION: s.mission,
    PEAQ_EVENT_KEY: k.peaqOperator,
    PEAQ_RPC_URL: o.peaqRpcUrl ?? (s.peaq.network === PEAQ_MAINNET.deployment ? PEAQ_MAINNET.rpcUrl : PEAQ_AGUNG.rpcUrl),
    PEAQ_DEPLOYMENT: s.peaq.network,
    PEAQ_EVENT_REGISTRY: s.peaq.eventRegistry,
    PEAQ_SOURCE_CHAIN_ID: "0",
    ROBOT_MACHINE_ID: s.peaq.robotMachineId,
    PAD_MACHINE_ID: s.peaq.padMachineId,
    PEAQ_EXPLORER_TX_URL: o.explorerTxUrl ?? (s.peaq.network === PEAQ_MAINNET.deployment ? PEAQ_MAINNET.explorerTx : PEAQ_AGUNG.explorerTx),
  };
}

export function writeEnvFile(path: string, env: Record<string, string>) {
  writeFileSync(path, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------- peaq mainnet (Economics 2.0) activation, the fallback when agung is unavailable (#241) ----------

/** peaq mainnet 2.0 (read on chain 7 Oct): the EventRegistry the site writes to. */
export const PEAQ_MAINNET = { chainId: 3338, rpcUrl: "https://peaq.api.onfinality.io/public", eventRegistry: "0xA1e7F1d7B24dAb55Dc92491e6d9B89F6E925Ad1e", deployment: "peaq-mainnet", explorerTx: "https://peaq.subscan.io/tx/" } as const;
export const PEAQ_AGUNG = { chainId: 9990, rpcUrl: "https://peaq-agung.api.onfinality.io/public", eventRegistry: "0x2DAD8905380993940e340C5cE6d313d5c2780040", deployment: "agung", explorerTx: "https://agung-testnet.subscan.io/tx/" } as const;

/** Multibase (base58btc, "z") of an Ed25519 public key with its multicodec prefix (0xed 0x01), as DID documents use. */
export function ed25519Multibase(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new TypeError("ed25519 public key must be 32 bytes");
  return `z${getBase58Decoder().decode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
}

/**
 * The 2.0 activation parameters for one simulated machine. Its DID key is the machine's own Solana ed25519 key, and
 * the credential subject names its Solana wallet, so the peaq identity and the paying (or paid) wallet are bound.
 * Entry tier; the operator is controller and manufacturer of record (simulated machines have no real manufacturer).
 */
export function machineActivation(role: "robot" | "pad", solanaKeypair: Uint8Array, operator: `0x${string}`) {
  const wallet = solanaAddress(solanaKeypair);
  const subject = JSON.stringify({ kind: "fiducia-simulated-machine-v1", role, simulated: true, solanaCluster: "devnet", solanaWallet: wallet });
  return {
    controller: operator,
    verificationMethods: [{ id: "#solana-wallet", methodType: "Ed25519VerificationKey2020", controller: operator, publicKeyMultibase: ed25519Multibase(solanaKeypair.slice(32)) }],
    authentication: [0n],
    serviceEndpoints: [{ id: "#fiducia", serviceType: "fiducia-machine-demo", serviceEndpoint: "https://fiducia-orpin.vercel.app/machines" }],
    machineType: role === "robot" ? "fiducia-simulated-delivery-robot" : "fiducia-simulated-charging-pad",
    credentialSubject: `0x${Buffer.from(subject).toString("hex")}` as `0x${string}`,
    manufacturer: operator,
    tier: 0 as const,
  };
}
