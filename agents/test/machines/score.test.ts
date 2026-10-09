import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TOPIC, readMachineEvents, scoreMachine, type LogIo, type MachineEvent, type RawLog } from "../../src/machines/score.ts";

const DAY = 86_400;
const NOW = 100 * DAY + 3600; // 01:00 UTC on day 100
const REGISTRY = "0x2DAD8905380993940e340C5cE6d313d5c2780040";
const pad = (n: bigint | number) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// Real agung log: pad 349, event #10, type 0 (revenue), value 0x26 = 38 cents.
const REAL: RawLog = {
  topics: [EVENT_TOPIC, pad(349), pad(10)],
  data: "0x" + pad(0).slice(2) + pad(0x26).slice(2),
  transactionHash: "0xedba77c38ce45f2cfa23684baf8629cd25e5586242a7c0523db8317b3b960e27",
  blockNumber: 5000n,
};

function ev(i: number, ts: number, type: 0 | 1 = 0, value = 20n): MachineEvent {
  return { machineId: 349n, index: BigInt(i), eventType: type, value, timestamp: ts, txHash: "0x" + i, block: BigInt(i) };
}
/** n revenue events of 20 cents, one per hour ending `endAgo` seconds before NOW. */
function series(n: number, endAgo = 600, stepSecs = 3600): MachineEvent[] {
  return Array.from({ length: n }, (_, i) => ev(i + 1, NOW - endAgo - (n - 1 - i) * stepSecs));
}
/** `perDay` events a day for `days` days ending at NOW-600, 20 cents each. */
function daily(days: number, perDay: number): MachineEvent[] {
  const out: MachineEvent[] = [];
  let i = 1;
  for (let d = days - 1; d >= 0; d--) for (let k = 0; k < perDay; k++) out.push(ev(i++, NOW - 600 - d * DAY - k * 60));
  return out;
}

function stubIo(logs: RawLog[], head: bigint, stamp = (b: bigint) => 1_700_000_000 + Number(b)) {
  const calls: { fromBlock: bigint; toBlock: bigint; topics: (string | null)[]; address: string }[] = [];
  let stampCalls = 0;
  const io: LogIo = {
    getLogs: async (q) => { calls.push(q); return logs.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock); },
    blockNumber: async () => head,
    blockTimestamp: async (b) => { stampCalls++; return stamp(b); },
  };
  return { io, calls, stamps: () => stampCalls };
}

// ---- readMachineEvents ----

test("readMachineEvents decodes the real agung log", async () => {
  const { io, calls } = stubIo([REAL], 5100n);
  const r = await readMachineEvents(io, REGISTRY, 349n, 4000n);
  assert.ok(r.ok);
  assert.equal(r.toBlock, 5100n);
  assert.deepEqual(r.events, [{
    machineId: 349n, index: 10n, eventType: 0, value: 38n, timestamp: 1_700_005_000,
    txHash: REAL.transactionHash, block: 5000n,
  }]);
  assert.equal(calls[0]!.address, REGISTRY);
  assert.deepEqual(calls[0]!.topics, [EVENT_TOPIC, pad(349)]);
});

test("readMachineEvents chunks the range inclusively and sorts by index", async () => {
  const mk = (idx: number, block: bigint): RawLog => ({ ...REAL, topics: [EVENT_TOPIC, pad(349), pad(idx)], blockNumber: block });
  const { io, calls } = stubIo([mk(3, 25n), mk(1, 2n), mk(2, 11n)], 25n);
  const r = await readMachineEvents(io, REGISTRY, 349n, 1n, { chunk: 10n });
  assert.ok(r.ok);
  assert.deepEqual(calls.map((c) => [c.fromBlock, c.toBlock]), [[1n, 10n], [11n, 20n], [21n, 25n]]);
  assert.deepEqual(r.events.map((e) => e.index), [1n, 2n, 3n]);
});

test("readMachineEvents: empty when fromBlock is past the head, and one timestamp lookup per block", async () => {
  const none = stubIo([], 10n);
  const r0 = await readMachineEvents(none.io, REGISTRY, 349n, 11n);
  assert.ok(r0.ok && r0.events.length === 0 && none.calls.length === 0);
  const two = stubIo([REAL, { ...REAL, topics: [EVENT_TOPIC, pad(349), pad(11)] }], 6000n);
  const r = await readMachineEvents(two.io, REGISTRY, 349n, 0n);
  assert.ok(r.ok && r.events.length === 2);
  assert.equal(two.stamps(), 1);
});

test("readMachineEvents skips malformed logs and refuses on RPC failure or bad chunk", async () => {
  const bad: RawLog = { ...REAL, data: "0x1234" };
  const odd: RawLog = { ...REAL, data: "0x" + pad(7).slice(2) + pad(1).slice(2) };
  const { io } = stubIo([bad, odd, REAL], 6000n);
  const r = await readMachineEvents(io, REGISTRY, 349n, 0n);
  assert.ok(r.ok);
  assert.equal(r.events.length, 1);
  const failing: LogIo = { ...io, getLogs: async () => { throw new Error("rate limited"); } };
  const f = await readMachineEvents(failing, REGISTRY, 349n, 0n);
  assert.ok(!f.ok);
  assert.equal(f.reason, "log-read-failed");
  assert.match(f.message, /rate limited/);
  const c = await readMachineEvents(io, REGISTRY, 349n, 0n, { chunk: 0n });
  assert.ok(!c.ok && c.reason === "bad-chunk");
});

// ---- scoreMachine ----

test("unbonded machine: score 0, NR, whatever the history", () => {
  const s = scoreMachine(daily(14, 4), { bonded: false, nowSecs: NOW });
  assert.equal(s.score, 0);
  assert.equal(s.grade, "NR");
  assert.equal(s.provisioned, false);
});

test("provisioned by count: fewer than 10 events", () => {
  const s = scoreMachine(daily(10, 0).concat(series(9, 600, 12 * 3600)), { bonded: true, nowSecs: NOW });
  assert.equal(s.provisioned, true);
  assert.equal(s.grade, "Provisioned");
  assert.equal(s.score, 0);
  assert.equal(s.events, 9);
  assert.match(s.explain, /Provisioned/);
});

test("provisioned by span: 10 events inside 3 days; exactly 3 days is scored", () => {
  const short = scoreMachine(series(10, 600, 3600), { bonded: true, nowSecs: NOW });
  assert.equal(short.provisioned, true);
  const edge = series(10, 600, 3 * DAY / 9);
  const s = scoreMachine(edge, { bonded: true, nowSecs: NOW });
  assert.equal(s.provisioned, false);
  assert.ok(s.score > 0);
});

test("no events: bonded but provisioned", () => {
  const s = scoreMachine([], { bonded: true, nowSecs: NOW });
  assert.equal(s.provisioned, true);
  assert.equal(s.events, 0);
});

test("perfect history scores 100 AAA with the exact factors", () => {
  const s = scoreMachine(daily(15, 4), { bonded: true, nowSecs: NOW });
  assert.equal(s.provisioned, false);
  assert.deepEqual(s.factors.bond, 20);
  assert.equal(s.factors.revenue, 30);          // 14 of 14 days at 4 x 20 = 80 cents
  assert.equal(s.factors.activity, 20);          // 56 events >= 28
  assert.equal(s.factors.tenure, 10);                // span 14 days
  assert.equal(s.factors.freshness, 20);
  assert.equal(s.factors.penalty, 0);
  assert.equal(s.score, 100);
  assert.equal(s.grade, "AAA");
  assert.match(s.explain, /100 \(AAA\)/);
});

test("revenue counts only UTC days with >= 10 cents, summed within the day", () => {
  // 14 days, 2 events a day. Make 4 days worth only 9 cents (1 x 9) -> 10 qualifying days.
  const evs: MachineEvent[] = [];
  let i = 1;
  for (let d = 13; d >= 0; d--) {
    const dayStart = (100 - d) * DAY;
    const weak = d % 3 === 0 && d > 0 ? 4 : 0; // d = 12, 9, 6, 3 weak (4 days)
    evs.push(ev(i++, Math.min(dayStart + 7200, NOW - 600), 0, weak ? 9n : 5n));
    evs.push(ev(i++, Math.min(dayStart + 7300, NOW - 600), 0, weak ? 0n : 5n)); // 10 cents total when not weak
  }
  const s = scoreMachine(evs, { bonded: true, nowSecs: NOW });
  assert.equal(s.factors.revenue, (30 * 10) / 14);
});

test("revenue ignores days older than 14 and outage events", () => {
  const old = daily(30, 3).slice(0, 30 * 3 - 14 * 3); // only the older 16 days
  const s = scoreMachine(old.concat([ev(9999, NOW - 600, 1, 0n)]), { bonded: true, nowSecs: NOW - 0 });
  assert.equal(s.factors.revenue, 0);
});

test("activity scales with events in the last 14 days (28 for full marks)", () => {
  const s = scoreMachine(daily(14, 1), { bonded: true, nowSecs: NOW }); // 14 events
  assert.equal(s.factors.activity, 10);
  const t = scoreMachine(daily(14, 2), { bonded: true, nowSecs: NOW }); // 28 events
  assert.equal(t.factors.activity, 20);
});

test("tenure scales with span, capped at 14 days", () => {
  const s = scoreMachine(daily(7, 2), { bonded: true, nowSecs: NOW });
  assert.ok(s.factors.tenure > 4.2 && s.factors.tenure < 5.2);
  const t = scoreMachine(daily(30, 1), { bonded: true, nowSecs: NOW });
  assert.equal(t.factors.tenure, 10);
});

test("freshness: full within 24 h, linear to zero at 7 days", () => {
  const base = daily(10, 2).map((e) => ({ ...e }));
  const shift = (secs: number) => base.map((e) => ({ ...e, timestamp: e.timestamp - secs }));
  const lastAgo = (age: number) => scoreMachine(shift(age - 600), { bonded: true, nowSecs: NOW }).factors.freshness;
  assert.equal(lastAgo(DAY), 20);
  assert.equal(lastAgo(7 * DAY), 0);
  assert.equal(lastAgo(9 * DAY), 0);
  assert.ok(Math.abs(lastAgo(4 * DAY) - (20 * 3) / 6) < 1e-9);
});

test("outage penalty: -15 each, only type 1 with value > 0 in the last 7 days", () => {
  const base = daily(15, 4);
  const out1 = ev(900, NOW - 3 * DAY, 1, 4000n);
  const out2 = ev(901, NOW - 2 * DAY, 1, 5000n);
  const stale = ev(902, NOW - 8 * DAY, 1, 5000n);
  const ping = ev(903, NOW - 1 * DAY, 1, 0n); // plain activity, not an outage
  const s = scoreMachine([...base, out1, out2, stale, ping], { bonded: true, nowSecs: NOW });
  assert.equal(s.outages7d, 2);
  assert.equal(s.factors.penalty, -30);
  assert.equal(s.score, 70);
  assert.equal(s.grade, "BBB");
  assert.match(s.explain, /minus 30 for 2 outages/);
});

test("score is clamped at 0", () => {
  const outages = Array.from({ length: 6 }, (_, i) => ev(800 + i, NOW - 2 * DAY - i, 1, 100n));
  const s = scoreMachine([...daily(5, 2), ...outages], { bonded: true, nowSecs: NOW });
  assert.equal(s.score, 0);
  assert.equal(s.grade, "NR");
  assert.equal(s.provisioned, false);
});

test("grade boundaries (via outage penalties on a perfect base)", () => {
  const base = daily(15, 4);
  const withOutages = (n: number) =>
    scoreMachine([...base, ...Array.from({ length: n }, (_, i) => ev(700 + i, NOW - DAY - i, 1, 60n))], { bonded: true, nowSecs: NOW });
  assert.equal(withOutages(0).grade, "AAA"); // 100
  assert.equal(withOutages(1).score, 85);
  assert.equal(withOutages(1).grade, "AA");
  assert.equal(withOutages(2).score, 70);
  assert.equal(withOutages(2).grade, "BBB");
  assert.equal(withOutages(3).score, 55);
  assert.equal(withOutages(3).grade, "BB");
  assert.equal(withOutages(4).score, 40);
  assert.equal(withOutages(4).grade, "B");
  assert.equal(withOutages(5).score, 25);
  assert.equal(withOutages(5).grade, "NR");
});

test("grade thresholds at every cut (95/85/75/60/45/30)", () => {
  // Tune the sum through revenue days: base without outages, 14 days at 4 events; drop revenue by using 5-cent events.
  const cut = (revenueDays: number) => {
    const evs = daily(15, 4).map((e, idx) => {
      const day = Math.floor((e.timestamp - (NOW - 600 - 13 * DAY)) / DAY + 1e-9);
      return { ...e, value: day < 14 - revenueDays ? 1n : 20n, index: BigInt(idx + 1) };
    });
    return scoreMachine(evs, { bonded: true, nowSecs: NOW });
  };
  // Each revenue day is worth 30/14 = 2.14 points; walk down and check grade is monotone with score.
  const order = ["NR", "B", "BB", "BBB", "A", "AA", "AAA"];
  let prev = -1;
  for (let d = 0; d <= 14; d++) {
    const s = cut(d);
    const rank = order.indexOf(s.grade);
    assert.ok(rank >= prev, `grade regressed at ${d} revenue days`);
    prev = rank;
    const expected = s.score >= 95 ? "AAA" : s.score >= 85 ? "AA" : s.score >= 75 ? "A" : s.score >= 60 ? "BBB" : s.score >= 45 ? "BB" : s.score >= 30 ? "B" : "NR";
    assert.equal(s.grade, expected);
  }
  assert.equal(cut(14).grade, "AAA");
});

test("explain names the two largest factors", () => {
  const s = scoreMachine(daily(15, 4), { bonded: true, nowSecs: NOW });
  assert.match(s.explain, /revenue \(30\.0\)/);
  assert.match(s.explain, /bond \(20\.0\)/);
});
