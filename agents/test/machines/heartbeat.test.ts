import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  OUTAGE_AFTER_SECS,
  canonicalOutage,
  heartbeatMessage,
  outageHash,
  outageProof,
  signHeartbeat,
  uptime,
  verifyHeartbeat,
  verifyOutageProof,
  type Heartbeat,
} from "../../src/machines/heartbeat.ts";

// A throwaway key generated per run; never a real key.
const KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(KEY);
const OTHER = privateKeyToAccount(generatePrivateKey());
const MACHINE = "349";

const beat = (sentAt: number): Promise<Heartbeat> => signHeartbeat(MACHINE, sentAt, KEY);

test("heartbeatMessage: exact peaq format, LF, no trailing newline", () => {
  assert.equal(heartbeatMessage("349", 1700000000), "machineId: 349\nsentAt: 1700000000");
  assert.equal(heartbeatMessage("349", 1700000000).endsWith("\n"), false);
  assert.equal(heartbeatMessage("349", 1700000000).includes("\r"), false);
});

test("signHeartbeat then verifyHeartbeat: true for the pad address", async () => {
  const h = await beat(1000);
  assert.equal(h.address, ACCOUNT.address);
  assert.equal(h.machineId, MACHINE);
  assert.equal(h.sentAt, 1000);
  assert.equal(await verifyHeartbeat(h, ACCOUNT.address), true);
});

test("verifyHeartbeat: false for a wrong expected address", async () => {
  const h = await beat(1000);
  assert.equal(await verifyHeartbeat(h, OTHER.address), false);
});

test("verifyHeartbeat: false when sentAt is tampered", async () => {
  const h = await beat(1000);
  assert.equal(await verifyHeartbeat({ ...h, sentAt: 1001 }, ACCOUNT.address), false);
});

test("verifyHeartbeat: false for a garbage signature, never throws", async () => {
  const h = await beat(1000);
  assert.equal(await verifyHeartbeat({ ...h, signature: "0xdeadbeef" }, ACCOUNT.address), false);
  assert.equal(await verifyHeartbeat({ ...h, signature: "0x" }, ACCOUNT.address), false);
});

test("uptime: no gaps when beats are close together", async () => {
  const beats = [await beat(0), await beat(1800), await beat(3600), await beat(5400)];
  const r = uptime(beats, { from: 0, to: 5400, outageAfterSecs: OUTAGE_AFTER_SECS });
  assert.equal(r.upPct, 100);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.lastBeatAt, 5400);
});

test("uptime: one gap longer than outageAfterSecs", async () => {
  // beats at 0, 1800, then 9000: the 7200 s gap (1800..9000) is down; 9000..10000 is short and up.
  const beats = [await beat(0), await beat(1800), await beat(9000)];
  const r = uptime(beats, { from: 0, to: 10000, outageAfterSecs: 3900 });
  assert.deepEqual(r.gaps, [{ from: 1800, to: 9000, secs: 7200 }]);
  assert.equal(r.upPct, 100 * (10000 - 7200) / 10000);
  assert.equal(r.lastBeatAt, 9000);
});

test("uptime: tail gap from the last beat to `to`", async () => {
  const beats = [await beat(0), await beat(1000)];
  const r = uptime(beats, { from: 0, to: 6000, outageAfterSecs: 3900 });
  assert.deepEqual(r.gaps, [{ from: 1000, to: 6000, secs: 5000 }]);
  assert.equal(r.upPct, 100 * 1000 / 6000);
  assert.equal(r.lastBeatAt, 1000);

  // a tail shorter than the threshold is not a gap
  const r2 = uptime(beats, { from: 0, to: 4000, outageAfterSecs: 3900 });
  assert.deepEqual(r2.gaps, []);
  assert.equal(r2.upPct, 100);
});

test("uptime: empty beats", () => {
  const long = uptime([], { from: 0, to: 10000, outageAfterSecs: 3900 });
  assert.equal(long.upPct, 0);
  assert.deepEqual(long.gaps, [{ from: 0, to: 10000, secs: 10000 }]);
  assert.equal(long.lastBeatAt, null);

  const short = uptime([], { from: 0, to: 1000, outageAfterSecs: 3900 });
  assert.equal(short.upPct, 100);
  assert.deepEqual(short.gaps, []);
});

test("outageProof: hash is stable and independent of key order", async () => {
  const lastBeat = await beat(1000);
  const p = outageProof(MACHINE, "policy-1", lastBeat, 6000);
  assert.equal(p.gapSecs, 5000);
  assert.equal(p.kind, "fiducia-outage-v1");

  // same fields, built in a different key order
  const reordered = {
    lastBeat: { address: lastBeat.address, signature: lastBeat.signature, sentAt: lastBeat.sentAt, machineId: lastBeat.machineId },
    gapSecs: 5000,
    detectedAt: 6000,
    policy: "policy-1",
    machineId: MACHINE,
    kind: "fiducia-outage-v1" as const,
  };
  assert.deepEqual(canonicalOutage(reordered), canonicalOutage(p));
  assert.equal(bytesToHex(outageHash(reordered)), bytesToHex(outageHash(p)));
  assert.equal(bytesToHex(outageHash(p)), bytesToHex(outageHash(outageProof(MACHINE, "policy-1", lastBeat, 6000))));
  assert.notEqual(bytesToHex(outageHash(p)), bytesToHex(outageHash(outageProof(MACHINE, "policy-2", lastBeat, 6000))));
});

test("verifyOutageProof: true for a real outage", async () => {
  const p = outageProof(MACHINE, "policy-1", await beat(1000), 6000);
  assert.equal(await verifyOutageProof(p, ACCOUNT.address, { outageAfterSecs: OUTAGE_AFTER_SECS, nowSecs: 7000 }), true);
});

test("verifyOutageProof: false cases", async () => {
  const lastBeat = await beat(1000);
  const opts = { outageAfterSecs: OUTAGE_AFTER_SECS, nowSecs: 7000 };
  const good = outageProof(MACHINE, "policy-1", lastBeat, 6000);

  // wrong pad address
  assert.equal(await verifyOutageProof(good, OTHER.address, opts), false);
  // gap not longer than the threshold (1000 + 3900 = 4900)
  assert.equal(await verifyOutageProof(outageProof(MACHINE, "policy-1", lastBeat, 4900), ACCOUNT.address, opts), false);
  // detected in the future
  assert.equal(await verifyOutageProof(outageProof(MACHINE, "policy-1", lastBeat, 8000), ACCOUNT.address, opts), false);
  // gapSecs does not match the beat
  assert.equal(await verifyOutageProof({ ...good, gapSecs: 1 }, ACCOUNT.address, opts), false);
  // beat from another machine
  assert.equal(await verifyOutageProof({ ...good, machineId: "348" }, ACCOUNT.address, opts), false);
  // tampered beat
  assert.equal(await verifyOutageProof({ ...good, lastBeat: { ...lastBeat, sentAt: 1001 } }, ACCOUNT.address, opts), false);
  // unknown kind
  assert.equal(await verifyOutageProof({ ...good, kind: "other" as "fiducia-outage-v1" }, ACCOUNT.address, opts), false);
});
