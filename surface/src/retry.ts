// The public devnet RPC rate-limits per IP (a campus or office IP is shared by many people), so bursts
// of requests come back as HTTP 429. `withRetry` is for reads and other idempotent calls only: a 429 can
// arrive after a transaction already landed, so sends go through the desk's state-checking `send`.
// Anything else (a program error, a bad transaction) is never retried.

/** True when the error, or anything in its cause chain, is an HTTP 429 from the RPC. */
export function isRateLimited(e: unknown): boolean {
  for (let cur = e as { message?: unknown; context?: Record<string, unknown>; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    const ctx = cur.context ?? {};
    if (ctx.statusCode === 429) return true;
    const text = `${String(cur.message ?? "")} ${String(ctx.causeMessage ?? "")}`;
    if (/\b429\b|too many requests/i.test(text)) return true;
  }
  return false;
}

export type RetryOpts = { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> };

/** Run `fn`, retrying on HTTP 429 with exponential backoff (0.8s, 1.6s, 3.2s, ...). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const baseMs = opts.baseMs ?? 800;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isRateLimited(e)) throw e;
      const wait = baseMs * 2 ** (i - 1);
      console.warn(`rpc rate-limited (429), retry ${i}/${attempts - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
}
