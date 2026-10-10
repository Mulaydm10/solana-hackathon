// Fiducia Insure (#283): 402 without payment, a paid call returns the quote, a failing reader or an unknown machine means
// no settle (no answer, no charge), the manifest shape, 503 without config. Facilitator, reader and clock are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createPayGate, SOLANA_DEVNET, USDC_DEVNET } from "../../agents/src/pay/index.ts";
import type { MachineEvent } from "@deal/agents/machines";
import { generateKeyPairSigner } from "@solana/kit";
import { INSURE_PATH, callInsure, INSURE_PRICE, handleInsure, insureManifest, usdc2, type InsureReader, type MachineRead } from "../lib/machines-insure.ts";
import { insureConfig, insureRoute } from "../lib/machines-insure-server.ts";
import { GET as manifestHttp } from "../app/api/machines/service/manifest/route.ts";

const PAYEE = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const NOW = 1_800_000_000;
const URL_ = `https://site.example${INSURE_PATH}`;

async function rig(read: (id: bigint) => Promise<MachineRead>) {
  const calls = { verify: 0, settle: 0, read: 0 };
  const client: FacilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} }; },
    async verify() { calls.verify++; return { isValid: true, payer: "Buyer" }; },
    async settle(_p: PaymentPayload, r: PaymentRequirements) { calls.settle++; return { success: true, transaction: "5igSettleTx", network: r.network, payer: "Buyer" }; },
  };
  const server = new x402ResourceServer(client).register(SOLANA_DEVNET, new ExactSvmScheme());
  await server.initialize();
  const gate = createPayGate(server, { scheme: "exact", network: SOLANA_DEVNET, payTo: PAYEE, amount: INSURE_PRICE, asset: USDC_DEVNET }, { url: URL_ });
  const [req] = await gate.requirements();
  const reader: InsureReader = { read: async (id) => { calls.read++; return read(id); } };
  const pay = encodePaymentSignatureHeader({ x402Version: 2, accepted: req!, payload: { transaction: "AQID" } } as PaymentPayload);
  const post = (body: unknown, paid: boolean) =>
    new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...(paid ? { "PAYMENT-SIGNATURE": pay } : {}) }, body: JSON.stringify(body) });
  const call = (body: unknown, paid = true) => handleInsure({ gate, reader, now: () => NOW }, post(body, paid));
  return { calls, call, req: req! };
}

const ev = (index: number, t: number, type: 0 | 1 = 0): MachineEvent =>
  ({ machineId: 349n, index: BigInt(index), eventType: type, value: 100n, timestamp: t, txHash: "0x" + index, block: 11_000_000n + BigInt(index) });
const healthy = async (): Promise<MachineRead> => ({ ok: true, exists: true, events: Array.from({ length: 12 }, (_, i) => ev(i, NOW - 86_400 * (30 - i))) });

test("no payment: 402 with the 0.01 USDC requirements, the reader never runs", async () => {
  const r = await rig(healthy);
  const res = await r.call({ machineId: "349" }, false);
  assert.equal(res.status, 402);
  assert.equal(r.req.amount, "10000");
  assert.equal(r.req.payTo, PAYEE);
  assert.deepEqual([r.calls.read, r.calls.verify, r.calls.settle], [0, 0, 0]);
});

test("paid call: returns the quote and settles exactly once", async () => {
  const r = await rig(healthy);
  const res = await r.call({ machineId: "349" });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("PAYMENT-RESPONSE"));
  const b = (await res.json()) as { machineId: string; score: number; grade: string; provisioned: boolean; factors: object; explain: string; quote: { coverage: string; termHours: number; premium: string; rateBps: number } };
  assert.equal(b.machineId, "349");
  assert.equal(typeof b.score, "number");
  assert.equal(typeof b.explain, "string");
  assert.ok(b.factors && typeof b.provisioned === "boolean");
  assert.equal(b.quote.coverage, "1.00");
  assert.equal(b.quote.termHours, 24);
  assert.match(b.quote.premium, /^\d+\.\d{2}$/);
  assert.ok(b.quote.rateBps >= 200 && b.quote.rateBps <= 2000);
  assert.deepEqual([r.calls.verify, r.calls.settle], [1, 1]);
});

test("reader failure: 502, nothing settled (no answer, no charge)", async () => {
  const r = await rig(async () => ({ ok: false, message: "peaq rpc down" }));
  const res = await r.call({ machineId: "349" });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { reason: string }).reason, "READ_FAILED");
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), null);
  assert.equal(r.calls.settle, 0);
});

test("a reader that throws: 502, nothing settled", async () => {
  const r = await rig(async () => { throw new Error("boom"); });
  const res = await r.call({ machineId: "349" });
  assert.equal(res.status, 502);
  assert.equal(r.calls.settle, 0);
});

test("unknown machine: 404 and no charge", async () => {
  const r = await rig(async () => ({ ok: true, exists: false, events: [] }));
  const res = await r.call({ machineId: "99999" });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { reason: string }).reason, "UNKNOWN_MACHINE");
  assert.equal(r.calls.settle, 0);
});

test("bad input: 400 and no charge, the reader never runs", async () => {
  const r = await rig(healthy);
  for (const body of [{}, { machineId: 349 }, { machineId: "-1" }, { machineId: "0x15d" }, null]) {
    const res = await r.call(body);
    assert.equal(res.status, 400);
  }
  assert.deepEqual([r.calls.read, r.calls.settle], [0, 0]);
});

test("a machine with no events still gets a quote (NR / provisioned rate)", async () => {
  const r = await rig(async () => ({ ok: true, exists: true, events: [] }));
  const res = await r.call({ machineId: "1" });
  assert.equal(res.status, 200);
  assert.equal(r.calls.settle, 1);
});

test("manifest shape and honesty note", async () => {
  const m = insureManifest("https://site.example", PAYEE);
  assert.equal(m.name, "Fiducia Insure");
  assert.equal(m.serviceType, "insurance.downtime-quote");
  assert.equal(m.price.amount, "0.01");
  assert.equal(m.rail, "x402 exact, Solana devnet, test USDC");
  assert.equal(m.endpoint.url, "https://site.example/api/machines/service/insure");
  assert.deepEqual(m.input.required, ["machineId"]);
  assert.equal(m.payment.payTo, PAYEE);
  assert.match(m.honesty, /not listed on robotic\.sh/);
  assert.doesNotMatch(JSON.stringify(m), /mainnet/i);
  const res = await manifestHttp(new Request("https://site.example/api/machines/service/manifest"));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { name: string }).name, "Fiducia Insure");
});

test("not configured: 503 NOT_CONFIGURED naming the variables, no network", async () => {
  const res = await insureRoute(new Request(URL_, { method: "POST", body: "{}" }), {});
  assert.equal(res.status, 503);
  const b = (await res.json()) as { reason: string; vars: string[] };
  assert.equal(b.reason, "NOT_CONFIGURED");
  assert.ok(b.vars.includes("FIDUCIA_INSURE_PAYEE"));
  assert.equal(insureConfig({ FIDUCIA_INSURE_PAYEE: "nope", PEAQ_RPC_URL: "x", PEAQ_EVENT_REGISTRY: "y" }).ok, false);
});

test("usdc2 formats whole cents", () => {
  assert.equal(usdc2(1_000_000n), "1.00");
  assert.equal(usdc2(60_000n), "0.06");
  assert.equal(usdc2(10_000n), "0.01");
});

test("callInsure: no payee given and none in the manifest -> a refusal value, nothing paid", async () => {
  const payer = await generateKeyPairSigner();
  const seen: string[] = [];
  const f = async (u: string) => { seen.push(u); return Response.json({ name: "Fiducia Insure" }); };
  const r = await callInsure(payer, URL_, 349n, { fetch: f });
  assert.deepEqual(r.ok ? null : r.reason, "NO_PAYEE");
  assert.deepEqual(seen, ["https://site.example/api/machines/service/manifest"]);
});

test("callInsure: a seller that does not ask for payment -> refusal value", async () => {
  const payer = await generateKeyPairSigner();
  const r = await callInsure(payer, URL_, 349n, { payTo: PAYEE, fetch: async () => Response.json({}, { status: 200 }) });
  assert.equal(r.ok, false);
});
