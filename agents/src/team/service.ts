/**
 * Mission service: the long-running half of a hired team (PLAN §6.1). Vercel functions cannot run workers
 * for minutes, so the site's API routes talk to this service on a long-running host (the Omen or the Mac).
 *
 *   POST /missions/prepare        { blueprint, goal, budget, missionId, buyer, expiresAt }  -> what the buyer signs
 *   POST /missions/:mission/start -> begins runStages (waits for the buyer's on-chain approvals itself)
 *   GET  /missions/:mission       -> status and events so far
 *
 * The service holds the agents' keypairs (agents hold none) and never the buyer's key: the buyer signs
 * create_mission, the mandates and every approve_stage in its own wallet. Requests need the bearer token
 * (the site's server routes hold it; browsers never see it). Bodies are size-limited JSON; bigints are strings.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Address } from "@solana/kit";
import type { DealContext } from "@deal/chain";
import type { Broker } from "../broker/broker.ts";
import { prepareMission, runStages, type MissionEvent, type PreparedMission } from "./orchestrator.ts";

export type ServiceOptions = {
  ctx: DealContext;
  broker: Broker;
  /** `provider:action` ids the broker offers. */
  capabilities: readonly string[];
  workers: Record<string, string>;
  workerEnv?: Record<string, Record<string, string>>;
  live: (mission: string, agent: string) => Promise<boolean>;
  dealRules: { verifier: Address; minReviewSecs?: bigint; minResolveSecs?: bigint; maxToleranceBps?: number };
  /** Bearer token the site's server routes send. */
  token: string;
  pollMs?: number;
  runner?: { mode?: "process" | "container"; pollMs?: number; maxSecs?: number };
};

type Entry = { prepared: PreparedMission; events: MissionEvent[]; state: "prepared" | "running" | "done" | "failed" };

const MAX_BODY = 64 * 1024;
const big = (k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v);
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, big));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("TOO_LARGE");
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

/** The prepared mission as the browser needs it: no keypairs, only addresses, hashes and plans. */
export function publicView(p: PreparedMission) {
  return {
    mission: p.mission, buyer: p.buyer, missionId: p.missionId, goal: p.goal, budget: p.budget, expiresAt: p.expiresAt,
    terms: p.terms, digest: p.digest, createParams: p.createParams,
    roles: p.roles.map((r) => ({ role: r.role, agent: r.agent.address, mandate: r.mandate })),
    plans: p.plans,
  };
}

export function createMissionService(o: ServiceOptions): Server {
  const missions = new Map<string, Entry>();
  const tokenOk = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    const want = Buffer.from(o.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  return createServer(async (req, res) => {
    try {
      if (!tokenOk(req)) return json(res, 401, { ok: false, reason: "UNAUTHORIZED" });
      const url = new URL(req.url ?? "/", "http://service");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "POST" && parts.join("/") === "missions/prepare") {
        const b = (await readBody(req)) as Record<string, unknown>;
        const toBig = (v: unknown) => (typeof v === "string" && /^\d{1,20}$/.test(v) ? BigInt(v) : null);
        const budget = toBig(b.budget), missionId = toBig(b.missionId), expiresAt = toBig(b.expiresAt);
        if (budget === null || missionId === null || expiresAt === null || typeof b.goal !== "string" || typeof b.buyer !== "string") {
          return json(res, 400, { ok: false, reason: "BAD_REQUEST" });
        }
        const r = await prepareMission({
          blueprint: reviveBlueprint(b.blueprint), goal: b.goal, budget, missionId, expiresAt, capabilities: o.capabilities,
          dealRules: o.dealRules, buyer: b.buyer as Address,
        });
        if (!r.ok) return json(res, 422, r);
        // One entry per mission, never replaced: a second prepare would swap in new agent keys that match no
        // mandate the buyer signed, and reset a running mission so it could be started twice.
        if (missions.has(r.value.mission)) return json(res, 409, { ok: false, reason: "MISSION_EXISTS" });
        missions.set(r.value.mission, { prepared: r.value, events: [], state: "prepared" });
        return json(res, 200, { ok: true, ...publicView(r.value) });
      }

      const mission = parts[1];
      const entry = mission ? missions.get(mission) : undefined;
      if (parts[0] !== "missions" || !mission) return json(res, 404, { ok: false, reason: "NOT_FOUND" });
      if (!entry) return json(res, 404, { ok: false, reason: "UNKNOWN_MISSION" });

      if (req.method === "POST" && parts[2] === "start") {
        if (entry.state !== "prepared") return json(res, 409, { ok: false, reason: "ALREADY_STARTED" });
        entry.state = "running";
        void (async () => {
          try {
            for await (const e of runStages({
              ctx: o.ctx, prepared: entry.prepared, broker: o.broker, workers: o.workers, workerEnv: o.workerEnv, live: o.live,
              pollMs: o.pollMs, runner: o.runner, approvalTimeoutMs: Number(entry.prepared.expiresAt) * 1000 - Date.now(),
            })) entry.events.push(e);
            entry.state = entry.events.at(-1)?.type === "delivered" ? "done" : "failed";
          } catch (e) {
            entry.events.push({ type: "failed", reason: "INTERNAL", message: e instanceof Error ? e.message : String(e) });
            entry.state = "failed";
          }
        })();
        return json(res, 202, { ok: true, state: entry.state });
      }

      if (req.method === "GET" && parts.length === 2) {
        return json(res, 200, { ok: true, state: entry.state, events: entry.events, ...publicView(entry.prepared) });
      }
      return json(res, 404, { ok: false, reason: "NOT_FOUND" });
    } catch (e) {
      return json(res, (e as Error).message === "TOO_LARGE" ? 413 : 400, { ok: false, reason: "BAD_REQUEST" });
    }
  });
}

/** Blueprints travel as JSON with amounts as decimal strings; validateBlueprint (in prepare) checks the rest. */
export function reviveBlueprint(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const amt = (x: unknown) => (typeof x === "string" && /^\d{1,20}$/.test(x) ? BigInt(x) : x);
  return {
    ...o,
    roles: Array.isArray(o.roles) ? o.roles.map((r) => (r && typeof r === "object" ? { ...(r as object), cap: amt((r as Record<string, unknown>).cap), perTxCap: amt((r as Record<string, unknown>).perTxCap) } : r)) : o.roles,
    stages: Array.isArray(o.stages) ? o.stages.map((st) => (st && typeof st === "object" ? { ...(st as object), cap: amt((st as Record<string, unknown>).cap) } : st)) : o.stages,
  };
}
