// #210: the devnet double spend. The first agent_spend landed, its confirmation failed with an HTTP 429, and the
// "did it land?" read was stale, so safeSend rebuilt and resent: a second valid payment. With exactlyOnce, a send
// that lands and then errors, followed by a stale read, must produce exactly one transaction.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Instruction } from "@solana/kit";
import { safeSend, BLOCKHASH_WINDOW, type DealContext } from "../src/index.ts";

const WATCH = "11111111111111111111111111111111" as Address;
const http429 = () => Object.assign(new Error("HTTP error (429)"), { context: { statusCode: 429 } });

/**
 * A fake cluster: sendTransaction "lands" the transaction (the chain's state moves) and then fails with a 429.
 * The chain view a read sees lags `lagReads` reads behind (a stale RPC node). Block height advances 20 per read.
 */
function fakeCluster(o: { lagReads: number; failAfterLanding: boolean }) {
  let landedCount = 0;
  let sends = 0;
  let reads = 0;
  let height = 1_000n;
  const ctx: DealContext = {
    mint: WATCH,
    sleep: async () => {},
    client: {
      rpc: {
        getSignaturesForAddress: () => ({ send: async () => [{ signature: `sig${landedCount}` }] }),
        getBlockHeight: () => ({ send: async () => (height += 20n) }),
      } as never,
      async sendTransaction(_ix: Instruction[]) {
        sends++;
        landedCount++;
        if (o.failAfterLanding) throw http429();
        return { context: { signature: `sig${landedCount}` } };
      },
    },
  };
  // The read shows the landed count only once `lagReads` reads have passed since it moved.
  let seenAt = -1;
  const landed = async () => {
    reads++;
    if (landedCount > 0 && seenAt < 0) seenAt = reads;
    return landedCount > 0 && reads - seenAt >= o.lagReads;
  };
  return { ctx, landed, sends: () => sends, landedCount: () => landedCount, height: () => height };
}

const build = async () => [] as Instruction[];

test("exactlyOnce: a send that lands, then a 429, then a stale read => exactly one transaction", async () => {
  const c = fakeCluster({ lagReads: 1, failAfterLanding: true });
  const r = await safeSend(c.ctx, WATCH, c.landed, build, { exactlyOnce: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(c.sends(), 1, "the spend was sent once");
  assert.equal(c.landedCount(), 1, "one payment landed");
});

test("exactlyOnce waits for the blockhash window before trusting a 'not landed' read", async () => {
  const c = fakeCluster({ lagReads: 1, failAfterLanding: true });
  const start = c.height();
  await safeSend(c.ctx, WATCH, c.landed, build, { exactlyOnce: true });
  assert.ok(c.height() > start + BLOCKHASH_WINDOW, "it read the chain again only after the first blockhash expired");
});

test("without exactlyOnce the same stale read resends (the bug, kept for actions the program rejects twice)", async () => {
  const c = fakeCluster({ lagReads: 1, failAfterLanding: true });
  await safeSend({ ...c.ctx, attempts: 2 }, WATCH, c.landed, build);
  assert.equal(c.sends(), 2, "a plain safeSend resends after a stale read");
});

test("exactlyOnce: a clean send is one transaction and no waiting", async () => {
  const c = fakeCluster({ lagReads: 0, failAfterLanding: false });
  const start = c.height();
  const r = await safeSend(c.ctx, WATCH, c.landed, build, { exactlyOnce: true });
  assert.equal(r.ok, true);
  assert.equal(c.sends(), 1);
  assert.ok(c.height() - start <= 20n, "no expiry wait on success");
});

test("exactlyOnce: a send that never landed is retried only after its window passed", async () => {
  let sends = 0;
  let height = 0n;
  const heightsAtSend: bigint[] = [];
  const ctx: DealContext = {
    mint: WATCH, sleep: async () => {}, attempts: 3,
    client: {
      rpc: { getSignaturesForAddress: () => ({ send: async () => [] }), getBlockHeight: () => ({ send: async () => (height += 20n) }) } as never,
      async sendTransaction() {
        sends++;
        heightsAtSend.push(height);
        if (sends === 1) throw http429(); // lost before landing
        return { context: { signature: "sig-final" } };
      },
    },
  };
  const r = await safeSend(ctx, WATCH, async () => false, build, { exactlyOnce: true });
  assert.equal(r.ok, true);
  assert.equal(sends, 2);
  assert.ok(heightsAtSend[1]! - heightsAtSend[0]! > BLOCKHASH_WINDOW, "the resend happened only after the first one could no longer land");
});
