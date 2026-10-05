/**
 * The chain as the broker and the runner see it (PLAN §6): one read of the mission and the agent's mandate
 * answers "is this agent allowed to act right now?". Used by the broker's MandateSource (grant and every
 * call) and the runner's `live` check (start and the revoke poll).
 */
import { getMandate, getMission, type DealContext } from "@deal/chain";
import type { MandateSource, MandateState } from "../broker/broker.ts";

/** Transient read failures (public RPC rate limits, HTTP 429, timeouts) are retried a few times before giving up. */
export const READ_RETRY_MS = [300, 800, 2_000] as const;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(read: () => Promise<T>, waits: readonly number[]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (i >= waits.length) throw e;
      await pause(waits[i]!);
    }
  }
}

/** `now` must be the chain's clock (unix seconds); on a real cluster that is close to Date.now(). */
export function mandateSourceFromChain(
  ctx: DealContext, now: () => number | bigint = () => Math.floor(Date.now() / 1000), o: { retryMs?: readonly number[] } = {},
): MandateSource {
  return async (mission, agent): Promise<MandateState | null> => {
    const [m, d] = await withRetry(() => Promise.all([getMission(ctx, mission as never), getMandate(ctx, mission as never, agent as never)]), o.retryMs ?? READ_RETRY_MS);
    if (!m || !d) return null;
    const t = Number(now());
    const live = !d.revoked && t < d.expiresAt && !m.closed && t < m.expiresAt;
    const stage = m.stages[m.currentStage];
    const stageOpen = m.mandatesLocked && !!stage && stage.approvedAt > 0 && ((d.stageMask >> m.currentStage) & 1) === 1;
    return { live, stageOpen, roleHash: d.roleHash };
  };
}

/**
 * The runner's start/poll check: the mandate is live (stage gating is the broker's and the chain's job).
 * A successful read decides at once (revoked, expired, closed or missing = false). A read that fails even after
 * retries is not evidence of a revoke: it keeps the last successfully read answer for that mission and agent, and
 * the next poll reads again. With no successful read yet it fails closed (false), as before (#208).
 */
export const liveFrom = (src: MandateSource) => {
  const last = new Map<string, boolean>();
  return async (mission: string, agent: string): Promise<boolean> => {
    const key = `${mission}/${agent}`;
    let state: MandateState | null;
    try {
      state = await src(mission, agent);
    } catch {
      return last.get(key) ?? false;
    }
    const live = state?.live === true;
    last.set(key, live);
    return live;
  };
};
