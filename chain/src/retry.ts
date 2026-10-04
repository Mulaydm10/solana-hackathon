// Transient RPC failures: the request may or may not have reached the chain, and trying again
// later can succeed. The public devnet RPC rate-limits per IP (campus/office IPs are shared), and
// networks blip. Browser-safe: no Node built-ins.

type ErrLike = { message?: unknown; code?: unknown; context?: Record<string, unknown>; cause?: unknown };

function* chain(e: unknown): Generator<ErrLike> {
  for (let cur = e as ErrLike | undefined, i = 0; cur && i < 12; cur = cur.cause as ErrLike, i++) yield cur;
}

/** True when the error, or anything in its cause chain, is an HTTP 429 from the RPC. */
export function isRateLimited(e: unknown): boolean {
  for (const cur of chain(e)) {
    const ctx = cur.context ?? {};
    if (ctx.statusCode === 429) return true;
    if (/\b429\b|too many requests/i.test(`${String(cur.message ?? "")} ${String(ctx.causeMessage ?? "")}`)) return true;
  }
  return false;
}

const TRANSIENT =
  /\b429\b|too many requests|HTTP error \(5\d\d\)|\b50[0234]\b|fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|blockhash not found|block height exceeded|node is behind|service unavailable|gateway|websocket|subscription|connection closed/i;

/**
 * True for failures worth retrying after checking chain state: rate limits, network errors,
 * HTTP 5xx, expired/unknown blockhash, lagging nodes. Program errors are never transient.
 */
export function isTransient(e: unknown): boolean {
  for (const cur of chain(e)) {
    const ctx = cur.context ?? {};
    if (typeof ctx.statusCode === "number" && (ctx.statusCode === 429 || ctx.statusCode >= 500)) return true;
    const text = `${String(cur.message ?? "")} ${String(ctx.causeMessage ?? "")} ${String(cur.code ?? "")}`;
    if (TRANSIENT.test(text)) return true;
  }
  return false;
}
