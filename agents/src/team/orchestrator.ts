/**
 * Team orchestrator (PLAN §6.1). Runs a hired team's mission end to end:
 *
 *   blueprint + goal + budget -> core missionTerms (the terms the buyer signs)
 *   -> create_mission (buyer) -> one keypair and one on-chain mandate per role
 *   -> per stage: a plan built in code -> its hash -> the HUMAN approves (callback) -> approve_stage
 *      -> each role's worker runs isolated (runner), with broker capabilities only
 *   -> the final product's hash -> delivery on the team's fee deal (if any).
 *
 * Rules this file keeps:
 *   - agents hold no keys and no credentials: the orchestrator keeps each agent's keypair and signs
 *     `agent_spend` for it, so the on-chain mandate (caps, payees, stage, revoke) judges every payment;
 *   - everything a worker says is untrusted: it goes through the quarantined reader (#71) against a
 *     strict schema before anything acts on it;
 *   - the human sees a plan rendered by code and approves its hash, never model prose;
 *   - nothing is retried blindly: every chain action is the library's safeSend.
 */
import { generateKeyPairSigner, type Address, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize, missionTerms, roleHash, sha256Bytes, validateBlueprint, DEFAULT_LIMITS, type Blueprint, type Json } from "@deal/core";
import { deals, findMissionPda, getMission, mandatesDigest, missions, type DealContext, type MandateInput } from "@deal/chain";
import type { Broker } from "../broker/broker.ts";
import { createDeterministicReader, type Reader } from "../reader/reader.ts";
import { s } from "../reader/schema.ts";
import { startAgent, type Exit } from "../vm/runner.ts";

export type MissionEvent =
  | { type: "terms"; hash: string; canonical: string }
  | { type: "created"; mission: Address }
  | { type: "mandate"; role: string; agent: Address }
  | { type: "plan"; stage: number; planHash: string; plan: string }
  | { type: "approved"; stage: number }
  | { type: "declined"; stage: number }
  | { type: "spend"; role: string; payee: string; amount: string; ok: boolean; reason?: string }
  | { type: "result"; role: string; output: string }
  | { type: "worker-exit"; role: string; exit: Exit }
  | { type: "refused"; role: string; reason: string }
  | { type: "delivered"; deliverableHash: string }
  | { type: "failed"; reason: string; message: string };

export type MissionOptions = {
  ctx: DealContext;
  buyer: TransactionSigner;
  blueprint: unknown;
  goal: string;
  budget: bigint;
  missionId: bigint;
  /** Unix seconds (chain clock). */
  expiresAt: bigint;
  /**
   * The buyer's protections for every deal its agents open (a verifier it trusts, not itself; minimum
   * review/resolve windows; maximum invoice tolerance). Agents cannot weaken them on chain.
   */
  dealRules: { verifier: Address; minReviewSecs?: bigint; minResolveSecs?: bigint; maxToleranceBps?: number };
  /** SOL for the rent of deals and records the agents' purchases create. */
  rentLamports?: bigint;
  broker: Broker;
  /** Capability ids the broker's providers offer (`provider:action`). */
  capabilities: readonly string[];
  /** Worker entry script per role (absolute path). */
  workers: Record<string, string>;
  /** Extra, non-secret environment per role (e.g. the seller to buy from). Never keys or credentials. */
  workerEnv?: Record<string, Record<string, string>>;
  /** The human gate. Returns true only if the buyer approves exactly this plan. */
  approve: (stage: number, plan: string, planHash: Uint8Array) => Promise<boolean>;
  /** Chain clock and the runner's liveness check. */
  live: (mission: string, agent: string) => Promise<boolean>;
  /** Team seller and its fee deal: the final product hash is delivered there. */
  team?: { seller: TransactionSigner; feeDeal: Address; invoice: bigint };
  runner?: { mode?: "process" | "container"; pollMs?: number; maxSecs?: number };
  /** Called with the role's agent signer so tests can, e.g., revoke one; never exposes keys to workers. */
  onAgent?: (role: string, agent: KeyPairSigner) => void;
};

/** What a worker may say. Anything else is refused by the reader before the orchestrator acts. */
const SPEND = s.object({ type: s.oneOf(["spend"] as const), payee: s.address(), amount: s.amount({ max: 10n ** 15n }), receipt: s.hex32() });
const RESULT = s.object({ type: s.oneOf(["result"] as const), output: s.text({ max: 4_000, multiline: true }) });

export type WorkerMessage =
  | { kind: "spend"; payee: Address; amount: bigint; receipt: Uint8Array }
  | { kind: "result"; output: string }
  | { kind: "refused"; reason: string };

/**
 * The only door from a worker to the orchestrator: whatever the worker sent (any value, any text) goes
 * through the quarantined reader against the two allowed shapes. A well-formed spend is still only a
 * request: the chain mandate (payees, caps, stage, revoke) decides whether money moves.
 */
export async function readWorkerMessage(reader: Reader, message: unknown): Promise<WorkerMessage> {
  const text = typeof message === "string" ? message : JSON.stringify(message ?? null);
  const asSpend = await reader.read(text, SPEND);
  if (asSpend.ok) {
    return { kind: "spend", payee: asSpend.value.payee as Address, amount: asSpend.value.amount, receipt: Uint8Array.from(Buffer.from(asSpend.value.receipt, "hex")) };
  }
  const asResult = await reader.read(text, RESULT);
  if (asResult.ok) return { kind: "result", output: asResult.value.output };
  return { kind: "refused", reason: asSpend.reason };
}

/** Everything the buyer signs for a mission, computed in code from the blueprint and the goal. */
export type PreparedMission = {
  buyer: Address;
  missionId: bigint;
  mission: Address;
  blueprint: Blueprint;
  goal: string;
  budget: bigint;
  expiresAt: bigint;
  terms: { hash: Uint8Array; canonical: string };
  /** One per role, in terms order. The keypairs stay with the orchestrator (agents hold no keys). */
  roles: { role: string; agent: KeyPairSigner; mandate: MandateInput }[];
  digest: Uint8Array;
  /** The plan of each stage, rendered by code; the buyer approves exactly these hashes. */
  plans: { stage: number; plan: string; planHash: Uint8Array }[];
  createParams: Parameters<typeof missions.create>[2];
};

export type PrepareOptions = Pick<MissionOptions, "blueprint" | "goal" | "budget" | "missionId" | "expiresAt" | "capabilities" | "dealRules" | "rentLamports"> & {
  buyer: Address;
};

/**
 * Step 1, no signatures: validate the blueprint, build the terms, make one keypair per role, and render
 * every stage's plan. The browser (or a test) then has the buyer sign create_mission, each add_mandate and
 * approve_stage itself; the orchestrator never holds the buyer's key.
 */
export async function prepareMission(o: PrepareOptions): Promise<{ ok: true; value: PreparedMission } | { ok: false; reason: string; message: string }> {
  const v = validateBlueprint(o.blueprint, { limits: DEFAULT_LIMITS, capabilities: o.capabilities });
  if (!v.ok) return { ok: false, reason: v.reason, message: `blueprint refused at ${v.at}` };
  const bp: Blueprint = v.value;
  const t = missionTerms(bp, o.goal, o.budget);
  if (!t.ok) return { ok: false, reason: t.reason, message: "mission terms refused" };
  const [mission] = await findMissionPda({ buyer: o.buyer, missionId: o.missionId });
  const roles: PreparedMission["roles"] = [];
  for (const m of t.value.terms.mandates) {
    const role = bp.roles.find((r) => r.name === m.role)!;
    const agent = await generateKeyPairSigner();
    roles.push({
      role: m.role, agent,
      mandate: {
        agent: agent.address, roleHash: roleHash(role), cap: m.cap, perTxCap: m.perTxCap, payees: m.payees as Address[],
        stageMask: m.stages.reduce((mask, i) => mask | (1 << i), 0), expiresAt: o.expiresAt,
      },
    });
  }
  const plans = bp.stages.map((stage, i) => {
    const plan = canonicalize({ mission, stage: i, name: stage.name, roles: [...stage.roles].sort(), cap: stage.cap, goal: o.goal } as unknown as Json);
    return { stage: i, plan, planHash: sha256Bytes(plan) };
  });
  return {
    ok: true,
    value: {
      buyer: o.buyer, missionId: o.missionId, mission, blueprint: bp, goal: o.goal, budget: o.budget, expiresAt: o.expiresAt,
      terms: { hash: t.value.hash, canonical: t.value.canonical }, roles, digest: mandatesDigest(roles.map((r) => r.mandate)), plans,
      createParams: {
        missionId: o.missionId, budget: o.budget, termsHash: t.value.hash, stageCaps: bp.stages.map((st) => st.cap), expiresAt: o.expiresAt,
        verifier: o.dealRules.verifier, minReviewSecs: o.dealRules.minReviewSecs, minResolveSecs: o.dealRules.minResolveSecs,
        maxToleranceBps: o.dealRules.maxToleranceBps, rentLamports: o.rentLamports,
      },
    },
  };
}

export type RunStagesOptions = Pick<MissionOptions, "ctx" | "broker" | "workers" | "workerEnv" | "live" | "team" | "runner"> & {
  prepared: PreparedMission;
  /** How often to check the chain for the buyer's next approval. Default 2 s. */
  pollMs?: number;
  /** Give up waiting for an approval after this long (ms). Default: until the mission expires. */
  approvalTimeoutMs?: number;
  /** Test hook: called while waiting for stage i's approval. */
  onWaiting?: (stage: number) => Promise<void> | void;
};

/**
 * Step 2: runs each stage only once the chain shows the buyer approved exactly that stage's plan hash (signed
 * by the buyer's own wallet). Agents work under their on-chain mandates; the final product hash is delivered.
 */
export async function* runStages(o: RunStagesOptions): AsyncGenerator<MissionEvent> {
  const p = o.prepared;
  const mission = p.mission;
  const agents = new Map(p.roles.map((r) => [r.role, r.agent]));
  o.broker.registerMission(mission, { buyer: p.buyer, blueprint: p.blueprint, agents: Object.fromEntries(p.roles.map((r) => [r.agent.address, r.role])) });
  const reader = createDeterministicReader();
  const results: { role: string; output: string }[] = [];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (const { stage: i, planHash, plan } of p.plans) {
    yield { type: "plan", stage: i, planHash: bytesToHex(planHash), plan };
    // Wait for the buyer's own approval of this exact plan, on chain.
    const started = Date.now();
    for (;;) {
      const m = await getMission(o.ctx, mission);
      if (!m) return yield { type: "failed", reason: "MISSION_NOT_FOUND", message: "the mission is not on chain" };
      if (m.closed) return yield { type: "declined", stage: i };
      const st = m.stages[i];
      if (st && st.approvedAt > 0) {
        if (st.planHash !== bytesToHex(planHash)) return yield { type: "failed", reason: "PLAN_MISMATCH", message: `stage ${i} was approved for a different plan` };
        break;
      }
      if (o.approvalTimeoutMs !== undefined && Date.now() - started > o.approvalTimeoutMs) return yield { type: "failed", reason: "APPROVAL_TIMEOUT", message: `no approval for stage ${i}` };
      await o.onWaiting?.(i);
      await sleep(o.pollMs ?? 2_000);
    }
    yield { type: "approved", stage: i };

    const events: MissionEvent[] = [];
    const stage = p.blueprint.stages[i]!;
    await Promise.all(stage.roles.map(async (roleName) => {
      const agent = agents.get(roleName)!;
      const role = p.blueprint.roles.find((r) => r.name === roleName)!;
      // One capability token per provider the role uses, scoped to the role's actions.
      const env: Record<string, string> = { ...(o.workerEnv?.[roleName] ?? {}), ROLE: roleName, GOAL: p.goal.slice(0, 500) };
      const byProvider = new Map<string, string[]>();
      for (const c of role.capabilities) {
        const [prov, a] = c.split(":") as [string, string];
        byProvider.set(prov, [...(byProvider.get(prov) ?? []), a]);
      }
      for (const [provider, actions] of byProvider) {
        const g = await o.broker.grant({ provider, resource: "*", actions, mission, agent: agent.address });
        if (g.ok) env[`CAP_${provider.toUpperCase()}`] = g.token;
        else events.push({ type: "refused", role: roleName, reason: g.reason });
      }
      const run = await startAgent(
        { mission, agent: agent.address, entry: o.workers[roleName]!, env, maxSecs: o.runner?.maxSecs },
        {
          live: o.live,
          call: async (presenter, token, action, args) => o.broker.call(token, action, args, presenter),
          onMessage: async (_a, message) => {
            const msg = await readWorkerMessage(reader, message);
            if (msg.kind === "spend") {
              const r = await missions.spend(o.ctx, agent, mission, msg.payee, msg.amount, msg.receipt);
              events.push({ type: "spend", role: roleName, payee: msg.payee, amount: msg.amount.toString(), ok: r.ok, reason: r.ok ? undefined : r.reason });
              return r.ok ? { ok: true } : { ok: false, reason: r.reason };
            }
            if (msg.kind === "result") {
              results.push({ role: roleName, output: msg.output });
              events.push({ type: "result", role: roleName, output: msg.output });
              return { ok: true };
            }
            events.push({ type: "refused", role: roleName, reason: msg.reason });
            return { ok: false, reason: "UNREADABLE" };
          },
          mode: o.runner?.mode,
          pollMs: o.runner?.pollMs,
        },
      );
      if (!run.ok) return void events.push({ type: "refused", role: roleName, reason: run.reason });
      events.push({ type: "worker-exit", role: roleName, exit: await run.handle.done });
    }));
    for (const e of events) yield e;
  }

  // The final product: the workers' results in role order, hashed. The buyer checks it against this hash.
  const product = canonicalize({ mission, goal: p.goal, results: [...results].sort((a, b) => (a.role < b.role ? -1 : 1)) } as unknown as Json);
  const productHash = sha256Bytes(product);
  if (o.team) {
    const acc = await deals.accept(o.ctx, o.team.seller, o.team.feeDeal);
    const del = acc.ok ? await deals.deliver(o.ctx, o.team.seller, o.team.feeDeal, productHash, o.team.invoice) : acc;
    if (!del.ok) return yield { type: "failed", reason: del.reason, message: del.message };
  }
  yield { type: "delivered", deliverableHash: bytesToHex(productHash) };
}

/**
 * All in one, for servers that hold a buyer key (tests, an agent buying for its own owner): prepare, sign
 * create_mission and the mandates as the buyer, then for each stage ask `approve` and sign approve_stage,
 * while runStages runs what the chain shows approved. The website uses prepareMission + the buyer's wallet
 * + runStages instead.
 */
export async function* runMission(o: MissionOptions): AsyncGenerator<MissionEvent> {
  const prep = await prepareMission({ ...o, buyer: o.buyer.address });
  if (!prep.ok) return yield { type: "failed", reason: prep.reason, message: prep.message };
  const p = prep.value;
  yield { type: "terms", hash: bytesToHex(p.terms.hash), canonical: p.terms.canonical };
  const created = await missions.create(o.ctx, o.buyer, p.createParams);
  if (!created.ok) return yield { type: "failed", reason: created.reason, message: created.message };
  yield { type: "created", mission: p.mission };
  for (const r of p.roles) {
    const added = await missions.addMandate(o.ctx, o.buyer, p.mission, r.mandate);
    if (!added.ok) return yield { type: "failed", reason: added.reason, message: added.message };
    o.onAgent?.(r.role, r.agent);
    yield { type: "mandate", role: r.role, agent: r.agent.address };
  }
  const decided = new Set<number>();
  const declined: number[] = [];
  const gen = runStages({
    ...o, prepared: p, pollMs: 10,
    onWaiting: async (i) => {
      if (decided.has(i)) return;
      decided.add(i);
      const plan = p.plans[i]!;
      if (await o.approve(i, plan.plan, plan.planHash)) {
        const ok = await missions.approveStage(o.ctx, o.buyer, p.mission, i, plan.planHash, p.digest);
        if (!ok.ok) throw Object.assign(new Error(ok.message), { reason: ok.reason });
      } else {
        declined.push(i);
        await missions.close(o.ctx, o.buyer, p.mission);
      }
    },
  });
  for await (const e of gen) {
    yield e;
    if (e.type === "declined") return;
  }
  void declined;
}

