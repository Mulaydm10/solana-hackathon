// API tests with the chain mocked: the real program is tested in chain/test (LiteSVM).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Address } from "@solana/kit";
import { createApp } from "../src/app.ts";
import { SERVICES } from "../src/catalog.ts";
import { parseBudgetUsdc, parseDeadlineMins, ruleDraft } from "../src/draft.ts";
import type { Desk, LockInput } from "../src/desk.ts";

const NOW = 1_800_000_000;
const BUYER = "Buyer1111111111111111111111111111111111111" as Address;
const sellerOf = (id: string) => `Seller${id}`.padEnd(43, "1") as Address;

function fakeDesk(failWith?: number) {
  const calls: { op: string; arg: unknown }[] = [];
  const fail = () => {
    if (failWith !== undefined) throw Object.assign(new Error("tx failed"), { cause: { context: { code: failWith } } });
  };
  const desk: Desk = {
    buyer: BUYER,
    sellerFor: (id) => (SERVICES.some((s) => s.id === id) ? sellerOf(id) : undefined),
    async lock(input: LockInput) {
      calls.push({ op: "lock", arg: input });
      return { deal: "Deal1111111111111111111111111111111111111" as Address, signature: "sigLock" };
    },
    async deliver(deal, hash) { calls.push({ op: "deliver", arg: { deal, hash } }); return "sigDeliver"; },
    async release(deal) { fail(); calls.push({ op: "release", arg: deal }); return "sigRelease"; },
    async refund(deal) { fail(); calls.push({ op: "refund", arg: deal }); return "sigRefund"; },
    async claim(deal) { fail(); calls.push({ op: "claim", arg: deal }); return "sigClaim"; },
    async get() { return null; },
  };
  return { desk, calls };
}

async function serve(desk: Desk) {
  const app = createApp({
    desk, draft: ruleDraft, produce: async (_s, task) => `done: ${task}`, services: SERVICES,
    decimals: 6, symbol: "USDC", defaultBudgetUsdc: 50, now: () => NOW,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown = {}) =>
    (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  return { post, close: () => server.close() };
}

test("rule parser: deadline and budget", () => {
  assert.equal(parseDeadlineMins("translate this in 2 hours"), 120);
  assert.equal(parseDeadlineMins("by tomorrow"), 1440);
  assert.equal(parseDeadlineMins("within 5 minutes"), 5);
  assert.equal(parseDeadlineMins("whenever"), 60);
  assert.equal(parseBudgetUsdc("a report under 20 USDC"), 20);
  assert.equal(parseBudgetUsdc("no budget here"), null);
});

test("rule drafter picks the matching service", async () => {
  const d = await ruleDraft("Translate my contract from German to English", SERVICES);
  assert.equal(d.serviceId, "translate");
  const r = await ruleDraft("Market report on battery suppliers", SERVICES);
  assert.equal(r.serviceId, "research");
});

test("draft -> lock -> deliver -> release", async () => {
  const { desk, calls } = fakeDesk();
  const s = await serve(desk);
  try {
    const draft = await s.post("/api/draft", { request: "Translate a German contract to English in 2 hours under 10 USDC" });
    assert.equal(draft.ok, true);
    assert.equal(draft.service.id, "translate");
    assert.equal(draft.terms.price, "2000000");
    assert.equal(draft.terms.deadline, NOW + 7200);
    assert.match(draft.summary, /You pay 2 USDC into escrow/);

    const lock = await s.post("/api/lock", { terms: draft.terms, budgetUsdc: draft.budgetUsdc });
    assert.equal(lock.ok, true, JSON.stringify(lock));
    const input = calls.find((c) => c.op === "lock")!.arg as LockInput;
    assert.equal(input.price, 2_000_000n);
    assert.equal(input.termsHash.length, 32);

    const deliver = await s.post(`/api/deals/${lock.deal}/deliver`);
    assert.equal(deliver.ok, true);
    assert.match(deliver.delivery, /^done: /);
    const release = await s.post(`/api/deals/${lock.deal}/release`);
    assert.deepEqual([release.ok, release.signature], [true, "sigRelease"]);
  } finally {
    s.close();
  }
});

test("over-budget terms are refused before any money moves", async () => {
  const { desk, calls } = fakeDesk();
  const s = await serve(desk);
  try {
    const draft = await s.post("/api/draft", { request: "Market research report on battery suppliers under 10 USDC" });
    assert.equal(draft.service.id, "research"); // listed at 15 USDC
    const lock = await s.post("/api/lock", { terms: draft.terms, budgetUsdc: draft.budgetUsdc });
    assert.deepEqual([lock.ok, lock.reason], [false, "OVER_BUDGET"]);
    assert.equal(calls.length, 0);
  } finally {
    s.close();
  }
});

test("tampered seller is refused", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk);
  try {
    const draft = await s.post("/api/draft", { request: "translate a page" });
    const lock = await s.post("/api/lock", { terms: { ...draft.terms, seller: sellerOf("design") } });
    assert.deepEqual([lock.ok, lock.reason], [false, "BAD_PARTIES"]);
  } finally {
    s.close();
  }
});

test("program refusals come back as reason codes", async () => {
  const { desk } = fakeDesk(6006); // DeadlineNotReached
  const s = await serve(desk);
  try {
    const r = await s.post("/api/deals/Deal1111111111111111111111111111111111111/refund");
    assert.deepEqual([r.ok, r.reason], [false, "DeadlineNotReached"]);
  } finally {
    s.close();
  }
});
