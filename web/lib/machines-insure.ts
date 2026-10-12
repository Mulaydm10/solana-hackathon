// Fiducia Insure (#283): a machine service sold per call, built in the shape of a robotic.sh adapter and paid over x402 on
// Solana devnet. Pure and injectable: the seller gate, the peaq reader and the clock come in, so tests touch no network.
// Not listed on robotic.sh (it has no public adapter submission); this only borrows the adapter shape.
import { quotePremium, scoreMachine, type MachineEvent, type MachineScore } from "@deal/agents/machines";
import { payAndCall, SOLANA_DEVNET, USDC_DEVNET, type Answer, type Fetch, type PayGate } from "../../agents/src/pay/index.ts"; // not the package root: its vm module fails web's type-check
import type { TransactionSigner } from "@solana/kit";

/** 0.01 USDC per call, token base units. */
export const INSURE_PRICE = 10_000n;
/** What every quote prices: 1.00 USDC of cover for 24 h. */
export const INSURE_COVERAGE = 1_000_000n;
export const INSURE_TERM_SECS = 86_400;
export const INSURE_PATH = "/api/machines/service/insure";
export const MANIFEST_PATH = "/api/machines/service/manifest";

/** What the peaq reader says about one machine. `exists` = registered and bonded on agung. */
export type MachineRead = { ok: true; exists: boolean; events: MachineEvent[] } | { ok: false; message: string };
export interface InsureReader { read(machineId: bigint): Promise<MachineRead> }

export type InsureQuote = {
  machineId: string; score: number; grade: MachineScore["grade"]; provisioned: boolean; factors: MachineScore["factors"]; explain: string;
  quote: { coverage: string; termHours: number; premium: string; rateBps: number };
};

/** Base units -> "1.00" (whole cents, as quotePremium rounds to). */
export const usdc2 = (micro: bigint): string => `${micro / 1_000_000n}.${((micro % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;

type Outcome = { status: number; body: unknown };
const err = (status: number, reason: string, message: string): Outcome => ({ status, body: { ok: false, reason, message } });

/** The seller's code behind the gate: parse, read, score, quote. Refusals are results with a non-2xx status. */
export async function insureAnswer(reader: InsureReader, body: unknown, nowSecs: number): Promise<Outcome> {
  const raw = body && typeof body === "object" ? (body as { machineId?: unknown }).machineId : undefined;
  if (typeof raw !== "string" || !/^[0-9]{1,18}$/.test(raw)) return err(400, "BAD_REQUEST", 'send {"machineId":"<decimal string>"}');
  const id = BigInt(raw);
  const r = await reader.read(id);
  if (!r.ok) return err(502, "READ_FAILED", r.message);
  if (!r.exists) return err(404, "UNKNOWN_MACHINE", `machine ${raw} is not registered and bonded on agung`);
  const s = scoreMachine(r.events, { bonded: true, nowSecs });
  const q = quotePremium(INSURE_COVERAGE, s.grade, INSURE_TERM_SECS);
  if (!q.ok) return err(502, q.reason, q.message);
  const quote: InsureQuote = {
    machineId: raw, score: s.score, grade: s.grade, provisioned: s.provisioned, factors: s.factors, explain: s.explain,
    quote: { coverage: usdc2(INSURE_COVERAGE), termHours: INSURE_TERM_SECS / 3600, premium: usdc2(q.premium), rateBps: q.rateBps },
  };
  return { status: 200, body: quote };
}

const isQuote = (b: unknown) => typeof (b as InsureQuote | undefined)?.score === "number" && typeof (b as InsureQuote).quote?.premium === "string";
const noStore = { "cache-control": "no-store" };

/**
 * POST handler. Order is the gate's: no payment -> 402; the answer is computed only after the payment verifies; settlement
 * happens only for a valid quote. A refusal (bad input, unknown machine, reader down) is returned as itself, never charged.
 */
export async function handleInsure(d: { gate: PayGate; reader: InsureReader; now: () => number }, req: Request): Promise<Response> {
  let refused: Outcome | undefined;
  const g = await d.gate.handle((n) => req.headers.get(n) ?? undefined, async (): Promise<Answer> => {
    const body = await req.json().catch(() => undefined);
    const o = await insureAnswer(d.reader, body, d.now());
    if (o.status < 200 || o.status > 299) refused = o;
    return o;
  }, isQuote);
  if (refused) return Response.json(refused.body, { status: refused.status, headers: noStore }); // nothing settled
  return Response.json(g.body, { status: g.status, headers: { ...noStore, ...g.headers } });
}

export const INSURE_HONESTY =
  "Built in the shape of a robotic.sh adapter; it is not listed on robotic.sh. Paid over x402 on Solana devnet with test USDC. " +
  "The score reads real agung (peaq testnet) events; the quote is a price, not a binding policy.";

/** The machine-readable adapter description. `origin` is the site's origin, e.g. https://fiducia-orpin.vercel.app. */
/** `asset`: the mint the 402 asks for (the site's DEAL_MINT), so a machine reading the manifest pays the right token. */
export function insureManifest(origin: string, payTo?: string, asset: string = USDC_DEVNET) {
  return {
    name: "Fiducia Insure",
    serviceType: "insurance.downtime-quote",
    description: "A downtime-insurance quote for any bonded peaq machine: score and grade from its agung events, premium for 1.00 USDC of cover over 24 h.",
    price: { amount: usdc2(INSURE_PRICE), baseUnits: INSURE_PRICE.toString(), currency: "USDC", perCall: true },
    rail: "x402 exact, Solana devnet, test USDC",
    payment: { scheme: "exact", network: SOLANA_DEVNET, asset, amount: INSURE_PRICE.toString(), ...(payTo ? { payTo } : {}), noAnswerNoCharge: true },
    endpoint: { method: "POST", url: `${origin}${INSURE_PATH}`, manifest: `${origin}${MANIFEST_PATH}` },
    input: {
      type: "object", required: ["machineId"], additionalProperties: false,
      properties: { machineId: { type: "string", pattern: "^[0-9]{1,18}$", description: "peaq machine id, decimal string" } },
    },
    output: {
      type: "object", required: ["machineId", "score", "grade", "provisioned", "factors", "explain", "quote"],
      properties: {
        machineId: { type: "string" }, score: { type: "number", minimum: 0, maximum: 100 }, grade: { type: "string" }, provisioned: { type: "boolean" },
        factors: { type: "object", description: "bond, revenue, activity, tenure, freshness, penalty" }, explain: { type: "string" },
        quote: {
          type: "object", required: ["coverage", "termHours", "premium", "rateBps"],
          properties: { coverage: { const: "1.00" }, termHours: { const: 24 }, premium: { type: "string", description: "USDC, whole cents" }, rateBps: { type: "integer" } },
        },
      },
    },
    errors: { "400": "BAD_REQUEST", "402": "payment required", "404": "UNKNOWN_MACHINE (not charged)", "502": "READ_FAILED (not charged)", "503": "NOT_CONFIGURED" },
    honesty: INSURE_HONESTY,
  };
}

export type InsureCall =
  | { ok: true; quote: InsureQuote; charged: boolean; transaction?: string }
  | { ok: false; reason: string; message: string; status?: number };

/**
 * What a machine (pad2) uses: pay 0.01 USDC and get the quote. `payer` is the machine's own signer. The payee must be the
 * one the caller passes (`opts.payTo`); if omitted it is read from the service's manifest next to `url`. The cap is fixed at
 * the 0.01 USDC price, whatever the seller asks. Never throws.
 */
export async function callInsure(
  payer: TransactionSigner, url: string, machineId: bigint,
  opts: { payTo?: string; asset?: string; rpcUrl?: string; fetch?: Fetch } = {},
): Promise<InsureCall> {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  try {
    let payTo = opts.payTo;
    let asset = opts.asset;
    if (!payTo || !asset) {
      const m = await f(new URL(MANIFEST_PATH, url).toString());
      const pay = ((await m.json().catch(() => undefined)) as { payment?: { payTo?: string; asset?: string } } | undefined)?.payment;
      payTo ??= pay?.payTo;
      asset ??= pay?.asset;
      if (!payTo) return { ok: false, reason: "NO_PAYEE", message: "no payee given and the manifest names none" };
    }
    const r = await payAndCall(
      url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machineId: machineId.toString() }) },
      payer, { network: SOLANA_DEVNET, asset: asset ?? USDC_DEVNET, payTo, maxAmount: INSURE_PRICE }, { rpcUrl: opts.rpcUrl, fetch: f },
    );
    if (!r.ok) return { ok: false, reason: r.reason, message: r.message, status: r.status };
    if (!isQuote(r.body)) return { ok: false, reason: "BAD_ANSWER", message: "the service answered without a quote" };
    return { ok: true, quote: r.body as InsureQuote, charged: r.charged, transaction: r.transaction };
  } catch (e) {
    return { ok: false, reason: "NETWORK", message: e instanceof Error ? e.message : String(e) };
  }
}
