// peaq side of the machine track (#227): each released charge becomes a revenue event for the pad and an activity
// event for the robot in peaq's EventRegistry, trust level 1 (on-chain verifiable), linked to the Solana release.
// Network, registry and source chain id are config (#226), never hard-coded here. Server-side only.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Address } from "@solana/kit";

type Ok<T> = { ok: true } & T;
type Refused = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

export type PeaqConfig = {
  rpcUrl: string;
  /** e.g. "agung-2026-08-28" or "peaq-mainnet". Only mainnet has a paired MCR service. */
  deployment: string;
  /** EventRegistry contract (0x…); which one accepts this deployment's machine ids is checked in #226. */
  eventRegistry: string;
  /** peaq's id for the source chain of `sourceTxHash` (the SDK's SOLANA_PROTOCOL_CHAIN_ID is 5). */
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
  trustLevel: 1;
  sourceChainId: number;
  sourceTxHash: `0x${string}`;
  metadata: Uint8Array;
};

export const SOLANA_CLUSTER = "devnet";

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
  if (!Number.isSafeInteger(cfg.sourceChainId) || cfg.sourceChainId < 0) return refuse("BAD_CONFIG", "sourceChainId must be a non-negative integer");
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
      timestamp: Math.floor(nowSecs), rawData: settlementRawData(s, program), trustLevel: 1,
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
  const now = deps.now ?? (() => Date.now() / 1000);
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
        return refuse("MCR_NOT_SERVED", "peaq serves the Machine Credit Rating for mainnet machines only; this is a testnet machine");
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

/**
 * Production `submit`: the peaq SDK's EVM event path. Loaded on first use so nothing else pays for it; the SDK's
 * telemetry is switched off unless the operator set it explicitly. `privateKey` is the peaq event signer (0x hex).
 */
export function sdkSubmit(cfg: PeaqConfig, privateKey: string): PeaqSubmit {
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
