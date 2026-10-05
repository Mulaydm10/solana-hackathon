/**
 * Mission service: the long-running half of a hired team (PLAN §6.1). Vercel functions cannot run workers
 * for minutes, so the site's API routes talk to this service on a long-running host (the Omen or the Mac).
 *
 *   POST /missions/prepare        { blueprint, goal, budget, missionId, buyer, expiresAt }  -> what the buyer signs
 *   POST /missions/:mission/start { feeDeal? } -> begins runStages (waits for the buyer's on-chain approvals itself);
 *                                 with a fee deal, the team seller accepts it and delivers the final product hash there
 *   GET  /missions/:mission       -> status and events so far
 *
 * The service holds the agents' keypairs (agents hold none) and never the buyer's key: the buyer signs
 * create_mission, the mandates and every approve_stage in its own wallet. Requests need the bearer token
 * (the site's server routes hold it; browsers never see it). Bodies are size-limited JSON; bigints are strings.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Address, TransactionSigner } from "@solana/kit";
import { fetchMaybeDealLink, findLinkPda, getDeal, getListing, readWithRetry, type DealContext } from "@deal/chain";
import type { Broker } from "../broker/broker.ts";
import { prepareMission, runStages, type MissionEvent, type PreparedMission } from "./orchestrator.ts";

export type ServiceOptions = {
  ctx: DealContext;
  broker: Broker;
  /** `provider:action` ids the broker offers. */
  capabilities: readonly string[];
  workers: Record<string, string>;
  workerEnv?: Record<string, Record<string, string>>;
  /**
   * The site's server-side demo buyer(s) ("Try the demo", #199). Missions whose prepared buyer is one of these start
   * the researcher with TRY_OVER_CAP=1, so the demo shows one over-cap payment refused ON CHAIN (OverPerTxCap) before
   * the in-mandate one (#214). Decided from the prepared mission's buyer, never from request fields; other missions
   * never get it.
   */
  demoBuyers?: readonly string[];
  live: (mission: string, agent: string) => Promise<boolean>;
  dealRules: { verifier: Address; minReviewSecs?: bigint; minResolveSecs?: bigint; maxToleranceBps?: number };
  /** Bearer token the site's server routes send. */
  token: string;
  pollMs?: number;
  runner?: { mode?: "process" | "container"; pollMs?: number; maxSecs?: number };
  /** The team seller's key: the seller of the Team listings this service runs; it accepts and delivers fee deals. */
  team?: { seller: TransactionSigner };
  /** Keeps each mission's public view (never agent keys) so the site still shows it after a restart. */
  store?: MissionStore;
  /** Which text source the workers' llm:complete uses ("simulated" is shown as Simulated AI demo). Default "none". */
  aiProvider?: "anthropic" | "simulated" | "none";
};

/** What the site shows for a mission: its public terms, plans, state and events. Never a key. */
export type StoredMission = ReturnType<typeof publicView> & { state: string; events: MissionEvent[]; aiProvider?: string };

export type MissionStore = {
  save(mission: string, view: StoredMission): void;
  load(mission: string): unknown | null;
};

const MISSION_FILE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One JSON file per mission in `dir` (written whole, then renamed, so a reader never sees half a file). */
export function fileMissionStore(dir: string): MissionStore {
  mkdirSync(dir, { recursive: true });
  return {
    save(mission, view) {
      if (!MISSION_FILE.test(mission)) return;
      const file = join(dir, `${mission}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(view, big));
      renameSync(`${file}.tmp`, file);
    },
    load(mission) {
      const file = join(dir, `${mission}.json`);
      if (!MISSION_FILE.test(mission) || !existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
  };
}

/** Fee deal checks: every one must hold on chain, or the team will not deliver into that deal. */
export type FeeDealCheck = { ok: true; invoice: bigint } | { ok: false; reason: string; message: string };

/**
 * The fee deal is only taken if the chain shows it is this mission's buyer paying THIS team seller the Team
 * listing's price under this mission's terms, and the seller has not acted on it yet (Open or Funded).
 */
export async function checkFeeDeal(ctx: DealContext, deal: Address, want: { buyer: string; seller: string; termsHash: string }): Promise<FeeDealCheck> {
  const no = (reason: string, message: string): FeeDealCheck => ({ ok: false, reason, message });
  const d = await getDeal(ctx, deal);
  if (!d) return no("FEE_DEAL_NOT_FOUND", "no deal at that address");
  if (d.status !== "Open" && d.status !== "Funded") return no("FEE_DEAL_STATE", `the fee deal is ${d.status}`);
  if (d.buyer !== want.buyer) return no("FEE_DEAL_BUYER", "the fee deal is not from this mission's buyer");
  if (d.seller !== want.seller) return no("FEE_DEAL_SELLER", "the fee deal does not pay this team's seller");
  if (d.termsHash !== want.termsHash) return no("FEE_DEAL_TERMS", "the fee deal is not for this mission's terms");
  const link = await readWithRetry(ctx, async () => fetchMaybeDealLink(ctx.client.rpc, (await findLinkPda({ deal }))[0]));
  if (!link.exists) return no("FEE_DEAL_NO_LISTING", "the fee deal was not opened from a Team listing");
  const l = await getListing(ctx, link.data.listing);
  if (!l || l.kind !== "Team" || l.seller !== want.seller) return no("FEE_DEAL_LISTING", "the fee deal's listing is not this team's Team listing");
  if (d.amount !== l.price) return no("FEE_DEAL_AMOUNT", "the fee deal's amount is not the listing price");
  return { ok: true, invoice: BigInt(d.amount) };
}

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
  // Best effort: a full disk must not stop a running mission.
  const persist = (mission: string) => {
    const e = missions.get(mission);
    if (!e || !o.store) return;
    try {
      o.store.save(mission, { ...publicView(e.prepared), state: e.state, events: e.events, aiProvider: o.aiProvider ?? "none" });
    } catch (err) {
      console.error(`[missions] could not store ${mission}:`, err instanceof Error ? err.message : err);
    }
  };
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
        persist(r.value.mission);
        return json(res, 200, { ok: true, ...publicView(r.value) });
      }

      const mission = parts[1];
      const entry = mission ? missions.get(mission) : undefined;
      if (parts[0] !== "missions" || !mission) return json(res, 404, { ok: false, reason: "NOT_FOUND" });
      if (!entry) {
        // Not running here (e.g. the service restarted, or a scripted run): show what the store kept, read-only.
        const kept = req.method === "GET" && parts.length === 2 ? o.store?.load(mission) : null;
        if (kept && typeof kept === "object") {
          const k = kept as { state?: unknown };
          const state = k.state === "prepared" || k.state === "running" ? "interrupted" : k.state;
          return json(res, 200, { ...(kept as object), ok: true, state, stored: true });
        }
        return json(res, 404, { ok: false, reason: "UNKNOWN_MISSION" });
      }

      if (req.method === "POST" && parts[2] === "start") {
        if (entry.state !== "prepared") return json(res, 409, { ok: false, reason: "ALREADY_STARTED" });
        const body = (await readBody(req)) as { feeDeal?: unknown };
        let team: { seller: TransactionSigner; feeDeal: Address; invoice: bigint } | undefined;
        if (body.feeDeal !== undefined) {
          if (typeof body.feeDeal !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.feeDeal)) return json(res, 400, { ok: false, reason: "BAD_REQUEST" });
          if (!o.team) return json(res, 422, { ok: false, reason: "NO_TEAM_SELLER", message: "this service has no team seller key" });
          const c = await checkFeeDeal(o.ctx, body.feeDeal as Address, {
            buyer: entry.prepared.buyer, seller: o.team.seller.address, termsHash: bytesToHex(entry.prepared.terms.hash),
          });
          // Refused: the mission stays "prepared", so the buyer can start it again with the right deal.
          if (!c.ok) return json(res, 422, c);
          team = { seller: o.team.seller, feeDeal: body.feeDeal as Address, invoice: c.invoice };
        }
        if (entry.state !== "prepared") return json(res, 409, { ok: false, reason: "ALREADY_STARTED" }); // a racing start won
        entry.state = "running";
        persist(mission);
        void (async () => {
          try {
            for await (const e of runStages({
              ctx: o.ctx, prepared: entry.prepared, broker: o.broker, workers: o.workers, workerEnv: workerEnvFor(o, entry.prepared.buyer), live: o.live,
              pollMs: o.pollMs, runner: o.runner, approvalTimeoutMs: Number(entry.prepared.expiresAt) * 1000 - Date.now(), team,
            })) {
              entry.events.push(e);
              persist(mission);
            }
            entry.state = entry.events.at(-1)?.type === "delivered" ? "done" : "failed";
          } catch (e) {
            entry.events.push({ type: "failed", reason: "INTERNAL", message: e instanceof Error ? e.message : String(e) });
            entry.state = "failed";
          }
          persist(mission);
        })();
        return json(res, 202, { ok: true, state: entry.state });
      }

      if (req.method === "GET" && parts.length === 2) {
        return json(res, 200, { ok: true, state: entry.state, events: entry.events, ...publicView(entry.prepared), aiProvider: o.aiProvider ?? "none" });
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

/** The worker env for one mission: the service's own, plus TRY_OVER_CAP=1 for the researcher of a demo buyer's mission. */
export function workerEnvFor(o: Pick<ServiceOptions, "workerEnv" | "demoBuyers">, buyer: string): Record<string, Record<string, string>> | undefined {
  if (!o.demoBuyers?.includes(buyer)) return o.workerEnv;
  return { ...o.workerEnv, researcher: { ...o.workerEnv?.researcher, TRY_OVER_CAP: "1" } };
}
