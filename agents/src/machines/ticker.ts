// Machine ticker: POSTs the robot's tick to the mission service on an interval (#257).
// Uses only injectable dependencies; tested with a stub fetch, never makes real calls.

export type TickerOptions = {
  url: string;
  secret: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
};

export function machineTicker(o: TickerOptions): { tick(): Promise<void>; start(): () => void } {
  const { url, secret, intervalMs = 1_800_000, fetch: f = globalThis.fetch, log = () => {}, now = () => Date.now() } = o;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      log("machine tick skipped: previous tick still running");
      return;
    }
    running = true;
    try {
      const resp = await f(url, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(60_000),
      });

      const isoTime = new Date(now()).toISOString();
      let decision = "-";
      try {
        const body = (await resp.json()) as { decision?: { action?: unknown } };
        if (body.decision?.action !== undefined) {
          decision = String(body.decision.action);
        }
      } catch {
        // If the body is not valid JSON or doesn't have the expected shape, leave decision as "-".
      }
      log(`machine tick ${isoTime} HTTP ${resp.status} ${decision}`);
    } catch (err) {
      const errorName = (err instanceof Error) ? err.name : "Error";
      log(`machine tick failed: ${errorName}`);
    } finally {
      running = false;
    }
  };

  const start = (): (() => void) => {
    const id = setInterval(tick, intervalMs);
    if (id.unref) id.unref();
    return () => clearInterval(id);
  };

  return { tick, start };
}

export function tickerFromEnv(
  env: Record<string, string | undefined>,
  deps?: Partial<TickerOptions>,
): ReturnType<typeof machineTicker> | null {
  const url = env.MACHINE_TICK_URL;
  const secret = env.MACHINE_TICK_SECRET;
  const msStr = env.MACHINE_TICK_MS;

  // Both URL and secret are required.
  if (!url || !secret) return null;

  // Secret must be at least 32 characters.
  if (secret.length < 32) return null;

  // URL must be https or http://127.0.0.1.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1")) {
    return null;
  }

  // intervalMs must be >= 60_000 if provided.
  let intervalMs: number | undefined;
  if (msStr !== undefined) {
    const ms = Number(msStr);
    if (!Number.isInteger(ms) || ms < 60_000) return null;
    intervalMs = ms;
  }

  return machineTicker({
    url,
    secret,
    intervalMs,
    ...deps,
  });
}
