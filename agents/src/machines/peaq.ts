// peaq side of the machine track (#227): each released charge becomes a revenue event for the pad and an activity
// event for the robot in peaq's EventRegistry, linked to the Solana release. peaq accepts only source chains 0, 3338
// (peaq) and 8453 (Base), not Solana, so with sourceChainId 0 the event is self-reported (trust level 0): it carries the
// full release signature in rawData, verifiable on the Solana Explorer, and never claims peaq verified the payment.
// Network, registry and source chain id are config (#226), never hard-coded here. Server-side only.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Address } from "@solana/kit";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

export type PeaqConfig = {
  rpcUrl: string;
  /** e.g. "agung-2026-08-28" or "peaq-mainnet". Only mainnet has a paired MCR service. */
  deployment: string;
  /** EventRegistry contract (0x…); which one accepts this deployment's machine ids is checked in #226. */
  eventRegistry: string;
  /** Source chain of `sourceTxHash` as peaq knows it: 0 (none/off-chain: self-reported), 3338 (peaq) or 8453 (Base). */
  sourceChainId: number;
  /** MCR API base; defaults to the public service. */
  mcrUrl?: string;
};

/** One released charge, as recorded on peaq. `amount` is USDC base units (devnet test money). */
export type Settlement = { chargeId: string; deal: Address; releaseSignature: string; deliveryHash: Uint8Array; amount: bigint };

export interface PeaqClient {
  submitRevenueEvent(machineId: bigint, s: Settlement): Promise<Ok<{ txHash: string }> | Refused>;
  submitActivityEvent(machineId: bigint, s: Settlement): Promise<Ok<{ txHash: string }> | Refused>;
  queryMcr(machineId: bigint): Promise<Ok<{ status: string; score?: number }> | Refused>;
}

/** The exact parameters handed to the SDK's `submitEvent` (shape from @peaqos/peaq-os-sdk 0.10). */
export type PeaqEventParams = {
  machineId: bigint;
  eventType: 0 | 1;
  value: number;
  currency: string;
  timestamp: number;
  rawData: Uint8Array;
  /** 0 self-reported (source chain 0, e.g. a Solana payment), 1 on-chain verifiable on a source chain peaq supports. */
  trustLevel: 0 | 1;
  sourceChainId: number;
  sourceTxHash: `0x${string}`;
  metadata: Uint8Array;
};

export const SOLANA_CLUSTER = "devnet";
/** The source chains peaq's EventRegistry accepts (SDK 0.10 / contract). */
export const PEAQ_SOURCE_CHAINS = [0, 3338, 8453] as const;

/** USDC base units (6 decimals) to USD cents; refuses sub-cent amounts instead of rounding money. */
export function usdCents(amount: bigint): Ok<{ cents: number }> | Refused {
  if (amount < 0n) return refuse("NEGATIVE_AMOUNT", "an amount cannot be negative");
  if (amount % 10_000n !== 0n) return refuse("SUBCENT_AMOUNT", "peaq revenue is in whole cents; this amount has a fraction of a cent");
  const cents = amount / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("AMOUNT_TOO_LARGE", "amount does not fit a safe integer");
  return { ok: true, cents: Number(cents) };
}

/** rawData: canonical JSON linking the event to the Solana release (fixed key order, bigint as string). */
export function settlementRawData(s: Settlement, program: string): Uint8Array {
  const ordered = {
    amount: s.amount.toString(), chargeId: s.chargeId, deal: s.deal, deliveryHash: bytesToHex(s.deliveryHash),
    program, releaseSignature: s.releaseSignature, solanaCluster: SOLANA_CLUSTER,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** bytes32 for `sourceTxHash`: a Solana signature is 64 bytes, so it is hashed; the full value is in rawData. */
export const sourceTxHash = (releaseSignature: string): `0x${string}` =>
  `0x${bytesToHex(sha256(new TextEncoder().encode(releaseSignature)))}`;

/** Builds the event for one released charge: revenue (pad, USD cents) or activity (robot, value 0, no currency). */
export function eventParams(
  kind: "revenue" | "activity", machineId: bigint, s: Settlement, cfg: Pick<PeaqConfig, "sourceChainId">, program: string, nowSecs: number,
): Ok<{ params: PeaqEventParams }> | Refused {
  if (machineId <= 0n) return refuse("BAD_MACHINE_ID", "machine id must be positive");
  if (!(PEAQ_SOURCE_CHAINS as readonly number[]).includes(cfg.sourceChainId)) {
    return refuse("BAD_CONFIG", `peaq accepts sourceChainId ${PEAQ_SOURCE_CHAINS.join(", ")} only (0 = self-reported)`);
  }
  if (!s.releaseSignature) return refuse("NOT_RELEASED", "an event is written only for a released charge");
  let value = 0;
  if (kind === "revenue") {
    const c = usdCents(s.amount);
    if (!c.ok) return c;
    value = c.cents;
  }
  return {
    ok: true,
    params: {
      machineId, eventType: kind === "revenue" ? 0 : 1, value, currency: kind === "revenue" ? "USD" : "",
      timestamp: Math.floor(nowSecs), rawData: settlementRawData(s, program), trustLevel: cfg.sourceChainId === 0 ? 0 : 1,
      sourceChainId: cfg.sourceChainId, sourceTxHash: sourceTxHash(s.releaseSignature), metadata: new Uint8Array(),
    },
  };
}

/** What the SDK client needs to provide; injected so tests never touch a network. */
export type PeaqSubmit = (params: PeaqEventParams) => Promise<{ txHash: string }>;
export type PeaqDeps = { submit: PeaqSubmit; fetch?: typeof fetch; now?: () => number; program: string };

const errText = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.name : "error";
};

/** A PeaqClient over an injected `submit` (the SDK in production, a stub in tests). Never throws, never logs keys. */
export function createPeaqClient(cfg: PeaqConfig, deps: PeaqDeps): PeaqClient {
  // Backdated a little: the registry refuses a timestamp ahead of its block time (FutureTimestamp).
  const now = deps.now ?? (() => Date.now() / 1000 - 15);
  const send = async (kind: "revenue" | "activity", machineId: bigint, s: Settlement): Promise<Ok<{ txHash: string }> | Refused> => {
    const p = eventParams(kind, machineId, s, cfg, deps.program, now());
    if (!p.ok) return p;
    try {
      const r = await deps.submit(p.params);
      return { ok: true, txHash: r.txHash };
    } catch (e) {
      // Only the error code or class name: SDK messages can echo request data.
      return refuse("PEAQ_SUBMIT_FAILED", `peaq rejected the ${kind} event (${errText(e)})`);
    }
  };
  return {
    submitRevenueEvent: (id, s) => send("revenue", id, s),
    submitActivityEvent: (id, s) => send("activity", id, s),
    async queryMcr(machineId) {
      if (!cfg.deployment.startsWith("peaq-mainnet")) {
        return refuse("MCR_NOT_SERVED", "peaq does not serve a Machine Credit Rating for testnet machines");
      }
      const f = deps.fetch ?? fetch;
      try {
        const res = await f(`${cfg.mcrUrl ?? "https://mcr.peaq.xyz"}/mcr/did:peaq:${machineId.toString()}`);
        if (!res.ok) return refuse("MCR_UNAVAILABLE", `the MCR service answered HTTP ${res.status}`);
        const body = (await res.json()) as Record<string, unknown>;
        const status = typeof body.status === "string" ? body.status : typeof body.mcr_status === "string" ? body.mcr_status : null;
        if (!status) return refuse("MCR_UNREADABLE", "the MCR answer has no status");
        const raw = body.score ?? body.mcr;
        return typeof raw === "number" ? { ok: true, status, score: raw } : { ok: true, status };
      } catch (e) {
        return refuse("MCR_UNAVAILABLE", `the MCR service could not be reached (${errText(e)})`);
      }
    },
  };
}

// ---------- EventRegistry versions ----------
// agung's registry (0x2DAD…) is v1: submitEvent without a currency argument. peaq mainnet's (0xA1e7…) is v2, the call
// the SDK sends. The version is read from the proxy's implementation code (checked on chain 7 Oct, #241).
const SUBMIT_V1 = "function submitEvent(uint256 machineId, uint8 eventType, uint256 value, uint256 timestamp, bytes32 dataHash, uint8 trustLevel, uint256 sourceChainId, bytes32 sourceTxHash, bytes metadata)";
const SELECTOR_V1 = "6b58c7dc";
const SELECTOR_V2 = "e58a43ca";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // ERC-1967

/** The minimal chain reads and writes the event path needs; injected in tests. */
export type RegistryIo = {
  getCode(address: Hex): Promise<Hex | undefined>;
  getStorageAt(address: Hex, slot: Hex): Promise<Hex | undefined>;
  writeV1(registry: Hex, args: readonly unknown[]): Promise<Hex>;
  waitOk(hash: Hex): Promise<boolean>;
};

/** 1 or 2 from the implementation's function selectors; 0 when neither submitEvent is there. */
export async function registryVersion(io: Pick<RegistryIo, "getCode" | "getStorageAt">, registry: Hex): Promise<0 | 1 | 2> {
  const slot = await io.getStorageAt(registry, IMPL_SLOT);
  const impl = slot && BigInt(slot) !== 0n ? (`0x${slot.slice(-40)}` as Hex) : registry;
  const code = ((await io.getCode(impl)) ?? "").toLowerCase();
  return code.includes(SELECTOR_V2) ? 2 : code.includes(SELECTOR_V1) ? 1 : 0;
}

/** The v1 call's arguments: v2's minus currency; dataHash = keccak256(rawData) as the SDK computes it. */
export const v1Args = (p: PeaqEventParams) =>
  [p.machineId, p.eventType, BigInt(p.value), BigInt(p.timestamp), keccak256(p.rawData), p.trustLevel, BigInt(p.sourceChainId), p.sourceTxHash, `0x${bytesToHex(p.metadata)}`] as const;

function viemIo(cfg: PeaqConfig, privateKey: string): RegistryIo {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  let wallet: Promise<ReturnType<typeof createWalletClient>> | undefined;
  const walletFor = () => (wallet ??= pub.getChainId().then((id) => createWalletClient({
    account: privateKeyToAccount(privateKey as Hex),
    chain: defineChain({ id, name: `peaq-${id}`, nativeCurrency: { name: "PEAQ", symbol: "PEAQ", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }),
    transport: http(cfg.rpcUrl),
  })));
  return {
    getCode: (a) => pub.getCode({ address: a }),
    getStorageAt: (a, slot) => pub.getStorageAt({ address: a, slot }),
    writeV1: async (registry, args) => {
      const w = await walletFor();
      return w.writeContract({ address: getAddress(registry), abi: parseAbi([SUBMIT_V1]), functionName: "submitEvent", args: args as never, chain: w.chain, account: w.account! });
    },
    waitOk: async (hash) => (await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })).status === "success",
  };
}

/** A submit for a v1 registry, over injected chain I/O (tests) or viem (production). */
export function v1Submit(cfg: PeaqConfig, io: RegistryIo): PeaqSubmit {
  return async (params) => {
    const hash = await io.writeV1(cfg.eventRegistry as Hex, v1Args(params));
    if (!(await io.waitOk(hash))) throw Object.assign(new Error("event transaction reverted"), { code: "REVERTED" });
    return { txHash: hash };
  };
}

/**
 * Production `submit`: picks the registry's version once. v2 (peaq mainnet) goes through the peaq SDK, v1 (agung)
 * through viem with the v1 call. Neither prints or returns the key.
 */
export function sdkSubmit(cfg: PeaqConfig, privateKey: string, io?: RegistryIo): PeaqSubmit {
  let chosen: Promise<PeaqSubmit> | undefined;
  return async (params) => {
    chosen ??= (async () => {
      const x = io ?? viemIo(cfg, privateKey);
      const v = await registryVersion(x, cfg.eventRegistry as Hex);
      if (v === 0) throw Object.assign(new Error("no submitEvent at the configured EventRegistry"), { code: "NOT_AN_EVENT_REGISTRY" });
      return v === 1 ? v1Submit(cfg, x) : sdkV2Submit(cfg, privateKey);
    })();
    chosen.catch(() => { chosen = undefined; });
    return (await chosen)(params);
  };
}

/** The peaq SDK's (v2) event path, loaded on first use; telemetry off unless the operator set it. */
function sdkV2Submit(cfg: PeaqConfig, privateKey: string): PeaqSubmit {
  let client: Promise<{ submitEvent(p: PeaqEventParams): Promise<{ txHash: string }> }> | undefined;
  return async (params) => {
    client ??= (async () => {
      process.env.PEAQOS_TELEMETRY ??= "0";
      const { PeaqosClient } = await import("@peaqos/peaq-os-sdk");
      // Only eventRegistry is used for events; the identity contracts are not called on this path.
      const unused = "0x0000000000000000000000000000000000000001" as const;
      return new PeaqosClient({
        rpcUrl: cfg.rpcUrl, privateKey: privateKey as `0x${string}`,
        contracts: {
          eventRegistry: cfg.eventRegistry as `0x${string}`,
          identityRegistry: unused, identityStaking: unused, machineNft: unused, didRegistry: unused, batchPrecompile: unused,
        },
      }) as unknown as { submitEvent(p: PeaqEventParams): Promise<{ txHash: string }> };
    })();
    client.catch(() => { client = undefined; }); // a failed setup is retried on the next call, not cached
    return (await client).submitEvent(params);
  };
}
