// "Try the demo" for judges (#183): a server-held, devnet-only demo buyer (DEMO_BUYER_KEY) hires a team and signs
// its stage approvals and the fee release, so a judge can step through a real mission without installing a wallet.
// The key never leaves the server: routes answer with addresses, signatures and reason codes only.
// Limits, all checked before anything is signed:
//   - the demo buyer's ON-CHAIN policy must be small (DEMO_LIMITS.policy*), or nothing runs (fail closed); the
//     program, not this file, then caps what the key can ever spend per day;
//   - every demo mission has the same small budget, whatever the request says;
//   - a rate limit per client IP, and a daily cap on demo missions;
//   - approve and release act only on missions whose on-chain buyer is the demo key, i.e. missions it created.
import type { Address, Instruction, KeyPairSigner, TransactionSigner } from "@solana/kit";
import { findMandatePda, getAddMandateInstruction, getInitPolicyInstructionAsync, type PolicyParamsArgs } from "@deal/chain";
import { approveStageIx, createMissionIx, feeDealIx, hexToBytes, randomDealId, releaseIx, type CreateWire, type FeeDealState, type Plan } from "./mission-flow";
import { toWire } from "./teams";
import type { Blueprint } from "@deal/core";

const USDC = 1_000_000n;

export const DEMO_LIMITS = {
  /**
   * A demo mission's budget is the team's role caps sum (missionTerms refuses less: CAPS_OVER_BUDGET, #218), and
   * never more than this, base units.
   */
  maxBudget: 6n * USDC,
  /** The demo buyer's on-chain policy may allow at most this per day, and this per deal (one run: budget + fee). */
  policyPerDay: 50n * USDC,
  policyMaxPrice: 10n * USDC,
  /** New demo missions per client IP per hour, and in total per day. */
  missionsPerIpPerHour: 2,
  missionsPerDay: 20,
  /** Approvals and releases per client IP per hour. */
  actionsPerIpPerHour: 20,
  goalMax: 300,
} as const;

export type Refusal = { ok: false; status: number; reason: string; message: string };
const no = (status: number, reason: string, message: string): Refusal => ({ ok: false, status, reason, message });

/** A fixed-window counter per key; `take` refuses once the window's allowance is used. In memory, per instance. */
export function createLimiter(now: () => number = () => Date.now()) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string, max: number, windowMs: number): boolean => {
    const t = now();
    for (const [k, v] of hits) if (t - v.start >= windowMs * 2) hits.delete(k);
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, n: 1 });
      return true;
    }
    if (h.n >= max) return false;
    h.n++;
    return true;
  };
}

export type TeamOffer = { listing: string; seller: string; price: bigint; contentHash: string; blueprint: Blueprint };
type PolicyView = { periodBudget: bigint; maxPrice: bigint };
type ServiceReply = { status: number; body: unknown };

export type DemoDeps = {
  buyer: KeyPairSigner;
  mint: Address;
  /** Sends the instructions signed by the demo buyer (fee payer); returns the signature. */
  send(ixs: Instruction[]): Promise<string>;
  service(path: string, body?: unknown): Promise<ServiceReply>;
  policy(): Promise<PolicyView | null>;
  /** The mission's buyer as the chain shows it, or null if there is no such mission. */
  missionBuyer(mission: Address): Promise<string | null>;
  feeDeal(deal: Address): Promise<FeeDealState | null>;
  /** The Team listing a demo hires (the site's Trip planner by default). */
  team(): Promise<TeamOffer | null>;
  nowSecs(): number;
  limit: ReturnType<typeof createLimiter>;
};

type Prepared = {
  ok: true; mission: string; buyer: string; digest: string; createParams: CreateWire; plans: Plan[]; terms: { hash: string };
  roles: { role: string; agent: string; mandate: { agent: string; roleHash: string; cap: string; perTxCap: string; payees: string[]; stageMask: number; expiresAt: string } }[];
};

/** The demo buyer's policy terms when it has none: the small caps above, any seller. */
/** The demo mission's budget: exactly what the team's agents may spend in total (the sum of its role caps). */
export function demoBudget(bp: { roles: readonly { cap: bigint }[] }): bigint {
  return bp.roles.reduce((s, r) => s + r.cap, 0n);
}

export function demoPolicy(buyer: Address): PolicyArgs {
  return {
    periodSecs: 86_400, periodBudget: DEMO_LIMITS.policyPerDay, maxPrice: DEMO_LIMITS.policyMaxPrice, approvalThreshold: 10n ** 15n, approver: buyer,
    allowAnySeller: true, allowedSellers: [],
  };
}
type PolicyArgs = PolicyParamsArgs;

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Hire the demo team with the demo buyer: policy (if missing), mission + fee deal, mandates, start. */
export async function startDemo(d: DemoDeps, ip: string, goalIn: unknown): Promise<{ ok: true; mission: string; feeDeal: string; signatures: string[] } | Refusal> {
  const goal = typeof goalIn === "string" ? goalIn.trim() : "";
  if (goal.length < 3 || goal.length > DEMO_LIMITS.goalMax) return no(400, "BAD_GOAL", `describe the trip in 3 to ${DEMO_LIMITS.goalMax} characters`);
  if (!d.limit(`start:${ip}`, DEMO_LIMITS.missionsPerIpPerHour, HOUR)) return no(429, "RATE_LIMITED", "too many demo missions from you; try again in an hour");
  if (!d.limit("start:all", DEMO_LIMITS.missionsPerDay, DAY)) return no(429, "DAILY_CAP", "today's demo missions are used up; try again tomorrow");
  const team = await d.team();
  if (!team) return no(503, "NO_DEMO_TEAM", "no demo team is listed");
  if (team.price > DEMO_LIMITS.policyMaxPrice) return no(503, "DEMO_TEAM_TOO_EXPENSIVE", "the demo team's fee is above the demo caps");
  const budget = demoBudget(team.blueprint);
  if (budget > DEMO_LIMITS.maxBudget) return no(503, "DEMO_TEAM_TOO_EXPENSIVE", "the demo team's agent caps are above the demo budget");
  const policy = await d.policy();
  if (policy && (policy.periodBudget > DEMO_LIMITS.policyPerDay || policy.maxPrice > DEMO_LIMITS.policyMaxPrice)) {
    return no(503, "DEMO_POLICY_TOO_LARGE", "the demo buyer's on-chain policy allows more than the demo caps; nothing was signed");
  }
  const signatures: string[] = [];
  if (!policy) signatures.push(await d.send([await getInitPolicyInstructionAsync({ buyer: d.buyer, mint: d.mint, params: demoPolicy(d.buyer.address) })]));

  const missionId = String(BigInt(d.nowSecs()) * 1_000n + BigInt(Math.floor(Math.random() * 1_000)));
  const expiresAt = String(d.nowSecs() + Math.min(team.blueprint.maxDuration, 6 * 3_600));
  const prep = await d.service("/missions/prepare", {
    blueprint: toWire(team.blueprint), goal, budget: budget.toString(), missionId, buyer: d.buyer.address, expiresAt,
  });
  const p = prep.body as Prepared;
  if (prep.status !== 200 || !p?.ok) return no(502, "PREPARE_FAILED", "the mission service did not prepare the demo mission");
  // What the service returned is checked before the demo key signs it.
  if (p.buyer !== d.buyer.address || p.createParams.budget !== budget.toString()) {
    return no(502, "PREPARE_MISMATCH", "the prepared mission is not the demo buyer's, or not the demo budget");
  }
  const fee = await feeDealIx(d.buyer as TransactionSigner, {
    listing: { address: team.listing, seller: team.seller, price: team.price, contentHash: team.contentHash },
    mint: d.mint, termsHash: p.terms.hash, verifier: p.createParams.verifier as Address, deadline: BigInt(p.createParams.expiresAt), dealId: randomDealId(),
  });
  signatures.push(await d.send([await createMissionIx(d.buyer, d.mint, team.listing as Address, p.createParams), fee.ix]));
  signatures.push(await d.send(await Promise.all(p.roles.map(async (r) => {
    const m = r.mandate;
    return getAddMandateInstruction({
      buyer: d.buyer, mission: p.mission as Address, mandate: (await findMandatePda({ mission: p.mission as Address, agent: m.agent as Address }))[0],
      agent: m.agent as Address, roleHash: hexToBytes(m.roleHash), cap: BigInt(m.cap), perTxCap: BigInt(m.perTxCap), payees: m.payees as Address[],
      stageMask: m.stageMask, expiresAt: BigInt(m.expiresAt),
    });
  }))));
  const started = await d.service(`/missions/${p.mission}/start`, { feeDeal: fee.deal });
  if (started.status !== 202) return no(502, "START_FAILED", "the mission is funded but the service did not start it; open it on /missions");
  return { ok: true, mission: p.mission, feeDeal: fee.deal, signatures };
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function ownMission(d: DemoDeps, ip: string, mission: string): Promise<Refusal | null> {
  if (!ADDRESS.test(mission)) return no(400, "BAD_REQUEST", "not a mission address");
  if (!d.limit(`act:${ip}`, DEMO_LIMITS.actionsPerIpPerHour, HOUR)) return no(429, "RATE_LIMITED", "too many demo actions from you; try again in an hour");
  // The demo key acts only on missions it created: the chain says who the mission's buyer is.
  const buyer = await d.missionBuyer(mission as Address);
  if (buyer === null) return no(404, "NO_MISSION", "no mission at that address");
  if (buyer !== d.buyer.address) return no(403, "NOT_A_DEMO_MISSION", "the demo buyer acts only on demo missions it created");
  return null;
}

type Status = { ok?: boolean; buyer?: string; digest?: string; plans?: Plan[]; events?: { type: string; deliverableHash?: string }[] };

/** The demo buyer approves exactly the plan the service shows for this stage (the plan hash is checked in code). */
export async function approveDemo(d: DemoDeps, ip: string, mission: string, stage: unknown): Promise<{ ok: true; signature: string } | Refusal> {
  const bad = await ownMission(d, ip, mission);
  if (bad) return bad;
  if (!Number.isInteger(stage) || (stage as number) < 0 || (stage as number) > 15) return no(400, "BAD_STAGE", "stage must be a stage number");
  const s = (await d.service(`/missions/${mission}`)).body as Status;
  if (!s?.ok || s.buyer !== d.buyer.address || !s.plans || !s.digest) return no(502, "NO_STATUS", "the mission service does not know this demo mission");
  const ix = await approveStageIx(d.buyer, mission as Address, s.plans, stage as number, s.digest);
  if (!ix.ok) return no(422, ix.reason, ix.message);
  return { ok: true, signature: await d.send([ix.ix]) };
}

/** The demo buyer releases the team fee for exactly the product hash the team delivered (checked in code and on chain). */
export async function releaseDemo(d: DemoDeps, ip: string, mission: string, feeDealAddr: unknown): Promise<{ ok: true; signature: string } | Refusal> {
  const bad = await ownMission(d, ip, mission);
  if (bad) return bad;
  if (typeof feeDealAddr !== "string" || !ADDRESS.test(feeDealAddr)) return no(400, "BAD_REQUEST", "feeDeal must be a deal address");
  const deal = await d.feeDeal(feeDealAddr as Address);
  if (!deal) return no(404, "NO_DEAL", "no fee deal at that address");
  if (deal.buyer !== d.buyer.address) return no(403, "NOT_A_DEMO_DEAL", "the demo buyer releases only its own fee deals");
  const s = (await d.service(`/missions/${mission}`)).body as Status;
  const product = s?.events?.find((e) => e.type === "delivered")?.deliverableHash;
  if (!product) return no(409, "NOT_DELIVERED", "the team has not delivered yet");
  const ix = await releaseIx(d.buyer, deal, product);
  if (!ix.ok) return no(409, ix.reason, ix.message);
  return { ok: true, signature: await d.send([ix.ix]) };
}

/** Client IP for the rate limit (Vercel sets x-forwarded-for). */
export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

/** A route's answer: a refusal keeps its status; nothing in it is ever a key. */
export const reply = (r: { ok: true } & Record<string, unknown> | Refusal) =>
  r.ok ? Response.json(r) : Response.json({ ok: false, reason: r.reason, message: r.message }, { status: r.status });

/** Runs a demo action; an unexpected error (RPC down, a transaction refused) is a generic refusal, never its text. */
export async function guarded(fn: () => Promise<{ ok: true } & Record<string, unknown> | Refusal>): Promise<Response> {
  try {
    return reply(await fn());
  } catch (e) {
    console.error("[demo] failed:", e instanceof Error ? e.name : "error");
    return Response.json({ ok: false, reason: "DEMO_FAILED", message: "the demo could not complete that step; nothing more was signed" }, { status: 502 });
  }
}
