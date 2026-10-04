// #131: a devnet RPC hiccup must not turn the catalogue into a raw 500. Reads are retried, the last good list is
// served if the RPC stays down, and with nothing to serve the caller gets RegistryUnavailable (a 503 from the API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURES, fixtureRegistry, type Registry } from "../lib/registry.ts";
import { RegistryUnavailable, registryNote, resilientRegistry } from "../lib/site-registry.ts";

const noSleep = { sleep: async () => {} };

function flaky(failures: number): Registry & { calls: number } {
  const inner = fixtureRegistry();
  const r = {
    calls: 0,
    async list() {
      r.calls++;
      if (failures-- > 0) throw new Error("HTTP error (429): Too Many Requests");
      return inner.list();
    },
    async get(address: string) {
      r.calls++;
      if (failures-- > 0) throw new Error("fetch failed");
      return inner.get(address);
    },
  };
  return r;
}

test("a read that fails and then succeeds is retried, not surfaced", async () => {
  const inner = flaky(2);
  const reg = resilientRegistry(inner, { attempts: 3, ...noSleep });
  assert.equal((await reg.list()).length, (await fixtureRegistry().list()).length);
  assert.equal(inner.calls, 3);
});

test("with the RPC down and no good read yet: RegistryUnavailable, never a raw RPC error", async () => {
  const reg = resilientRegistry(flaky(Infinity), { attempts: 2, ...noSleep });
  await assert.rejects(reg.list(), RegistryUnavailable);
  await assert.rejects(reg.get(FIXTURES[0]!.address), RegistryUnavailable);
});

test("after a good read, an outage serves the last good list (and get from it)", async () => {
  let down = false;
  const inner = fixtureRegistry();
  const reg = resilientRegistry({
    list: async () => { if (down) throw new Error("fetch failed"); return inner.list(); },
    get: async (a) => { if (down) throw new Error("fetch failed"); return inner.get(a); },
  }, { attempts: 2, ...noSleep });
  const before = await reg.list();
  down = true;
  assert.deepEqual(await reg.list(), before);
  assert.equal((await reg.get(before[0]!.address))?.address, before[0]!.address);
  assert.equal(await reg.get("Nope1111111111111111111111111111111111111111"), null);
});

test("/api/catalogue answers 503 REGISTRY_UNAVAILABLE (JSON, retry-after) when the chain registry cannot be read", async () => {
  process.env.DEAL_REGISTRY = "chain";
  process.env.DEAL_RPC_URL = "http://127.0.0.1:9"; // nothing listens: every read fails
  const { GET } = await import("../app/api/catalogue/route.ts");
  const r = await GET(new Request("http://site.test/api/catalogue?q=power"));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "5");
  assert.equal(((await r.json()) as { reason: string }).reason, "REGISTRY_UNAVAILABLE");
});

test("#132: only demo mode calls the listings demo data", () => {
  const before = process.env.DEAL_REGISTRY;
  try {
    process.env.DEAL_REGISTRY = "chain";
    assert.doesNotMatch(registryNote(), /demo/);
    delete process.env.DEAL_REGISTRY;
    assert.match(registryNote(), /demo data until the registry is on chain/);
  } finally {
    if (before === undefined) delete process.env.DEAL_REGISTRY;
    else process.env.DEAL_REGISTRY = before;
  }
});
