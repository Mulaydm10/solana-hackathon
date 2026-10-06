// #227 (peaq track): the signed meter reading, the peaq event shape, and the charge-on-delivery loop's refusal and
// idempotency rules, with stubbed chain and peaq clients (no network). machines-chain.test.ts runs the real program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Address } from "@solana/kit";
import {
  canonicalReading, charge, createPeaqClient, eventParams, memoryLedger, signReading, sourceTxHash, usdCents, verifyReading,
  type ChargeChain, type MeterReading, type PeaqEventParams, type Settlement,
} from "../src/index.ts";

const padSecret = new Uint8Array(32).fill(7);
const padPublic = ed25519.getPublicKey(padSecret);
const reading = (over: Partial<MeterReading> = {}): MeterReading => ({
  padId: "pad-1", robotId: "robot-1", kWh: "1.25", startedAt: 1_800_000_000, endedAt: 1_800_000_900, priceMicroUsdc: 400_000n, nonce: "n-1", ...over,
});
const PROGRAM = "CfD43mq2P1mVVpKxueo1XDe6UrQBCF3DZjNmDGQNVGSV";
const DEAL = "BQ2UX41FDmdg8UyGFQQLjqW8T8GovFTiN3S9AsCFvP3x" as Address;

// ---------- meter ----------

test("meter: the delivery hash is sha256 of the canonical reading, and the pad's signature verifies", () => {
  const s = signReading(reading(), padSecret);
  assert.deepEqual(s.deliveryHash, sha256(canonicalReading(reading())));
  assert.equal(verifyReading(s.reading, s.signature, padPublic), true);
  assert.equal(
    new TextDecoder().decode(canonicalReading(reading())),
    '{"endedAt":1800000900,"kWh":"1.25","nonce":"n-1","padId":"pad-1","priceMicroUsdc":"400000","robotId":"robot-1","startedAt":1800000000}',
  );
});

test("meter: a changed reading, another key or a bad signature does not verify (and never throws)", () => {
  const s = signReading(reading(), padSecret);
  assert.equal(verifyReading({ ...s.reading, kWh: "9.99" }, s.signature, padPublic), false);
  assert.equal(verifyReading(s.reading, s.signature, ed25519.getPublicKey(new Uint8Array(32).fill(8))), false);
  assert.equal(verifyReading(s.reading, new Uint8Array(64), padPublic), false);
  assert.equal(verifyReading({ ...s.reading, kWh: "1.5e3" }, s.signature, padPublic), false);
});

test("meter: two charges with different nonces never share a delivery hash; malformed readings are rejected", () => {
  assert.notDeepEqual(signReading(reading(), padSecret).deliveryHash, signReading(reading({ nonce: "n-2" }), padSecret).deliveryHash);
  for (const bad of [{ kWh: "1.2345" }, { kWh: "-1" }, { endedAt: 1 }, { nonce: "" }, { priceMicroUsdc: 0n }]) {
    assert.throws(() => signReading(reading(bad), padSecret), TypeError, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? `${v}` : v)));
  }
});

// ---------- peaq events ----------

const settlement = (over: Partial<Settlement> = {}): Settlement => ({
  chargeId: "c-1", deal: DEAL, releaseSignature: "5f79BRnkCmV5Wf9s", deliveryHash: new Uint8Array(32).fill(1), amount: 400_000n, ...over,
});

test("peaq: the pad's revenue event is USD cents at trust level 1, linked to the Solana release", () => {
  const r = eventParams("revenue", 12n, settlement(), { sourceChainId: 5 }, PROGRAM, 1_800_000_000.7);
  assert.ok(r.ok);
  const p = r.params;
  assert.equal(p.eventType, 0);
  assert.equal(p.value, 40, "0.40 USDC = 40 cents");
  assert.equal(p.currency, "USD");
  assert.equal(p.trustLevel, 1);
  assert.equal(p.sourceChainId, 5);
  assert.equal(p.timestamp, 1_800_000_000);
  assert.equal(p.sourceTxHash, sourceTxHash("5f79BRnkCmV5Wf9s"));
  assert.match(p.sourceTxHash, /^0x[0-9a-f]{64}$/);
  const raw = JSON.parse(new TextDecoder().decode(p.rawData));
  assert.deepEqual(raw, {
    amount: "400000", chargeId: "c-1", deal: DEAL, deliveryHash: "01".repeat(32), program: PROGRAM, releaseSignature: "5f79BRnkCmV5Wf9s", solanaCluster: "devnet",
  });
});

test("peaq: the robot's activity event has value 0 and no currency", () => {
  const r = eventParams("activity", 13n, settlement(), { sourceChainId: 5 }, PROGRAM, 1);
  assert.ok(r.ok);
  assert.equal(r.params.eventType, 1);
  assert.equal(r.params.value, 0);
  assert.equal(r.params.currency, "");
  assert.equal(r.params.trustLevel, 1);
});

test("peaq: money is never rounded, and events need a release and a real machine id", () => {
  assert.deepEqual(usdCents(1_000_000n), { ok: true, cents: 100 });
  assert.equal((usdCents(400_001n) as { reason: string }).reason, "SUBCENT_AMOUNT");
  assert.equal((eventParams("revenue", 12n, settlement({ amount: 1n }), { sourceChainId: 5 }, PROGRAM, 1) as { reason: string }).reason, "SUBCENT_AMOUNT");
  assert.equal((eventParams("revenue", 0n, settlement(), { sourceChainId: 5 }, PROGRAM, 1) as { reason: string }).reason, "BAD_MACHINE_ID");
  assert.equal((eventParams("activity", 1n, settlement({ releaseSignature: "" }), { sourceChainId: 5 }, PROGRAM, 1) as { reason: string }).reason, "NOT_RELEASED");
});

test("peaq: a failed submit is a refusal naming only the error code, never the request or a key", async () => {
  const secret = "0x" + "ab".repeat(32);
  const c = createPeaqClient({ rpcUrl: "x", deployment: "agung-2026-08-28", eventRegistry: "0x1", sourceChainId: 5 }, {
    program: PROGRAM, submit: async () => { throw Object.assign(new Error(`boom ${secret}`), { code: "MachineNotFound" }); },
  });
  const r = await c.submitRevenueEvent(12n, settlement());
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "PEAQ_SUBMIT_FAILED" && r.message.includes("MachineNotFound") && !r.message.includes(secret));
});

test("peaq: MCR is 'not served' on testnet (no guess), and read from the API on mainnet", async () => {
  const urls: string[] = [];
  const fetchStub = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ status: "Provisioned" })); }) as unknown as typeof fetch;
  const agung = createPeaqClient({ rpcUrl: "x", deployment: "agung-2026-08-28", eventRegistry: "0x1", sourceChainId: 5 }, { program: PROGRAM, submit: async () => ({ txHash: "0x" }), fetch: fetchStub });
  assert.equal(((await agung.queryMcr(12n)) as { reason: string }).reason, "MCR_NOT_SERVED");
  assert.equal(urls.length, 0);
  const main = createPeaqClient({ rpcUrl: "x", deployment: "peaq-mainnet", eventRegistry: "0x1", sourceChainId: 5 }, { program: PROGRAM, submit: async () => ({ txHash: "0x" }), fetch: fetchStub });
  assert.deepEqual(await main.queryMcr(12n), { ok: true, status: "Provisioned" });
  assert.deepEqual(urls, ["https://mcr.peaq.xyz/mcr/did:peaq:12"]);
});

// ---------- the charge loop (stubbed chain and peaq) ----------

function fakes(o: { refuseOpen?: string; failReleaseOnce?: boolean; failPeaqOnce?: "revenue" | "activity" } = {}) {
  const calls: string[] = [];
  const events: PeaqEventParams[] = [];
  let releaseFails = o.failReleaseOnce ? 1 : 0;
  let peaqFails = o.failPeaqOnce ? 1 : 0;
  const ok = (sig: string) => ({ ok: true as const, signature: sig });
  const chain: ChargeChain = {
    openDeal: async () => {
      calls.push("open");
      return o.refuseOpen ? { ok: false, reason: o.refuseOpen, message: `Solana program refused: ${o.refuseOpen}` } : { ...ok("sig-open"), deal: DEAL };
    },
    accept: async () => (calls.push("accept"), ok("sig-accept")),
    deliver: async () => (calls.push("deliver"), ok("sig-deliver")),
    release: async () => {
      calls.push("release");
      if (releaseFails-- > 0) return { ok: false, reason: "RPC_UNAVAILABLE", message: "transient" };
      return ok("sig-release");
    },
  };
  const peaq = createPeaqClient({ rpcUrl: "x", deployment: "agung-2026-08-28", eventRegistry: "0x1", sourceChainId: 5 }, {
    program: PROGRAM, now: () => 1,
    submit: async (p) => {
      const kind = p.eventType === 0 ? "revenue" : "activity";
      calls.push(kind);
      if (o.failPeaqOnce === kind && peaqFails-- > 0) throw Object.assign(new Error("x"), { code: "RPC" });
      events.push(p);
      return { txHash: `0x${kind}` };
    },
  });
  const ledger = memoryLedger();
  return { calls, events, ledger, deps: { chain, peaq, ledger, padSecret, padPublic, robotMachineId: 13n, padMachineId: 12n } };
}

test("charge: open -> accept -> deliver(meter hash) -> release -> pad revenue + robot activity events", async () => {
  const f = fakes();
  const r = await charge(f.deps, { chargeId: "c-1", amount: 400_000n, reading: reading() });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(f.calls, ["open", "accept", "deliver", "release", "revenue", "activity"]);
  assert.deepEqual(r.deliveryHash, signReading(reading(), padSecret).deliveryHash);
  assert.equal(r.padEventTx, "0xrevenue");
  assert.equal(r.robotEventTx, "0xactivity");
  assert.equal(f.events[0]!.machineId, 12n, "revenue goes to the pad");
  assert.equal(f.events[1]!.machineId, 13n, "activity goes to the robot");
  assert.equal(f.events[0]!.sourceTxHash, sourceTxHash("sig-release"));
});

test("charge: an over-limit amount is refused by the program at open, and nothing else happens", async () => {
  const f = fakes({ refuseOpen: "OverPerTxCap" });
  const r = await charge(f.deps, { chargeId: "c-over", amount: 600_000n, reading: reading({ priceMicroUsdc: 600_000n }) });
  assert.deepEqual(r, { ok: false, reason: "OverPerTxCap", message: "Solana program refused: OverPerTxCap" });
  assert.deepEqual(f.calls, ["open"]);
  assert.equal(f.events.length, 0, "no peaq event for a refused charge");
  assert.equal(await f.ledger.get("c-over"), undefined, "nothing recorded");
});

test("charge: refused before any send for a mismatched price, a wrong pad key or a malformed reading", async () => {
  const f = fakes();
  assert.equal(((await charge(f.deps, { chargeId: "a", amount: 500_000n, reading: reading() })) as { reason: string }).reason, "READING_MISMATCH");
  assert.equal(((await charge({ ...f.deps, padPublic: new Uint8Array(32) }, { chargeId: "b", amount: 400_000n, reading: reading() })) as { reason: string }).reason, "WRONG_PAD_KEY");
  assert.equal(((await charge(f.deps, { chargeId: "c", amount: 400_000n, reading: reading({ kWh: "abc" }) })) as { reason: string }).reason, "BAD_READING");
  assert.equal(((await charge(f.deps, { chargeId: "", amount: 400_000n, reading: reading() })) as { reason: string }).reason, "BAD_CHARGE_ID");
  assert.deepEqual(f.calls, []);
});

test("charge: a retry after a failed release resumes there; it never opens, accepts or delivers twice", async () => {
  const f = fakes({ failReleaseOnce: true });
  const first = await charge(f.deps, { chargeId: "c-r", amount: 400_000n, reading: reading() });
  assert.equal((first as { reason: string }).reason, "RPC_UNAVAILABLE");
  const second = await charge(f.deps, { chargeId: "c-r", amount: 400_000n, reading: reading() });
  assert.ok(second.ok);
  assert.deepEqual(f.calls, ["open", "accept", "deliver", "release", "release", "revenue", "activity"]);
});

test("charge: a retry after a failed peaq write writes only the missing event; a finished charge writes nothing more", async () => {
  const f = fakes({ failPeaqOnce: "activity" });
  assert.equal(((await charge(f.deps, { chargeId: "c-p", amount: 400_000n, reading: reading() })) as { reason: string }).reason, "PEAQ_SUBMIT_FAILED");
  assert.ok((await charge(f.deps, { chargeId: "c-p", amount: 400_000n, reading: reading() })).ok);
  assert.ok((await charge(f.deps, { chargeId: "c-p", amount: 400_000n, reading: reading() })).ok, "repeat of a finished charge is a no-op");
  assert.deepEqual(f.calls, ["open", "accept", "deliver", "release", "revenue", "activity", "activity"]);
  assert.equal(f.events.filter((e) => e.eventType === 0).length, 1, "one revenue event");
  assert.equal(f.events.filter((e) => e.eventType === 1).length, 1, "one activity event");
});

test("charge: one charge id cannot be reused for a different meter reading", async () => {
  const f = fakes();
  assert.ok((await charge(f.deps, { chargeId: "c-x", amount: 400_000n, reading: reading() })).ok);
  const r = await charge(f.deps, { chargeId: "c-x", amount: 400_000n, reading: reading({ nonce: "other" }) });
  assert.equal((r as { reason: string }).reason, "CHARGE_ID_REUSED");
});

test("charge: two concurrent calls for the same charge open one deal and write each event once", async () => {
  const f = fakes();
  const [a, b] = await Promise.all([
    charge(f.deps, { chargeId: "c-c", amount: 400_000n, reading: reading() }),
    charge(f.deps, { chargeId: "c-c", amount: 400_000n, reading: reading() }),
  ]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(f.calls, ["open", "accept", "deliver", "release", "revenue", "activity"]);
});
