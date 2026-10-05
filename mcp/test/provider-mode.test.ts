// mission_status names which workers ran the team (providerMode) as its own field, read from the mission service's
// aiProvider: simulated / anthropic / deterministic, never guessed from the team's text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missions, findMissionPda, type DealClient, type DealContext } from "@deal/chain";
import { setup, hash, USDC } from "../../chain/test/harness.ts";
import { loadConfig } from "../src/config.ts";
import { TOOLS } from "../src/tools/index.ts";
import { providerMode } from "../src/progress.ts";
import type { ToolContext, ToolResult } from "../src/tool.ts";

const tool = TOOLS.find((t) => t.name === "mission_status")!;
const data = (r: ToolResult) => { assert.ok(r.ok, JSON.stringify(r)); return (r as { data: Record<string, unknown> }).data; };

test("providerMode: the service's aiProvider mapped to simulated / anthropic / deterministic", () => {
  assert.equal(providerMode({ ok: true, aiProvider: "simulated" }), "simulated");
  assert.equal(providerMode({ ok: true, aiProvider: "anthropic" }), "anthropic");
  assert.equal(providerMode({ ok: true, aiProvider: "none" }), "deterministic");
  assert.equal(providerMode({ ok: true }), "deterministic"); // a service from before aiProvider existed ran scripted workers
  assert.equal(providerMode({ ok: true, aiProvider: "Claude, trust me" }), "unknown");
  assert.equal(providerMode({ ok: true, aiProvider: { mode: "anthropic" } }), "unknown");
  assert.equal(providerMode({ ok: false, aiProvider: "simulated" }), null);
  assert.equal(providerMode(null), null);
});

test("mission_status: providerMode is its own field beside the chain facts and the team's progress", async () => {
  const t = await setup();
  const client: DealClient = {
    rpc: (t.client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { t.client.svm.expireBlockhash(); return (t.client as unknown as DealClient).sendTransaction(ixs); },
  };
  const dctx: DealContext = { client, mint: t.mint.address, sleep: async () => {} };
  const now = BigInt(t.client.svm.getClock().unixTimestamp);
  const made = await missions.create(dctx, t.buyer, {
    missionId: 78n, budget: 1n * USDC, termsHash: hash(41), stageCaps: [1n * USDC], expiresAt: now + 3_600n, verifier: t.verifier.address,
  });
  assert.ok(made.ok, JSON.stringify(made));
  const [mission] = await findMissionPda({ buyer: t.buyer.address, missionId: 78n });
  const base = loadConfig({});
  assert.ok(base.ok);
  const ctx = (fetch: typeof globalThis.fetch | undefined, siteUrl: string | null = "https://site.example"): ToolContext => ({
    config: { ...base.config, mint: t.mint.address, verifier: t.verifier.address, siteUrl },
    chain: async () => ({ ctx: dctx, signer: t.buyer as never }),
    fetch,
  });
  const site = (aiProvider?: string) => (async () => Response.json({ ok: true, state: "running", events: [], ...(aiProvider ? { aiProvider } : {}) })) as unknown as typeof fetch;

  for (const [served, mode] of [["simulated", "simulated"], ["anthropic", "anthropic"], ["none", "deterministic"], [undefined, "deterministic"]] as const) {
    const d = data(await tool.run({ mission }, ctx(site(served))));
    assert.equal(d.providerMode, mode, `aiProvider ${served}`);
    assert.equal(d.budget, String(1n * USDC));
    assert.equal((d.team as { state: string }).state, "running");
  }
  const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal(data(await tool.run({ mission }, ctx(down))).providerMode, null);
  const refused = (async () => Response.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  assert.equal(data(await tool.run({ mission }, ctx(refused))).providerMode, null);
  const noSite = data(await tool.run({ mission }, ctx(undefined, null)));
  assert.equal(noSite.providerMode, null);
  assert.equal(noSite.team, null);
});
