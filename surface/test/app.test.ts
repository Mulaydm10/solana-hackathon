// API tests with the chain mocked: the real program is tested in chain/test (LiteSVM).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Address } from "@solana/kit";
import { createApp } from "../src/app.ts";
import { SERVICES } from "../src/catalog.ts";
import { parseBudgetUsdc, parseDeadlineMins, ruleDraft } from "../src/draft.ts";
import type { Desk, LockInput } from "../src/desk.ts";
import type { DealView, Sent } from "@deal/chain";
import type { GuardConfig } from "../src/guard.ts";

const TOKEN = "test-token-0123456789";

const NOW = 1_800_000_000;
const BUYER = "Buyer1111111111111111111111111111111111111" as Address;
const sellerOf = (id: string) => `Seller${id}`.padEnd(43, "1") as Address;

/** In-memory stand-in for the chain: tracks deal status and refuses like the program would. */
function fakeDesk(refuseWith?: string) {
  const calls: { op: string; arg: unknown }[] = [];
  const state = new Map<string, { status: string; deliveryHash: string }>();
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  let n = 0;
  const step = (op: string, deal: Address, from: string[], to: string, arg: unknown = deal): Sent => {
    calls.push({ op, arg });
    if (refuseWith) return { ok: false, reason: refuseWith, message: "refused" };
    const d = state.get(deal);
    if (!d) return { ok: false, reason: "DEAL_NOT_FOUND", message: "no deal" };
    if (!from.includes(d.status)) return { ok: false, reason: "WrongStatus", message: "wrong status" };
    d.status = to;
    return { ok: true, signature: `sig${op}` };
  };
  const desk: Desk = {
    buyer: BUYER,
    verifier: "Verifier111111111111111111111111111111111111" as Address,
    sellerFor: (id) => (SERVICES.some((s) => s.id === id) ? sellerOf(id) : undefined),
    async lock(input: LockInput) {
      calls.push({ op: "lock", arg: input });
      if (refuseWith) return { ok: false, reason: refuseWith, message: "refused" };
      const deal = `Deal${++n}`.padEnd(43, "1") as Address;
      state.set(deal, { status: "Open", deliveryHash: "" });
      return { ok: true, signature: "siglock", deal };
    },
    accept: async (d) => step("accept", d, ["Open"], "Funded"),
    async deliver(d, hash, invoice) {
      const r = step("deliver", d, ["Funded"], "Delivered", { hash, invoice });
      if (r.ok) state.get(d)!.deliveryHash = hex(hash);
      return r;
    },
    async release(d, hash) {
      if (state.get(d) && state.get(d)!.deliveryHash !== hex(hash)) return { ok: false, reason: "DeliveryMismatch", message: "x" };
      return step("release", d, ["Delivered"], "Released");
    },
    challenge: async (d) => step("challenge", d, ["Delivered"], "Challenged"),
    resolve: async (d, ok) => step("resolve", d, ["Challenged"], ok ? "VerifiedPass" : "VerifiedFail", ok),
    timeoutRefund: async (d) => step("timeout", d, ["Challenged"], "NoVerdict"),
    refund: async (d) => step("refund", d, ["Open", "Funded"], "Refunded"),
    claim: async (d) => step("claim", d, ["Delivered"], "Claimed"),
    cancel: async (d) => step("cancel", d, ["Open"], "Cancelled"),
    async get(d) {
      const x = state.get(d);
      return x ? ({ address: d, status: x.status, deliveryHash: x.deliveryHash } as unknown as DealView) : null;
    },
    async status() {
      return { program: "Prog" as Address, programDeployed: true, buyerSol: 1, buyerTokens: "5", mint: "Mint" as Address, sellers: 5, verifier: "V" as Address, policy: null };
    },
  };
  return { desk, calls, state };
}

async function serve(desk: Desk, guard: Partial<GuardConfig> = {}) {
  const app = createApp({
    desk, draft: ruleDraft, produce: async (_s, task) => `done: ${task}`, services: SERVICES,
    decimals: 6, symbol: "USDC", defaultBudgetUsdc: 50, now: () => NOW,
    guard: { token: TOKEN, ...guard },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown = {}) =>
    (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  return { post, base, close: () => server.close() };
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

async function lockTranslation(s: Awaited<ReturnType<typeof serve>>) {
  const draft = await s.post("/api/draft", { request: "Translate a German contract to English in 2 hours under 10 USDC" });
  const lock = await s.post("/api/lock", { terms: draft.terms, budgetUsdc: draft.budgetUsdc });
  return { draft, lock, deal: lock.deal as string };
}

test("draft -> lock (stake/bond/tolerance shape) -> accept -> deliver -> hash-bound release", async () => {
  const { desk, calls } = fakeDesk();
  const s = await serve(desk);
  try {
    const { draft, lock, deal } = await lockTranslation(s);
    assert.equal(draft.service.id, "translate");
    assert.match(draft.summary, /You pay 2 USDC into escrow/);
    assert.equal(lock.ok, true, JSON.stringify(lock));
    const input = calls.find((c) => c.op === "lock")!.arg as LockInput;
    assert.deepEqual([input.price, input.stake, input.bondBps, input.toleranceBps], [2_000_000n, 200_000n, 1000, 500]);
    assert.equal(input.termsHash.length, 32);
    assert.equal((await s.post(`/api/deals/${deal}/accept`)).ok, true);
    const delivered = await s.post(`/api/deals/${deal}/deliver`);
    assert.equal(delivered.ok, true);
    assert.match(delivered.delivery, /^done: /);
    const { invoice } = calls.find((c) => c.op === "deliver")!.arg as { invoice: bigint };
    assert.equal(invoice, 2_000_000n);
    assert.equal((await s.post(`/api/deals/${deal}/release`)).ok, true);
    assert.equal((await s.post(`/api/deals/${deal}/release`)).reason, "WrongStatus");
  } finally {
    s.close();
  }
});

test("release before any delivery is refused", async () => {
  const s = await serve(fakeDesk().desk);
  try {
    const { deal } = await lockTranslation(s);
    assert.equal((await s.post(`/api/deals/${deal}/release`)).reason, "NO_DELIVERY");
  } finally {
    s.close();
  }
});

test("challenge + verifier: junk delivery fails, good delivery passes", async () => {
  for (const [quality, expected] of [["junk", "VerifiedFail"], ["good", "VerifiedPass"]] as const) {
    const { desk, state } = fakeDesk();
    const s = await serve(desk);
    try {
      const { deal } = await lockTranslation(s);
      await s.post(`/api/deals/${deal}/accept`);
      await s.post(`/api/deals/${deal}/deliver`, { quality });
      assert.equal((await s.post(`/api/deals/${deal}/verify`)).reason, "WrongStatus"); // not challenged yet
      assert.equal((await s.post(`/api/deals/${deal}/challenge`)).ok, true);
      const v = await s.post(`/api/deals/${deal}/verify`);
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.verdict.ok, quality === "good", JSON.stringify(v.verdict));
      assert.equal(state.get(deal)!.status, expected);
    } finally {
      s.close();
    }
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
  const s = await serve(fakeDesk().desk);
  try {
    const draft = await s.post("/api/draft", { request: "translate a page" });
    const lock = await s.post("/api/lock", { terms: { ...draft.terms, seller: sellerOf("design") } });
    assert.deepEqual([lock.ok, lock.reason], [false, "BAD_PARTIES"]);
  } finally {
    s.close();
  }
});

test("program refusals pass through as reason codes", async () => {
  const s = await serve(fakeDesk("OverMaxPrice").desk);
  try {
    const { lock } = await lockTranslation(s);
    assert.deepEqual([lock.ok, lock.reason], [false, "OverMaxPrice"]);
  } finally {
    s.close();
  }
});

test("status reports the live setup", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk);
  try {
    const r = await (await fetch(s.base + "/api/status")).json() as Record<string, any>;
    assert.deepEqual([r.ok, r.programDeployed, r.sellers, r.drafting], [true, true, 5, "rules"]);
  } finally {
    s.close();
  }
});

test("writes without the token are refused; reads stay open", async () => {
  const { desk, calls } = fakeDesk();
  const s = await serve(desk);
  try {
    const noAuth = await fetch(s.base + "/api/lock", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(s.base + "/api/lock", { method: "POST", headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(s.base + "/api/services")).status, 200);
    assert.equal(calls.length, 0);
  } finally {
    s.close();
  }
});

test("security headers are set", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk);
  try {
    const r = await fetch(s.base + "/");
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-powered-by"), null);
  } finally {
    s.close();
  }
});

test("per-client write rate limit", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk, { writesPerMinute: 2 });
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await s.post("/api/draft", { request: "translate a page" })).reason ?? "ok");
    assert.equal(codes[2], "RATE_LIMITED");
  } finally {
    s.close();
  }
});

test("hourly cap on new deals", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk, { locksPerHour: 1 });
  try {
    const draft = await s.post("/api/draft", { request: "translate a page" });
    const first = await s.post("/api/lock", { terms: draft.terms });
    const second = await s.post("/api/lock", { terms: draft.terms });
    assert.equal(first.ok, true);
    assert.equal(second.reason, "LOCK_LIMIT");
  } finally {
    s.close();
  }
});

test("malformed input is a JSON refusal, not a crash", async () => {
  const { desk } = fakeDesk();
  const s = await serve(desk);
  try {
    assert.equal((await s.post("/api/describe", { terms: { price: "x" } })).reason, "BAD_TERMS");
    const r = await fetch(s.base + "/api/lock", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    assert.equal((await r.json() as Record<string, unknown>).ok, false);
  } finally {
    s.close();
  }
});
