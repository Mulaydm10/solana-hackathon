import { test } from "node:test";
import assert from "node:assert/strict";
import { machineTicker, tickerFromEnv } from "../src/machines/ticker.ts";

test("machineTicker: POST with bearer authorization", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;

  const mockFetch = async (url: string, init?: RequestInit) => {
    requestUrl = url;
    requestInit = init;
    return new Response(JSON.stringify({ decision: { action: "charge" } }), { status: 200 });
  };

  const url = "https://example.com/api/machines/tick";
  const secret = "x".repeat(40);
  const ticker = machineTicker({ url, secret, fetch: mockFetch as typeof fetch });

  await ticker.tick();

  assert.equal(requestUrl, url);
  assert.equal(requestInit?.method, "POST");
  const headers = requestInit?.headers as Record<string, string> | undefined;
  assert.equal(headers?.["authorization"], `Bearer ${secret}`);
  assert.equal(headers?.["content-type"], "application/json");
  assert.equal(requestInit?.body, "{}");
});

test("machineTicker: logs status and decision", () => {
  const logs: string[] = [];
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ decision: { action: "charge" } }), { status: 202 });

  const now = () => new Date("2024-01-15T10:30:45.123Z").getTime();
  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    fetch: mockFetch,
    log: (line) => logs.push(line),
    now,
  });

  return ticker.tick().then(() => {
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^machine tick 2024-01-15T10:30:45\.123Z HTTP 202 charge$/);
  });
});

test("machineTicker: logs decision as - if absent", () => {
  const logs: string[] = [];
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    fetch: mockFetch,
    log: (line) => logs.push(line),
    now: () => new Date("2024-01-15T10:30:45.123Z").getTime(),
  });

  return ticker.tick().then(() => {
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^machine tick 2024-01-15T10:30:45\.123Z HTTP 200 -$/);
  });
});

test("machineTicker: never logs the secret", async () => {
  const logs: string[] = [];
  const secret = "this-is-my-super-secret-key-" + "x".repeat(11); // 40 chars
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ decision: { action: "wait" } }), { status: 200 });

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret,
    fetch: mockFetch,
    log: (line) => logs.push(line),
    now: () => new Date("2024-01-15T10:30:45.123Z").getTime(),
  });

  await ticker.tick();
  for (const log of logs) {
    assert(!log.includes(secret), `Secret found in log: ${log}`);
  }
});

test("machineTicker: skips overlapping tick", async () => {
  const logs: string[] = [];
  let callCount = 0;

  const mockFetch: typeof fetch = async () => {
    callCount++;
    // First call hangs a bit to simulate overlap.
    await new Promise((r) => setTimeout(r, 50));
    return new Response(JSON.stringify({ decision: { action: "charge" } }), { status: 200 });
  };

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    fetch: mockFetch,
    log: (line) => logs.push(line),
  });

  // Start first tick but don't await.
  const first = ticker.tick();
  // Immediately start second tick while first is still running.
  const second = ticker.tick();

  await Promise.all([first, second]);

  // First call succeeds, second is skipped.
  assert.equal(callCount, 1);
  // One success log and one skip log (skip happens synchronously before first completes).
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /^machine tick skipped: previous tick still running$/);
  assert.match(logs[1]!, /^machine tick .* HTTP 200 charge$/);
});

test("machineTicker: logs network errors by name", async () => {
  const logs: string[] = [];

  const mockFetch: typeof fetch = async () => {
    throw new TypeError("Network error");
  };

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    fetch: mockFetch,
    log: (line) => logs.push(line),
  });

  await ticker.tick();

  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^machine tick failed: TypeError$/);
});

test("machineTicker: network error does not throw", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("Network failure");
  };

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    fetch: mockFetch,
  });

  // Should not throw.
  await assert.doesNotReject(() => ticker.tick());
});

test("machineTicker: start() returns a stop function that clears the timer", () => {
  let tickCount = 0;

  const mockFetch: typeof fetch = async () => {
    tickCount++;
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const ticker = machineTicker({
    url: "https://example.com/tick",
    secret: "x".repeat(40),
    intervalMs: 10,
    fetch: mockFetch,
  });

  const stop = ticker.start();

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      stop();
      const countBefore = tickCount;
      // Give it some time to ensure no more ticks occur.
      setTimeout(() => {
        assert.equal(tickCount, countBefore, "Ticks continued after stop()");
        resolve();
      }, 30);
    }, 25);
  });
});

test("tickerFromEnv: returns null if MACHINE_TICK_URL is missing", () => {
  const ticker = tickerFromEnv({ MACHINE_TICK_SECRET: "x".repeat(40) });
  assert.equal(ticker, null);
});

test("tickerFromEnv: returns null if MACHINE_TICK_SECRET is missing", () => {
  const ticker = tickerFromEnv({ MACHINE_TICK_URL: "https://example.com/tick" });
  assert.equal(ticker, null);
});

test("tickerFromEnv: returns null if MACHINE_TICK_SECRET is too short", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(31),
  });
  assert.equal(ticker, null);
});

test("tickerFromEnv: accepts https URL", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
  });
  assert(ticker !== null);
});

test("tickerFromEnv: accepts http://127.0.0.1 for tests", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "http://127.0.0.1:3320/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
  });
  assert(ticker !== null);
});

test("tickerFromEnv: returns null for http with non-127.0.0.1 host", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "http://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
  });
  assert.equal(ticker, null);
});

test("tickerFromEnv: returns null for non-URL", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "not-a-url",
    MACHINE_TICK_SECRET: "x".repeat(40),
  });
  assert.equal(ticker, null);
});

test("tickerFromEnv: returns null if MACHINE_TICK_MS < 60000", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
    MACHINE_TICK_MS: "30000",
  });
  assert.equal(ticker, null);
});

test("tickerFromEnv: returns null if MACHINE_TICK_MS is not an integer", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
    MACHINE_TICK_MS: "60000.5",
  });
  assert.equal(ticker, null);
});

test("tickerFromEnv: accepts MACHINE_TICK_MS >= 60000", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
    MACHINE_TICK_MS: "120000",
  });
  assert(ticker !== null);
});

test("tickerFromEnv: uses default intervalMs if MACHINE_TICK_MS is not set", () => {
  const ticker = tickerFromEnv({
    MACHINE_TICK_URL: "https://example.com/tick",
    MACHINE_TICK_SECRET: "x".repeat(40),
  });
  assert(ticker !== null);
});

test("tickerFromEnv: merges deps into options", () => {
  const logs: string[] = [];
  const customFetch: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });

  const ticker = tickerFromEnv(
    {
      MACHINE_TICK_URL: "https://example.com/tick",
      MACHINE_TICK_SECRET: "x".repeat(40),
    },
    { log: (line) => logs.push(line), fetch: customFetch },
  );

  return ticker?.tick().then(() => {
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^machine tick .* HTTP 200 -$/);
  });
});

test("tickerFromEnv: uses the given log function on each tick", async () => {
  const logs: string[] = [];
  const customFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ decision: { action: "charge" } }), { status: 202 });

  const ticker = tickerFromEnv(
    {
      MACHINE_TICK_URL: "https://example.com/tick",
      MACHINE_TICK_SECRET: "x".repeat(40),
    },
    { log: (line) => logs.push(line), fetch: customFetch },
  );

  // Perform two ticks.
  await ticker?.tick();
  await ticker?.tick();

  // Both ticks should be logged.
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /^machine tick .* HTTP 202 charge$/);
  assert.match(logs[1]!, /^machine tick .* HTTP 202 charge$/);
});
