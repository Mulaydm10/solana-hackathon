// Offline tests for the x402 pay gate and the buyer's checks. The facilitator is a local stub that records
// every verify and settle call, so "no answer, no charge" is checked as "settle was never called".
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { acceptable, createPayGate, payAndCall, SOLANA_DEVNET, USDC_DEVNET, type Accepts, type Answer } from "../src/index.ts";

const SELLER = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const accepts: Accepts = { scheme: "exact", network: SOLANA_DEVNET, payTo: SELLER, amount: 10_000n, asset: USDC_DEVNET };

function stubFacilitator(opts: { valid?: boolean; settles?: boolean } = {}) {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} };
    },
    async verify() {
      calls.verify++;
      return opts.valid === false ? { isValid: false, invalidReason: "insufficient_funds" } : { isValid: true, payer: "Buyer" };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements) {
      calls.settle++;
      return opts.settles === false
        ? { success: false, errorReason: "transaction_failed", transaction: "", network: r.network }
        : { success: true, transaction: "5igSettleTx", network: r.network, payer: "Buyer" };
    },
  };
  return { client, calls };
}

async function setup(opts: { valid?: boolean; settles?: boolean } = {}) {
  const f = stubFacilitator(opts);
  const server = new x402ResourceServer(f.client).register(SOLANA_DEVNET, new ExactSvmScheme());
  await server.initialize();
  const gate = createPayGate(server, accepts, { url: "https://seller.example/v1/quote", mimeType: "application/json" });
  const [req] = await gate.requirements();
  const pay = (r: PaymentRequirements = req!) =>
    encodePaymentSignatureHeader({ x402Version: 2, accepted: r, payload: { transaction: "AQID" } } as PaymentPayload);
  return { ...f, gate, req: req!, pay };
}

const hdr = (h: Record<string, string>) => (n: string) => h[n];
const ok = async (): Promise<Answer> => ({ status: 200, body: { price: 101.5 } });
const hasPrice = (b: unknown) => typeof (b as { price?: unknown })?.price === "number";
let ran = 0;
const counting = (a: () => Promise<Answer>) => async () => { ran++; return a(); };

test("requirements carry the exact amount, mint, payee and the facilitator's fee payer", async () => {
  const { req } = await setup();
  assert.equal(req.amount, "10000");
  assert.equal(req.asset, USDC_DEVNET);
  assert.equal(req.payTo, SELLER);
  assert.equal(req.network, SOLANA_DEVNET);
  assert.equal(req.extra.feePayer, FEE_PAYER);
});

test("no payment header: 402 with decodable requirements, nothing runs", async () => {
  const { gate, calls } = await setup();
  ran = 0;
  const r = await gate.handle(hdr({}), counting(ok), hasPrice);
  assert.equal(r.status, 402);
  assert.equal(r.reason, "PAYMENT_REQUIRED");
  assert.equal(decodePaymentRequiredHeader(r.headers["PAYMENT-REQUIRED"]!).accepts[0]!.amount, "10000");
  assert.deepEqual([ran, calls.verify, calls.settle], [0, 0, 0]);
});

test("garbage or mismatched payments are refused before verify", async () => {
  const { gate, calls, req, pay } = await setup();
  assert.equal((await gate.handle(hdr({ "PAYMENT-SIGNATURE": "%%%" }), ok, hasPrice)).reason, "BAD_PAYMENT_HEADER");
  assert.equal((await gate.handle(hdr({ "PAYMENT-SIGNATURE": pay({ ...req, amount: "1" }) }), ok, hasPrice)).reason, "NO_MATCHING_REQUIREMENTS");
  assert.equal((await gate.handle(hdr({ "PAYMENT-SIGNATURE": pay({ ...req, payTo: FEE_PAYER }) }), ok, hasPrice)).reason, "NO_MATCHING_REQUIREMENTS");
  assert.deepEqual(calls, { verify: 0, settle: 0 });
});

test("verify fails: the seller's code never runs and nothing settles", async () => {
  const { gate, calls, pay } = await setup({ valid: false });
  ran = 0;
  const r = await gate.handle(hdr({ "PAYMENT-SIGNATURE": pay() }), counting(ok), hasPrice);
  assert.equal(r.status, 402);
  assert.equal(r.reason, "VERIFY_FAILED");
  assert.deepEqual([ran, calls.verify, calls.settle], [0, 1, 0]);
});

test("no answer, no charge: a throwing handler, a non-2xx answer, or an answer that fails the schema never settles", async () => {
  for (const [name, run, reason] of [
    ["throws", async (): Promise<Answer> => { throw new Error("db down"); }, "HANDLER_FAILED"],
    ["500", async (): Promise<Answer> => ({ status: 500, body: { price: 1 } }), "INVALID_ANSWER"],
    ["empty", async (): Promise<Answer> => ({ status: 200, body: {} }), "INVALID_ANSWER"],
    ["204", async (): Promise<Answer> => ({ status: 204, body: undefined }), "INVALID_ANSWER"],
  ] as const) {
    const { gate, calls, pay } = await setup();
    const r = await gate.handle(hdr({ "PAYMENT-SIGNATURE": pay() }), run, hasPrice);
    assert.equal(r.reason, reason, name);
    assert.equal(r.charged, false, name);
    assert.equal(r.status, 502, name);
    assert.deepEqual(calls, { verify: 1, settle: 0 }, name);
    assert.doesNotMatch(JSON.stringify(r.body), /price/, `${name}: no seller output leaks`);
  }
});

test("a valid answer settles exactly once and returns the receipt", async () => {
  const { gate, calls, pay } = await setup();
  const r = await gate.handle(hdr({ "payment-signature": pay() }), ok, hasPrice);
  assert.equal(r.status, 200);
  assert.equal(r.charged, true);
  assert.equal(r.transaction, "5igSettleTx");
  assert.deepEqual(r.body, { price: 101.5 });
  assert.equal(decodePaymentResponseHeader(r.headers["PAYMENT-RESPONSE"]!).transaction, "5igSettleTx");
  assert.deepEqual(calls, { verify: 1, settle: 1 });
});

test("settlement fails: the answer is withheld and nobody is charged", async () => {
  const { gate, pay } = await setup({ settles: false });
  const r = await gate.handle(hdr({ "PAYMENT-SIGNATURE": pay() }), ok, hasPrice);
  assert.equal(r.status, 402);
  assert.equal(r.reason, "SETTLE_FAILED");
  assert.equal(r.charged, false);
  assert.doesNotMatch(JSON.stringify(r.body), /101\.5/);
});

test("buyer: only requirements for the listing's payee, mint and network, within the price, are acceptable", async () => {
  const { req } = await setup();
  const e = { network: SOLANA_DEVNET, asset: USDC_DEVNET, payTo: SELLER, maxAmount: 10_000n };
  assert.equal(acceptable([req], e).length, 1);
  assert.equal(acceptable([{ ...req, amount: "10001" }], e).length, 0);
  assert.equal(acceptable([{ ...req, amount: "0" }], e).length, 0);
  assert.equal(acceptable([{ ...req, amount: "1e9" }], e).length, 0);
  assert.equal(acceptable([{ ...req, payTo: FEE_PAYER }], e).length, 0);
  assert.equal(acceptable([{ ...req, asset: "So11111111111111111111111111111111111111112" }], e).length, 0);
  assert.equal(acceptable([{ ...req, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }], e).length, 0);
});

test("buyer: a seller that changes its payee or raises its price is refused before anything is signed", async () => {
  const signer = await generateKeyPairSigner();
  const { gate } = await setup();
  let paidCalls = 0;
  const fetchStub = async (_u: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (h["PAYMENT-SIGNATURE"]) paidCalls++;
    const r = await gate.handle(hdr(h), ok, hasPrice);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  for (const expect of [
    { network: SOLANA_DEVNET, asset: USDC_DEVNET, payTo: FEE_PAYER, maxAmount: 10_000n },
    { network: SOLANA_DEVNET, asset: USDC_DEVNET, payTo: SELLER, maxAmount: 9_999n },
  ]) {
    const r = await payAndCall("https://seller.example/v1/quote", {}, signer, expect, { fetch: fetchStub });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "NO_ACCEPTABLE_REQUIREMENTS");
  }
  assert.equal(paidCalls, 0);
});

test("buyer: an endpoint that does not ask for payment is reported, not paid", async () => {
  const signer = await generateKeyPairSigner();
  const r = await payAndCall("https://free.example", {}, signer, { network: SOLANA_DEVNET, asset: USDC_DEVNET, payTo: SELLER, maxAmount: 1n }, {
    fetch: async () => new Response("{}", { status: 200 }),
  });
  assert.deepEqual(r.ok ? null : r.reason, "NOT_PAYMENT_REQUIRED");
});
