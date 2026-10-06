// The deal tools against the real program in LiteSVM (chain lane's harness): listing -> buy -> release /
// challenge, refusals as values, and the hard rule that no tool can approve a stage or add a mandate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { generateKeyPairSigner } from "@solana/kit";
import { listings, type DealClient, type DealContext } from "@deal/chain";
import { setup, hash, USDC } from "../../chain/test/harness.ts";
import { loadConfig } from "../src/config.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { ToolContext, ToolResult } from "../src/tool.ts";

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const data = (r: ToolResult) => { assert.ok(r.ok, JSON.stringify(r)); return (r as { data: Record<string, unknown> }).data; };
const reason = (r: ToolResult) => (r.ok ? "OK" : r.reason);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function market() {
  const t = await setup();
  const assessor = await generateKeyPairSigner();
  t.client.svm.airdrop(assessor.address, 1_000_000_000n as never);
  await t.registerAssessors(assessor.address);
  const client: DealClient = {
    rpc: (t.client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { t.client.svm.expireBlockhash(); return (t.client as unknown as DealClient).sendTransaction(ixs); },
  };
  const dctx: DealContext = { client, mint: t.mint.address, sleep: async () => {} };
  const made = await listings.create(dctx, t.seller, { listingId: 1n, kind: "Data", price: 5n * USDC, contentHash: hash(20), metaHash: hash(21), assessor: assessor.address });
  const listing = (made as { listing: string }).listing;
  await listings.attest(dctx, assessor, listing as never, hash(20), hash(30));
  const base = loadConfig({});
  assert.ok(base.ok);
  const ctx = (signer = t.buyer as never, extra: object = {}): ToolContext => ({
    config: { ...base.config, mint: t.mint.address, verifier: t.verifier.address, siteUrl: "https://site.example", ...extra },
    chain: async () => ({ ctx: dctx, signer }),
  });
  return { t, dctx, listing, ctx };
}

test("get_listing: chain facts, attestation and the seller's scored reputation", async () => {
  const { listing, ctx } = await market();
  const d = data(await tool("get_listing").run({ listing }, ctx()));
  assert.equal(d.attested, true);
  assert.equal(d.buyable, true);
  assert.equal(d.price, String(5n * USDC));
  assert.match((d.reputation as { summary: string }).summary, /no score yet/);
  assert.equal(reason(await tool("get_listing").run({ listing: "nope" }, ctx())), "BAD_INPUT");
});

test("buy -> deal_status -> release: the escrow path an agent can take on its own", async () => {
  const { t, listing, ctx } = await market();
  const b = data(await tool("buy").run({ listing, delivery_hours: 2 }, ctx()));
  assert.equal(b.challengeable, true);
  const deal = b.deal as string;
  assert.equal(data(await tool("deal_status").run({ deal }, ctx())).status, "Open");
  await t.accept(deal as never);
  await t.deliver(deal as never, 5n * USDC, t.seller, hash(20));
  assert.equal(reason(await tool("release").run({ deal, delivery_hash: hex(hash(21)) }, ctx())), "DeliveryMismatch"); // must name what was delivered
  data(await tool("release").run({ deal, delivery_hash: hex(hash(20)) }, ctx()));
  assert.equal(data(await tool("deal_status").run({ deal }, ctx())).status, "Released");
});

test("challenge: inside the review window, the verifier decides", async () => {
  const { t, listing, ctx } = await market();
  const deal = data(await tool("buy").run({ listing }, ctx())).deal as string;
  await t.accept(deal as never);
  await t.deliver(deal as never, 5n * USDC, t.seller, hash(20));
  data(await tool("challenge").run({ deal }, ctx()));
  assert.equal(data(await tool("deal_status").run({ deal }, ctx())).status, "Challenged");
});

test("refusals are values: no signer, unknown listing, bad input", async () => {
  const { ctx } = await market();
  assert.equal(reason(await tool("buy").run({ listing: "x" }, ctx())), "BAD_INPUT");
  assert.equal(reason(await tool("buy").run({ listing: (await generateKeyPairSigner()).address }, ctx())), "NOT_FOUND");
  assert.equal(reason(await tool("buy").run({ listing: (await generateKeyPairSigner()).address }, ctx(null as never))), "NO_SIGNER");
  assert.equal(reason(await tool("setup_policy").run({ daily_budget_usdc: "1", max_price_usdc: "5" }, ctx())), "BAD_INPUT");
});

test("get_listing: not buyable once its assessor is delisted (the program would refuse)", async () => {
  const { t, listing, ctx } = await market();
  await t.registerAssessors((await generateKeyPairSigner()).address);
  const d = data(await tool("get_listing").run({ listing }, ctx()));
  assert.equal(d.attested, true);
  assert.equal(d.assessorRegistered, false);
  assert.equal(d.buyable, false);
});

test("setup_policy creates an agent's own spending policy", async () => {
  const { t, ctx } = await market();
  const agent = await generateKeyPairSigner();
  t.client.svm.airdrop(agent.address, 1_000_000_000n as never);
  const d = data(await tool("setup_policy").run({ daily_budget_usdc: "100", max_price_usdc: "25.5" }, ctx(agent as never)));
  assert.equal(d.maxPrice, "25500000");
});

test("hire_team only returns a link for the human; find_listings asks the site", async () => {
  const { ctx } = await market();
  const team = (await generateKeyPairSigner()).address;
  const h = data(await tool("hire_team").run({ team, goal: "Plan a week in Bali", budget_usdc: "10" }, ctx()));
  assert.match(h.approvalUrl as string, /^https:\/\/site\.example\/hire\?team=\w+&goal=Plan\+a\+week\+in\+Bali&budget=10$/);
  assert.equal(reason(await tool("hire_team").run({ team, goal: "Plan", budget_usdc: "10" }, ctx(undefined, { siteUrl: null }))), "NOT_CONFIGURED");
  const seen: string[] = [];
  const fake = (async (u: URL) => { seen.push(u.toString()); return new Response(JSON.stringify({ listings: [{ address: "a" }] })); }) as unknown as typeof fetch;
  const f = data(await tool("find_listings").run({ query: "power prices", kind: "Data", max_price_usdc: "5" }, { ...ctx(), fetch: fake }));
  assert.deepEqual(f.listings, [{ address: "a" }]);
  assert.match(seen[0]!, /\/api\/catalogue\?q=power\+prices&kind=Data&maxPrice=5000000$/);
});

test("hard rule: nothing in the package's source can approve a stage gate or add a mandate (the human does, in their wallet)", () => {
  const banned = /approveStage|ApproveStage|addMandate|AddMandate|approve_stage|add_mandate/;
  const strip = (src: string) => src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
  for (const f of walk(new URL("../src/", import.meta.url))) assert.ok(!banned.test(strip(readFileSync(f, "utf8"))), `${f.pathname} reaches for an approval or mandate instruction`);
});

test("my_wallet: the agent's own address, balances and policy, and what to do next", async () => {
  const { t, ctx } = await market();
  const before = data(await tool("my_wallet").run({}, ctx()));
  assert.equal(before.address, t.buyer.address);
  assert.ok(Number(before.usdc) > 0);
  assert.equal(before.policy === null ? "setup_policy" : "find_listings", before.next);
  assert.equal(reason(await tool("my_wallet").run({}, ctx(null as never))), "NO_SIGNER");
});

test("get_test_funds: devnet only, airdrop plus the site's faucet, refusals as values", async () => {
  const { t, ctx } = await market();
  const calls: string[] = [];
  const site = (async (u: URL, init?: RequestInit) => {
    calls.push(`${u.pathname} ${String(init?.body)}`);
    return Response.json({ ok: true, amount: "20000000", signature: "sig" });
  }) as unknown as typeof fetch;
  const d = data(await tool("get_test_funds").run({}, { ...ctx(), fetch: site }));
  assert.deepEqual(d.usdc, { ok: true, amount: "20", signature: "sig" });
  assert.deepEqual(calls, [`/api/faucet ${JSON.stringify({ wallet: t.buyer.address })}`]);
  const limited = (async () => Response.json({ ok: false, reason: "WALLET_LIMIT", message: "later" }, { status: 429 })) as unknown as typeof fetch;
  // The harness RPC has no airdrop, so with the faucet also refusing nothing arrives: one refusal naming both.
  const none = await tool("get_test_funds").run({}, { ...ctx(), fetch: limited });
  assert.equal(reason(none), "NO_FUNDS");
  assert.match((none as { message: string }).message, /later/);
  assert.equal(reason(await tool("get_test_funds").run({}, ctx(t.buyer as never, { cluster: "localnet" }))), "UNSUPPORTED");
});

test("mission_status: the chain's facts plus the team's progress from the site (read-only)", async () => {
  const { t, dctx, ctx } = await market();
  const { missions, findMissionPda } = await import("@deal/chain");
  const now = BigInt(t.client.svm.getClock().unixTimestamp);
  const made = await missions.create(dctx, t.buyer, {
    missionId: 77n, budget: 1n * USDC, termsHash: hash(40), stageCaps: [1n * USDC], expiresAt: now + 3_600n, verifier: t.verifier.address,
  });
  assert.ok(made.ok, JSON.stringify(made));
  const [mission] = await findMissionPda({ buyer: t.buyer.address, missionId: 77n });
  const asked: string[] = [];
  const site = (async (u: URL) => {
    asked.push(u.pathname);
    return Response.json({ ok: true, state: "running", events: [{ type: "plan", stage: 0 }] });
  }) as unknown as typeof fetch;
  const d = data(await tool("mission_status").run({ mission }, { ...ctx(), fetch: site }));
  assert.equal(d.budget, String(1n * USDC));
  assert.deepEqual(asked, [`/api/missions/${mission}`]);
  assert.equal((d.team as { waitingForApproval: number }).waitingForApproval, 0);
  const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.deepEqual(data(await tool("mission_status").run({ mission }, { ...ctx(), fetch: down })).team, { unavailable: "the marketplace site did not answer" });
});

test("the model key never appears in any tool result (#183): every tool, with a fake key in the environment", async () => {
  const FAKE = "sk-ant-FAKE-KEY-" + "x9Q".repeat(16);
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE;
  try {
    const { listing, ctx } = await market();
    // A site stub that answers every route the tools call (catalogue, demand, listings, missions, faucet).
    const site = (async (u: URL) => Response.json({
      ok: true, listings: [{ address: listing, kind: "Data", price: "5000000", attested: true }], groups: [], meta: null,
      state: "running", events: [{ type: "plan", stage: 0 }, { type: "result", role: "researcher", output: "notes" }], amount: "20000000", signature: "sig",
      path: u.pathname,
    })) as unknown as typeof fetch;
    const c = { ...ctx(), fetch: site };
    const results: unknown[] = [];
    const bought = await tool("buy").run({ listing }, c);
    results.push(bought);
    const deal = bought.ok ? (bought.data.deal as string) : listing;
    const calls: [string, Record<string, unknown>][] = [
      ["program_info", {}], ["my_wallet", {}], ["get_test_funds", {}], ["find_listings", { query: "x" }], ["get_listing", { listing }],
      ["setup_policy", { daily_budget_usdc: "10", max_price_usdc: "5" }], ["deal_status", { deal }], ["release", { deal, delivery_hash: "00".repeat(32) }],
      ["challenge", { deal }], ["hire_team", { team: listing, goal: "3 days in Lisbon", budget_usdc: "5" }], ["mission_status", { mission: listing }],
      ["demand_board", {}], ["my_listings", {}], ["draft_listing", { text: "a,b\n1,2\n", name: "n", description: "d", category: "c" }],
      ["publish_listing", { text: "a,b\n1,2\n", name: "n", description: "d", category: "c", price_usdc: "1" }],
      ["call_service", { listing, body: {} }], ["machine_status", {}],
    ];
    // A thrown error is what the server would turn into INTERNAL; its message is checked for the key too.
    for (const [name, args] of calls) results.push(await tool(name).run(args as never, c).catch((e: Error) => ({ thrown: name, message: e.message, stack: e.stack })));
    // Every registered tool was exercised.
    assert.deepEqual(new Set([...calls.map(([n]) => n), "buy"]), new Set(TOOLS.map((t) => t.name)));
    const text = JSON.stringify(results);
    assert.ok(!text.includes(FAKE) && !text.includes("x9Qx9Q"), "a tool result contains the model key");
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});
