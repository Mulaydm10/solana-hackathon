// #208: a failed chain read (public RPC 429) must not look like a revoked mandate, but a read that shows a revoke
// must still stop the worker at once.
import test from "node:test";
import assert from "node:assert/strict";
import { liveFrom } from "../src/team/chain-state.ts";
import type { MandateSource, MandateState } from "../src/broker/broker.ts";

const LIVE: MandateState = { live: true, stageOpen: true, roleHash: "00".repeat(32) };
const REVOKED: MandateState = { ...LIVE, live: false };
const rpc429 = () => Object.assign(new Error("HTTP error (429)"), { statusCode: 429 });

/** A source that answers from a script: a state, or "err" to throw. */
function scripted(steps: (MandateState | null | "err")[]): MandateSource {
  let i = 0;
  return async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s === "err") throw rpc429();
    return s;
  };
}

test("an RPC error after a live read keeps the worker running (not treated as revoked)", async () => {
  const live = liveFrom(scripted([LIVE, "err", "err", LIVE]));
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), true);
});

test("a successful read showing a revoke stops the worker at once, even after errors", async () => {
  const live = liveFrom(scripted([LIVE, "err", REVOKED, "err"]));
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), false);
  // and an error after that keeps the revoked answer
  assert.equal(await live("m", "a"), false);
});

test("errors with no successful read yet fail closed", async () => {
  const live = liveFrom(scripted(["err"]));
  assert.equal(await live("m", "a"), false);
});

test("a missing mission or mandate (null) is not live", async () => {
  const live = liveFrom(scripted([LIVE, null]));
  assert.equal(await live("m", "a"), true);
  assert.equal(await live("m", "a"), false);
});

test("answers are kept per mission and agent", async () => {
  const src: MandateSource = async (_m, agent) => {
    if (agent === "bad") throw rpc429();
    return LIVE;
  };
  const live = liveFrom(src);
  assert.equal(await live("m", "good"), true);
  assert.equal(await live("m", "bad"), false);
});
