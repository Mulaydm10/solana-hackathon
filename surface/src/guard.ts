// Guards for the demo API. The server holds devnet keys and pays every fee, so an open write
// endpoint lets anyone on the network open deals (draining SOL in rent) or move escrowed funds.
// Writes therefore need a bearer token, are rate-limited per client, and deal opening is capped
// per hour. Refusals are JSON with a reason code, like every other refusal in this API.
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type GuardConfig = {
  /** Bearer token required on every non-GET /api request. */
  token: string;
  /** Writes per client per minute. Default 60. */
  writesPerMinute?: number;
  /** Deals opened per hour across all clients (wallet-drain guard). Default 30. */
  locksPerHour?: number;
  now?: () => number;
};

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Fixed-window counter: at most `limit` hits per key per `windowMs`. */
export function windowCounter(limit: number, windowMs: number, now: () => number) {
  const hits = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/** Middleware for /api: GETs pass; writes need the token and stay under the rate limits. */
export function guardWrites(cfg: GuardConfig) {
  const now = cfg.now ?? (() => Date.now());
  const perClient = windowCounter(cfg.writesPerMinute ?? 60, 60_000, now);
  const locks = windowCounter(cfg.locksPerHour ?? 30, 3_600_000, now);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const auth = req.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!given || !sameToken(given, cfg.token)) {
      return res.status(401).json({ ok: false, reason: "UNAUTHORIZED", message: "Write requests need the demo token." });
    }
    if (!perClient(req.ip ?? "unknown")) {
      return res.status(429).json({ ok: false, reason: "RATE_LIMITED", message: "Too many requests; slow down." });
    }
    if (req.path === "/lock" && !locks("all")) {
      return res.status(429).json({ ok: false, reason: "LOCK_LIMIT", message: "Hourly cap on new deals reached." });
    }
    next();
  };
}
