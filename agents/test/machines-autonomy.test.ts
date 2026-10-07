import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, afterCharge, decide, DEFAULT_ROBOT as M, type Battery, type MandateLeft } from "../src/machines/index.ts";

const open: MandateLeft = { perTxCap: 500_000n, cap: 5_000_000n, spent: 0n, live: true };
const at = (levelPct: number, updatedAt = 0): Battery => ({ levelPct, updatedAt });

test("default robot price is the pad's price", () => assert.equal(M.pricePerKwhMicro, 320_000n));

test("advance drains by the hour and clamps at 0", () => {
  assert.equal(advance(at(80), 3600, M).levelPct, 68);
  assert.equal(advance(at(80), 1800, M).levelPct, 74);
  assert.equal(advance(at(10), 10 * 3600, M).levelPct, 0);
  assert.equal(advance(at(80), 3600, M).updatedAt, 3600);
});

test("advance never moves time backwards", () => {
  const b = at(50, 1000);
  assert.equal(advance(b, 500, M), b);
  assert.equal(advance(b, 1000, M), b);
});

test("above the threshold the robot waits", () => {
  for (const l of [25, 64, 100]) {
    const d = decide(at(l), open, M);
    assert.equal(d.action, "wait");
  }
  assert.match((decide(at(64), open, M) as { reason: string }).reason, /battery 64%: no charge needed/);
});

test("below the threshold it charges to the target", () => {
  const d = decide(at(22), open, M);
  assert.equal(d.action, "charge");
  if (d.action !== "charge") return;
  assert.equal(d.kWh, "1.156"); // 1.160 kWh wanted; 0.3712 rounds down to 0.37 USDC, which buys 1.156
  assert.equal(d.amount, 370_000n); // 1.160 x 0.32 = 0.3712 -> 0.37
  assert.match(d.reason, /battery 22% < 25%: charging 1\.156 kWh to reach 80%/);
});

test("capped by the per-charge limit, kWh recomputed", () => {
  const d = decide(at(0), { ...open, perTxCap: 300_000n }, M);
  assert.equal(d.action, "charge");
  if (d.action !== "charge") return;
  assert.equal(d.amount, 300_000n);
  assert.equal(d.kWh, "0.937"); // 0.3 / 0.32 = 0.9375 rounded down
});

test("capped by what is left of the cap", () => {
  const d = decide(at(0), { ...open, spent: 4_880_000n }, M);
  assert.equal(d.action, "charge");
  if (d.action !== "charge") return;
  assert.equal(d.amount, 120_000n);
  assert.equal(d.kWh, "0.375");
});

test("amount is whole cents and kWh x price never exceeds it", () => {
  for (let l = 0; l < 25; l += 0.37) {
    for (const perTxCap of [10_000n, 123_456n, 300_000n, 500_000n, 777_777n]) {
      const d = decide(at(l), { ...open, perTxCap, spent: 1_234_567n }, M);
      if (d.action !== "charge") continue;
      assert.equal(d.amount % 10_000n, 0n);
      assert.ok(d.amount <= perTxCap);
      const [w, f = ""] = d.kWh.split(".");
      assert.equal(f.length, 3);
      assert.ok((BigInt(w!) * 1000n + BigInt(f)) * M.pricePerKwhMicro <= d.amount * 1000n);
    }
  }
});

test("a remainder under one cent waits", () => {
  assert.equal(decide(at(0), { ...open, spent: 4_995_000n }, M).action, "wait");
  assert.equal(decide(at(0), { ...open, spent: 5_000_000n }, M).action, "wait");
  assert.equal(decide(at(0), { ...open, cap: 1n, spent: 5n }, M).action, "wait"); // overspent: never negative
});

test("a mandate that is not live waits", () => {
  const d = decide(at(5), { ...open, live: false }, M);
  assert.equal(d.action, "wait");
});

test("afterCharge reaches the target", () => {
  const d = decide(at(22), open, M);
  assert.equal(d.action, "charge");
  if (d.action !== "charge") return;
  const b = afterCharge(at(22, 5), d.kWh, 99, M);
  assert.equal(b.updatedAt, 99);
  assert.ok(Math.abs(b.levelPct - 80) < 0.5 && b.levelPct <= 80);
  assert.equal(afterCharge(at(40), "1.000", 1, M).levelPct, 90);
  assert.equal(afterCharge(at(99), "2.000", 1, M).levelPct, 100);
  assert.equal(afterCharge(at(50), "junk", 1, M).levelPct, 50);
});

test("one week simulated: caps hold, whole cents, robot keeps charging", () => {
  const mandate = { perTxCap: 500_000n, cap: 5_000_000n, spent: 0n, live: true };
  let b = at(80, 0);
  let charges = 0;
  for (let t = 1800; t <= 7 * 24 * 3600; t += 1800) {
    b = advance(b, t, M);
    assert.ok(b.levelPct >= 0 && b.levelPct <= 100);
    const d = decide(b, mandate, M);
    if (d.action !== "charge") continue;
    assert.ok(d.amount <= mandate.perTxCap);
    assert.equal(d.amount % 10_000n, 0n);
    mandate.spent += d.amount;
    assert.ok(mandate.spent <= mandate.cap);
    b = afterCharge(b, d.kWh, t, M);
    charges++;
  }
  assert.ok(charges > 5);
  assert.ok(mandate.spent <= mandate.cap);
});
