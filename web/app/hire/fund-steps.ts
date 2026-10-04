// What the hire flow still has to send (#141). Funding is three wallet transactions (the budget policy if missing,
// the mission with its fee deal, the agents' mandates); any of them can fail. Each attempt reads the chain first, so
// a retry resumes where the last one stopped: an existing mission is never created twice, and only the mandates
// still missing are added.
import type { Address } from "@solana/kit";
import { findMandatePda, policyAddress } from "@deal/chain";

export type FundState = { policy: boolean; mission: boolean; mandates: boolean[] };
export type FundStep = "policy" | "mission" | "mandates";

/** An account-existence check (the RPC's getAccountInfo in the browser; a fake in tests). */
export type Exists = (address: Address) => Promise<boolean>;

export const rpcExists = (rpc: { getAccountInfo(a: Address, o: { encoding: "base64" }): { send(): Promise<{ value: unknown }> } }): Exists =>
  async (a) => (await rpc.getAccountInfo(a, { encoding: "base64" }).send()).value !== null;

export async function readFundState(exists: Exists, buyer: Address, mission: Address, agents: readonly string[]): Promise<FundState> {
  const [policy, missionExists, ...mandates] = await Promise.all([
    exists(await policyAddress(buyer)),
    exists(mission),
    ...agents.map(async (agent) => exists((await findMandatePda({ mission, agent: agent as Address }))[0])),
  ]);
  return { policy: policy!, mission: missionExists!, mandates };
}

/** The roles whose mandate is not on chain yet, in the order prepared (the mandates digest is order-sensitive). */
export const missingMandates = <T>(roles: readonly T[], state: FundState): T[] => roles.filter((_, i) => !state.mandates[i]);

/** Nothing is left to send. */
export const fundDone = (s: FundState) => s.policy && s.mission && s.mandates.every(Boolean);

/** What failed, what is already on chain, and what a retry does. */
export function fundError(step: FundStep, reason: string): string {
  switch (step) {
    case "policy": return `Creating your budget policy failed (${reason}). Nothing was paid. Retry to try again.`;
    case "mission": return `Funding the mission and the team fee failed (${reason}). Nothing was paid. Retry to try again.`;
    case "mandates": return `The mission and the team fee are funded, but the agents' mandates were not added (${reason}). `
      + "Retry adds only the missing mandates; nothing is paid twice.";
  }
}
