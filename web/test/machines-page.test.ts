// The /machines v2 page (#274), rendered to static markup from the v2 fixture and from a v1 (not configured) status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MachinesView } from "../app/machines/machines-view";
import type { MachineStatus } from "../lib/machines-status";

const v2 = JSON.parse(readFileSync(new URL("./fixtures/machines-status-v2.json", import.meta.url), "utf8")) as MachineStatus;
const render = (s: MachineStatus) => renderToStaticMarkup(createElement(MachinesView, { initial: s }));
const v1 = (): MachineStatus => {
  const { network: _n, scores: _s, insurance: _i, earnings: _e, ...rest } = structuredClone(v2);
  rest.decisions = rest.decisions.map(({ chosenPad: _a, choiceReason: _b, choiceBy: _c, ...d }) => d);
  return { ...rest, v2: { configured: false, missing: ["PAD2_KEY"] } } as unknown as MachineStatus;
};

test("v2 page: sections, testids, honesty labels", () => {
  const h = render(v2);
  for (const id of ["network", "pad-pad", "pad-pad2", "pad-pad3", "insurance", "earnings", "choice-reason"]) assert.ok(h.includes(`data-testid="${id}"`), id);
  assert.equal(h.split('data-testid="policy"').length - 1, 2);
  assert.ok(h.includes("MCR-style score, computed by Fiducia from peaq events (peaq&#x27;s own rating is not served on testnet)"));
  assert.ok(h.includes("simulated"));
  assert.ok(h.includes("AA · score 88") && h.includes("offline (simulated)") && h.includes("0.28 USDC per kWh"));
  assert.ok(!/mainnet/i.test(h));
  assert.ok(!h.includes("the robot&#x27;s rule"));
});

test("v2 page: links are built from signatures, peaq events from explorerTx", () => {
  const h = render(v2);
  assert.ok(h.includes('href="https://explorer.solana.com/tx/sample-premium?cluster=devnet"'));
  assert.ok(h.includes('href="https://explorer.solana.com/tx/sample-claim?cluster=devnet"'));
  assert.ok(h.includes('href="https://explorer.solana.com/tx/sample-refund?cluster=devnet"'));
  assert.ok(h.includes('href="https://agung-testnet.subscan.io/tx/0xsampleoutage"'));
  assert.ok(h.includes('href="https://explorer.solana.com/tx/sample-job-release?cluster=devnet"'));
  assert.ok(h.includes("insurer&#x27;s check of the outage proof: valid"));
});

test("v2 page: each charge says which pad it chose, why and who decided", () => {
  const h = render(v2);
  assert.ok(h.includes("Chose Charging pad B because lowest effective price"));
  assert.ok(h.includes("decided by the robot"));
});

test("v1 status: v1 page plus one not-configured line, no v2 sections", () => {
  const h = render(v1());
  assert.ok(h.includes('data-testid="v2-not-configured"') && h.includes("not configured"));
  for (const id of ["network", "insurance", "earnings", "choice-reason"]) assert.ok(!h.includes(`data-testid="${id}"`), id);
  assert.ok(h.includes('data-testid="machine-rules"') && h.includes('data-testid="charge"'));
  assert.ok(!/mainnet/i.test(h));
});
