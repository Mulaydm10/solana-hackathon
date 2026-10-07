// #245: an API key in DEAL_RPC_URL (query string or URL credentials) never appears in any tool's result or error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { TOOLS } from "../src/tools/index.ts";
import { loadConfig } from "../src/config.ts";
import { shownRpcUrl } from "../src/tools/program_info.ts";

const KEY = `canary-${randomBytes(12).toString("hex")}`;
const PW = `pw-${randomBytes(8).toString("hex")}`;

test("program_info shows scheme, host and path only", async () => {
  assert.equal(shownRpcUrl(`https://devnet.helius-rpc.com/?api-key=${KEY}`), "https://devnet.helius-rpc.com (query/credentials hidden)");
  assert.equal(shownRpcUrl(`https://user:${PW}@rpc.example.com/v1`), "https://rpc.example.com/v1 (query/credentials hidden)");
  assert.equal(shownRpcUrl("https://api.devnet.solana.com"), "https://api.devnet.solana.com");
  assert.equal(shownRpcUrl("nonsense"), "(not a URL)");
});

test("no tool result or error carries the RPC URL's key (offline: tools without a chain refuse)", async () => {
  for (const url of [`https://devnet.helius-rpc.com/?api-key=${KEY}`, `https://u:${PW}@rpc.example.com/x?token=${KEY}`]) {
    const cfg = loadConfig({ DEAL_RPC_URL: url, DEAL_SITE_URL: "https://site.example" });
    assert.ok(cfg.ok, JSON.stringify(cfg));
    const site = (async () => Response.json({ ok: true, listings: [], groups: [], meta: null, events: [] })) as unknown as typeof fetch;
    for (const t of TOOLS) {
      const r = await t.run({} as never, { config: cfg.config, fetch: site }).catch((e: Error) => ({ thrown: e.message, stack: e.stack }));
      const text = JSON.stringify(r);
      assert.ok(!text.includes(KEY) && !text.includes(PW), `${t.name} leaked the RPC key`);
    }
  }
});
