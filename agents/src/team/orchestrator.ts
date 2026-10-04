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
import { deals, mandatesDigest, missions, type DealContext, type MandateInput } from "@deal/chain";
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

export async function* runMission(o: MissionOptions): AsyncGenerator<MissionEvent> {
  const v = validateBlueprint(o.blueprint, { limits: DEFAULT_LIMITS, capabilities: o.capabilities });
  if (!v.ok) return yield { type: "failed", reason: v.reason, message: `blueprint refused at ${v.at}` };
  const bp: Blueprint = v.value;
  const t = missionTerms(bp, o.goal, o.budget);
  if (!t.ok) return yield { type: "failed", reason: t.reason, message: "mission terms refused" };
  yield { type: "terms", hash: bytesToHex(t.value.hash), canonical: t.value.canonical };

  const created = await missions.create(o.ctx, o.buyer, {
    missionId: o.missionId, budget: o.budget, termsHash: t.value.hash, stageCaps: bp.stages.map((st) => st.cap), expiresAt: o.expiresAt,
    verifier: o.dealRules.verifier, minReviewSecs: o.dealRules.minReviewSecs, minResolveSecs: o.dealRules.minResolveSecs,
    maxToleranceBps: o.dealRules.maxToleranceBps, rentLamports: o.rentLamports,
  });
  if (!created.ok) return yield { type: "failed", reason: created.reason, message: created.message };
  const mission = created.mission;
  yield { type: "created", mission };

  // One keypair per role, kept here; the chain mandate is built from the signed terms.
  const agents = new Map<string, KeyPairSigner>();
  const inputs: MandateInput[] = [];
  for (const m of t.value.terms.mandates) {
    const role = bp.roles.find((r) => r.name === m.role)!;
    const agent = await generateKeyPairSigner();
    const input: MandateInput = {
      agent: agent.address, roleHash: roleHash(role), cap: m.cap, perTxCap: m.perTxCap, payees: m.payees as Address[],
      stageMask: m.stages.reduce((mask, i) => mask | (1 << i), 0), expiresAt: o.expiresAt,
    };
    const r = await missions.addMandate(o.ctx, o.buyer, mission, input);
    if (!r.ok) return yield { type: "failed", reason: r.reason, message: r.message };
    agents.set(m.role, agent);
    inputs.push(input);
    o.onAgent?.(m.role, agent);
    yield { type: "mandate", role: m.role, agent: agent.address };
  }
  o.broker.registerMission(mission, { buyer: o.buyer.address, blueprint: bp, agents: Object.fromEntries([...agents].map(([r, a]) => [a.address, r])) });
  const digest = mandatesDigest(inputs);
  const reader = createDeterministicReader();
  const results: { role: string; output: string }[] = [];

  for (const [i, stage] of bp.stages.entries()) {
    // The plan is built in code from the signed terms: what the human approves is what runs.
    const plan = canonicalize({ mission, stage: i, name: stage.name, roles: [...stage.roles].sort(), cap: stage.cap, goal: o.goal } as unknown as Json);
    const planHash = sha256Bytes(plan);
    yield { type: "plan", stage: i, planHash: bytesToHex(planHash), plan };
    if (!(await o.approve(i, plan, planHash))) {
      yield { type: "declined", stage: i };
      await missions.close(o.ctx, o.buyer, mission);
      return;
    }
    const ok = await missions.approveStage(o.ctx, o.buyer, mission, i, planHash, digest);
    if (!ok.ok) return yield { type: "failed", reason: ok.reason, message: ok.message };
    yield { type: "approved", stage: i };

    const events: MissionEvent[] = [];
    const runs = stage.roles.map(async (roleName) => {
      const agent = agents.get(roleName)!;
      const role = bp.roles.find((r) => r.name === roleName)!;
      // One capability token per provider the role uses, scoped to the role's actions.
      const env: Record<string, string> = { ...(o.workerEnv?.[roleName] ?? {}), ROLE: roleName, GOAL: o.goal.slice(0, 500) };
      const byProvider = new Map<string, string[]>();
      for (const c of role.capabilities) {
        const [p, a] = c.split(":") as [string, string];
        byProvider.set(p, [...(byProvider.get(p) ?? []), a]);
      }
      for (const [provider, actions] of byProvider) {
        const g = await o.broker.grant({ provider, resource: "*", actions, mission, agent: agent.address });
        if (g.ok) env[`CAP_${provider.toUpperCase()}`] = g.token;
        else events.push({ type: "refused", role: roleName, reason: g.reason });
      }
      const started = await startAgent(
        { mission, agent: agent.address, entry: o.workers[roleName]!, env, maxSecs: o.runner?.maxSecs },
        {
          live: o.live,
          call: async (presenter, token, action, args) => o.broker.call(token, action, args, presenter),
          onMessage: async (_a, message) => {
            const m = await readWorkerMessage(reader, message);
            if (m.kind === "spend") {
              const r = await missions.spend(o.ctx, agent, mission, m.payee, m.amount, m.receipt);
              events.push({ type: "spend", role: roleName, payee: m.payee, amount: m.amount.toString(), ok: r.ok, reason: r.ok ? undefined : r.reason });
              return r.ok ? { ok: true } : { ok: false, reason: r.reason };
            }
            if (m.kind === "result") {
              results.push({ role: roleName, output: m.output });
              events.push({ type: "result", role: roleName, output: m.output });
              return { ok: true };
            }
            events.push({ type: "refused", role: roleName, reason: m.reason });
            return { ok: false, reason: "UNREADABLE" };
          },
          mode: o.runner?.mode,
          pollMs: o.runner?.pollMs,
        },
      );
      if (!started.ok) {
        events.push({ type: "refused", role: roleName, reason: started.reason });
        return;
      }
      events.push({ type: "worker-exit", role: roleName, exit: await started.handle.done });
    });
    await Promise.all(runs);
    for (const e of events) yield e;
  }

  // The final product: the workers' results in role order, hashed. The buyer checks it against this hash.
  const product = canonicalize({ mission, goal: o.goal, results: [...results].sort((a, b) => (a.role < b.role ? -1 : 1)) } as unknown as Json);
  const productHash = sha256Bytes(product);
  if (o.team) {
    const acc = await deals.accept(o.ctx, o.team.seller, o.team.feeDeal);
    const del = acc.ok ? await deals.deliver(o.ctx, o.team.seller, o.team.feeDeal, productHash, o.team.invoice) : acc;
    if (!del.ok) return yield { type: "failed", reason: del.reason, message: del.message };
  }
  yield { type: "delivered", deliverableHash: bytesToHex(productHash) };
}
