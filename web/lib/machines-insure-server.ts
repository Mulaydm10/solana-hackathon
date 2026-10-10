// Server-only wiring for Fiducia Insure (#283): the x402 resource server (devnet), the payee, and the agung reader.
// Missing config answers 503 NOT_CONFIGURED; nothing here runs in tests (they inject the gate and reader).
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createPayGate, SOLANA_DEVNET, USDC_DEVNET, type PayGate } from "../../agents/src/pay/index.ts"; // not the package root: its vm module fails web's type-check
import { readMachineEvents } from "@deal/agents/machines";
import { INSURE_PATH, INSURE_PRICE, handleInsure, type InsureReader } from "./machines-insure";
import { SCORE_FROM_BLOCK, jsonRpcLogIo } from "./machines-network";

type Raw = Record<string, string | undefined>;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEL_IDENTITY_REGISTRY = "0xa759ee6f"; // identityRegistryAddress()
const SEL_MACHINE_EXISTS = "0x85447be6"; // machineExists(uint256)

export function insureConfig(raw: Raw): { ok: true; payTo: string; rpc: string; registry: string; mint: string; facilitator: string } | { ok: false; vars: string[] } {
  const vars = ["FIDUCIA_INSURE_PAYEE", "PEAQ_RPC_URL", "PEAQ_EVENT_REGISTRY"].filter((k) => !raw[k]);
  if (raw.FIDUCIA_INSURE_PAYEE && !B58.test(raw.FIDUCIA_INSURE_PAYEE)) vars.push("FIDUCIA_INSURE_PAYEE (not a base58 address)");
  if (vars.length) return { ok: false, vars };
  return {
    ok: true, payTo: raw.FIDUCIA_INSURE_PAYEE!, rpc: raw.PEAQ_RPC_URL!, registry: raw.PEAQ_EVENT_REGISTRY!,
    mint: raw.DEAL_MINT ?? USDC_DEVNET, facilitator: raw.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  };
}

/** Reads the machine's events and whether the IdentityRegistry knows it (registered with its bond), over plain JSON-RPC. */
export function agungReader(rpc: string, registry: string, fetchFn: typeof fetch = fetch): InsureReader {
  const ethCall = async (to: string, data: string): Promise<string> => {
    const res = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
    const j = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!res.ok || j.error || typeof j.result !== "string") throw new Error("peaq rpc eth_call failed");
    return j.result;
  };
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  return {
    async read(machineId) {
      try {
        const ir = "0x" + (await ethCall(registry, SEL_IDENTITY_REGISTRY)).slice(-40);
        const exists = BigInt(await ethCall(ir, SEL_MACHINE_EXISTS + word(machineId))) === 1n;
        if (!exists) return { ok: true, exists: false, events: [] };
        const ev = await readMachineEvents(jsonRpcLogIo(rpc, fetchFn), registry, machineId, SCORE_FROM_BLOCK);
        return ev.ok ? { ok: true, exists: true, events: ev.events } : { ok: false, message: ev.message };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message.split("\n")[0]! : "peaq read failed" };
      }
    },
  };
}

let serverP: Promise<x402ResourceServer> | undefined;
const gates = new Map<string, PayGate>();

/** One initialised x402 resource server per process (a failed init is retried on the next call). */
function resourceServer(facilitator: string): Promise<x402ResourceServer> {
  serverP ??= (async () => {
    const s = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator })).register(SOLANA_DEVNET, new ExactSvmScheme());
    await s.initialize();
    return s;
  })().catch((e) => { serverP = undefined; throw e; });
  return serverP;
}

export async function insureGate(c: { payTo: string; mint: string; facilitator: string }, resourceUrl: string): Promise<PayGate> {
  const key = `${c.payTo}|${c.mint}|${resourceUrl}`;
  let g = gates.get(key);
  if (!g) {
    g = createPayGate(await resourceServer(c.facilitator), { scheme: "exact", network: SOLANA_DEVNET, payTo: c.payTo, amount: INSURE_PRICE, asset: c.mint },
      { url: resourceUrl, description: "Fiducia Insure: downtime-insurance quote for a peaq machine", mimeType: "application/json" });
    gates.set(key, g);
  }
  return g;
}

/** The route's POST body. 503 NOT_CONFIGURED when the payee or the peaq reader is not set. */
export async function insureRoute(req: Request, raw: Raw = process.env): Promise<Response> {
  const c = insureConfig(raw);
  if (!c.ok) return Response.json({ ok: false, reason: "NOT_CONFIGURED", message: "Fiducia Insure is not configured", vars: c.vars }, { status: 503 });
  try {
    return await handleInsure({ gate: await insureGate(c, new URL(req.url).origin + INSURE_PATH), reader: agungReader(c.rpc, c.registry), now: () => Math.floor(Date.now() / 1000) }, req);
  } catch (e) {
    console.error("[insure] failed:", e instanceof Error ? e.name : "error");
    return Response.json({ ok: false, reason: "INSURE_FAILED", message: "the service could not run; you were not charged" }, { status: 502 });
  }
}
