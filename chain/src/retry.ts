// The public devnet RPC rate-limits per IP (campus and office IPs are shared), so bursts come back
// as HTTP 429. Browser-safe: no Node built-ins.

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
