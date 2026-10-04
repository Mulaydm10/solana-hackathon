// What the chain says about a mission the service reports on (#145): whether the buyer closed it, and which agents'
// mandates are revoked. The service's state lags these (it reports "done" after a close), so the page shows the chain's.
import type { Address } from "@solana/kit";
import { fetchMaybeMandate, fetchMaybeMission, findMandatePda } from "@deal/chain";

export type ChainState = { closed: boolean; revoked: Record<string, boolean> };

type Maybe<T> = { exists: true; data: T } | { exists: false };
export type ChainReads = {
  mission(address: Address): Promise<Maybe<{ closed: boolean }>>;
  mandate(address: Address): Promise<Maybe<{ revoked: boolean }>>;
};

export const rpcReads = (rpc: Parameters<typeof fetchMaybeMission>[0]): ChainReads => ({
  mission: (a) => fetchMaybeMission(rpc, a),
  mandate: (a) => fetchMaybeMandate(rpc, a),
});

/** Null if the chain cannot be read (the page then shows the service's state alone). */
export async function readChainState(reads: ChainReads, mission: Address, agents: readonly string[]): Promise<ChainState | null> {
  try {
    const [m, ...mandates] = await Promise.all([
      reads.mission(mission),
      ...agents.map(async (agent) => reads.mandate((await findMandatePda({ mission, agent: agent as Address }))[0])),
    ]);
    if (!m!.exists) return null;
    const revoked: Record<string, boolean> = {};
    agents.forEach((a, i) => { const x = mandates[i]!; revoked[a] = x.exists && x.data.revoked; });
    return { closed: m!.data.closed, revoked };
  } catch {
    return null;
  }
}

/** The mission's state as shown: "closed" once the chain says so, whatever the service still reports. */
export const missionState = (serviceState: string, chain: ChainState | null) => (chain?.closed ? "closed" : serviceState);
