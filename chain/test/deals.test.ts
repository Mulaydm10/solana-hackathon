// The deal library: every action through the library against the compiled program (LiteSVM), and
// the safe-send state machine against a scripted fake client.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { deals, getDeal, getPolicy, getRepPair, getSellerRep, safeSend, type DealClient, type DealContext } from "../src/index.ts";
import { HOUR, USDC, hash, setup } from "./harness.ts";

async function lib() {
  const t = await setup();
  const ctx: DealContext = { client: t.client as unknown as DealClient, mint: t.mint.address, sleep: async () => {} };
  let nextId = 1000n;
  const open = (o: Partial<Parameters<typeof deals.open>[2]> = {}) =>
    deals.open(ctx, t.buyer, {
      seller: t.seller.address, dealId: nextId++, amount: 5n * USDC, deadline: t.now() + HOUR, reviewSecs: 600,
      resolveSecs: 600, toleranceBps: 500, stakeRequired: 1n * USDC, bondBps: 1000, verifier: t.verifier.address,
      termsHash: hash(7), ...o,
    });
  return { t, ctx, open };
}

test("library: open, accept, deliver, release; views read back", async () => {
  const { t, ctx, open } = await lib();
  const o = await open();
  assert.ok(o.ok, JSON.stringify(o));
  const deal = (o as { deal: Address }).deal;
  assert.equal((await getDeal(ctx, deal))?.status, "Open");
  assert.equal((await deals.accept(ctx, t.seller, deal)).ok, true);
  assert.equal((await deals.deliver(ctx, t.seller, deal, hash(3), 5n * USDC)).ok, true);
  const r = await deals.release(ctx, t.buyer, deal, hash(3));
  assert.equal(r.ok, true);
  const v = await getDeal(ctx, deal);
  assert.equal(v?.status, "Released");
  assert.equal(v?.deliveryHash, "03".repeat(32));
  const p = await getPolicy(ctx, t.buyer.address);
  assert.equal(p?.periodSpent, String(5n * USDC));
});

test("library: reputation views read back after settlement; unknown sellers read as zeros", async () => {
  const { t, ctx, open } = await lib();
  const deal = (await open() as { deal: Address }).deal;
  await deals.accept(ctx, t.seller, deal);
  await deals.deliver(ctx, t.seller, deal, hash(3), 5n * USDC);
  await deals.release(ctx, t.buyer, deal, hash(3));
  const rep = await getSellerRep(ctx, t.seller.address);
  assert.deepEqual(
    { completed: rep.completed, failed: rep.failed, volume: rep.volume, distinctBuyers: rep.distinctBuyers },
    { completed: 1, failed: 0, volume: String(5n * USDC), distinctBuyers: 1 },
  );
  assert.equal((await getRepPair(ctx, t.seller.address, t.buyer.address)).completed, 1);
  const none = await getSellerRep(ctx, t.stranger.address);
  assert.equal(none.completed, 0);
  assert.equal(none.volume, "0");
});

test("library: refusals come back as program error names, not exceptions", async () => {
  const { t, ctx, open } = await lib();
  const deal = ((await open()) as { deal: Address }).deal;
  await deals.accept(ctx, t.seller, deal);
  await deals.deliver(ctx, t.seller, deal, hash(3), 5n * USDC);
  assert.deepEqual(await deals.release(ctx, t.buyer, deal, hash(4)).then((r) => !r.ok && r.reason), "DeliveryMismatch");
  assert.deepEqual(await open({ seller: t.stranger.address }).then((r) => !r.ok && r.reason), "SellerNotAllowed");
  assert.deepEqual(await deals.claim(ctx, t.stranger, "11111111111111111111111111111112" as Address).then((r) => !r.ok && r.reason), "DEAL_NOT_FOUND");
});

test("library: challenge upheld and missed-deadline refund", async () => {
  const { t, ctx, open } = await lib();
  const a = ((await open()) as { deal: Address }).deal;
  await deals.accept(ctx, t.seller, a);
  await deals.deliver(ctx, t.seller, a, hash(3), 5n * USDC);
  assert.equal((await deals.challenge(ctx, t.buyer, a)).ok, true);
  assert.equal((await deals.resolve(ctx, t.verifier, a, false)).ok, true);
  assert.equal((await getDeal(ctx, a))?.status, "VerifiedFail");
  const b = ((await open()) as { deal: Address }).deal;
  await deals.accept(ctx, t.seller, b);
  t.warp(HOUR + 1n);
  assert.equal((await deals.refund(ctx, t.stranger, b)).ok, true);
  assert.equal((await getDeal(ctx, b))?.status, "Refunded");
});

// ---- safe-send state machine, against a scripted fake client -----------------------------------

const DEAL = "BGNonUhsbsH4WrRtt8hErsoX1vvKt6Yfrzh5j358pqih" as Address;
const http429 = () => Object.assign(new Error("Failed to send transaction"), { cause: { context: { causeMessage: "HTTP error (429)" } } });
const programError = (code: number) => Object.assign(new Error("tx failed"), { cause: { context: { code } } });

function fake(script: Array<() => Promise<{ context: { signature: string } }>>) {
  let sends = 0;
  const client: DealClient = {
    rpc: {
      getSignaturesForAddress: () => ({ send: async () => [{ signature: "SIG_FROM_CHAIN" }] }),
    } as unknown as DealClient["rpc"],
    sendTransaction: async () => script[Math.min(sends++, script.length - 1)]!(),
  };
  return { client, sends: () => sends };
}
const ctxOf = (client: DealClient, extra: Partial<DealContext> = {}): DealContext => ({
  client, mint: DEAL, sleep: async () => {}, confirmTimeoutMs: 20, ...extra,
});

test("safeSend: success is returned as is", async () => {
  const f = fake([async () => ({ context: { signature: "S1" } })]);
  assert.deepEqual(await safeSend(ctxOf(f.client), DEAL, async () => false, async () => []), { ok: true, signature: "S1" });
  assert.equal(f.sends(), 1);
});

test("safeSend: 429 after the transaction landed -> chain decides, no second send", async () => {
  const f = fake([async () => { throw http429(); }]);
  const r = await safeSend(ctxOf(f.client), DEAL, async () => true, async () => []);
  assert.deepEqual(r, { ok: true, signature: "SIG_FROM_CHAIN" });
  assert.equal(f.sends(), 1);
});

test("safeSend: 429, not landed -> resend; resend hits a program error because it landed meanwhile -> ok", async () => {
  let landed = false;
  const f = fake([async () => { throw http429(); }, async () => { landed = true; throw programError(6004); }]);
  const r = await safeSend(ctxOf(f.client), DEAL, async () => landed, async () => []);
  assert.deepEqual(r, { ok: true, signature: "SIG_FROM_CHAIN" });
  assert.equal(f.sends(), 2);
});

test("safeSend: stalled confirmation -> chain shows it landed -> ok", async () => {
  const f = fake([() => new Promise(() => {})]);
  const r = await safeSend(ctxOf(f.client), DEAL, async () => true, async () => []);
  assert.deepEqual(r, { ok: true, signature: "SIG_FROM_CHAIN" });
});

test("safeSend: a program error with no uncertainty is a refusal and is never retried", async () => {
  const f = fake([async () => { throw programError(6004); }]);
  const r = await safeSend(ctxOf(f.client), DEAL, async () => false, async () => []);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "WrongStatus"]);
  assert.equal(f.sends(), 1);
});

test("safeSend: rate-limited every time and never landed -> RATE_LIMITED after the attempt limit", async () => {
  const f = fake([async () => { throw http429(); }]);
  const r = await safeSend(ctxOf(f.client, { attempts: 4 }), DEAL, async () => false, async () => []);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "RATE_LIMITED"]);
  assert.equal(f.sends(), 4);
});

test("safeSend: timeouts every time and never landed -> CONFIRMATION_TIMEOUT", async () => {
  const f = fake([() => new Promise(() => {})]);
  const r = await safeSend(ctxOf(f.client, { attempts: 2 }), DEAL, async () => false, async () => []);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "CONFIRMATION_TIMEOUT"]);
});

const netError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

test("safeSend: a network blip after landing -> chain decides, no second send", async () => {
  const f = fake([async () => { throw netError(); }]);
  assert.deepEqual(await safeSend(ctxOf(f.client), DEAL, async () => true, async () => []), { ok: true, signature: "SIG_FROM_CHAIN" });
  assert.equal(f.sends(), 1);
});

test("safeSend: 5xx / blockhash-not-found, not landed -> resend succeeds", async () => {
  const blockhash = () => new Error("Transaction simulation failed: Blockhash not found");
  const http503 = () => Object.assign(new Error("send failed"), { cause: { context: { causeMessage: "HTTP error (503)" } } });
  for (const make of [blockhash, http503]) {
    const f = fake([async () => { throw make(); }, async () => ({ context: { signature: "S2" } })]);
    assert.deepEqual(await safeSend(ctxOf(f.client), DEAL, async () => false, async () => []), { ok: true, signature: "S2" });
    assert.equal(f.sends(), 2);
  }
});

test("safeSend: persistent network failure, never landed -> RPC_UNAVAILABLE", async () => {
  const f = fake([async () => { throw netError(); }]);
  const r = await safeSend(ctxOf(f.client, { attempts: 3 }), DEAL, async () => false, async () => []);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "RPC_UNAVAILABLE"]);
});

test("isTransient: program errors and plain bugs are not transient", async () => {
  const { isTransient } = await import("../src/retry.ts");
  assert.equal(isTransient(programError(6004)), false);
  assert.equal(isTransient(new Error("Cannot read properties of undefined")), false);
  assert.equal(isTransient(http429()), true);
});

test("safeSend: confirmation websocket fails after the tx landed -> ok (seen live)", async () => {
  const ws = () => new Error("Failed to send transaction (4hw2...): WebSocket failed to connect");
  const f = fake([async () => { throw ws(); }]);
  assert.deepEqual(await safeSend(ctxOf(f.client), DEAL, async () => true, async () => []), { ok: true, signature: "SIG_FROM_CHAIN" });
  assert.equal(f.sends(), 1);
});

test("safeSend: an unknown error -> chain checked; landed = ok, otherwise reported and never resent", async () => {
  const weird = () => new Error("something nobody anticipated");
  const landedF = fake([async () => { throw weird(); }]);
  assert.equal((await safeSend(ctxOf(landedF.client), DEAL, async () => true, async () => [])).ok, true);
  const notF = fake([async () => { throw weird(); }]);
  const r = await safeSend(ctxOf(notF.client), DEAL, async () => false, async () => []);
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "CHAIN_ERROR"]);
  assert.equal(notF.sends(), 1);
});
