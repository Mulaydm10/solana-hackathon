/**
 * The chain as the broker and the runner see it (PLAN §6): one read of the mission and the agent's mandate
 * answers "is this agent allowed to act right now?". Used by the broker's MandateSource (grant and every
 * call) and the runner's `live` check (start and the revoke poll).
 */
import { getMandate, getMission, type DealContext } from "@deal/chain";
import type { MandateSource, MandateState } from "../broker/broker.ts";

/** `now` must be the chain's clock (unix seconds); on a real cluster that is close to Date.now(). */
export function mandateSourceFromChain(ctx: DealContext, now: () => number | bigint = () => Math.floor(Date.now() / 1000)): MandateSource {
  return async (mission, agent): Promise<MandateState | null> => {
    const [m, d] = await Promise.all([getMission(ctx, mission as never), getMandate(ctx, mission as never, agent as never)]);
    if (!m || !d) return null;
    const t = Number(now());
    const live = !d.revoked && t < d.expiresAt && !m.closed && t < m.expiresAt;
    const stage = m.stages[m.currentStage];
    const stageOpen = m.mandatesLocked && !!stage && stage.approvedAt > 0 && ((d.stageMask >> m.currentStage) & 1) === 1;
    return { live, stageOpen, roleHash: d.roleHash };
  };
}

/** The runner's start/poll check: the mandate is live (stage gating is the broker's and the chain's job). */
export const liveFrom = (src: MandateSource) => async (mission: string, agent: string) => (await src(mission, agent).catch(() => null))?.live === true;
