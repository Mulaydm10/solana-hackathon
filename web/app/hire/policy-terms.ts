// The buyer's budget policy as the hire page creates it (#144): shown and editable before signing, never created
// silently. The program checks every deal and mission the buyer funds against it, and a mission's agents inherit
// its seller list.
import type { Address } from "@solana/kit";
import type { PolicyParamsArgs } from "@deal/chain";

export type PolicyForm = { perDay: string; maxPrice: string; anySeller: boolean };
export const DEFAULT_POLICY: PolicyForm = { perDay: "100", maxPrice: "50", anySeller: true };
/** The program's limit on a policy's allowed sellers. */
export const MAX_SELLERS = 8;

const base = (usdc: string) => {
  const n = Math.round(Number(usdc) * 1e6);
  return Number.isFinite(n) && n > 0 ? BigInt(n) : null;
};
const fmt = (b: bigint) => `${(Number(b) / 1e6).toFixed(2)} USDC`;

/**
 * The InitPolicy params for this hire, or why not. `need` is what this hire spends against the policy today: the
 * mission budget plus the team fee (one deal at the fee's price). Restricted sellers = the team and every payee the
 * agents' mandates name, so the hire still works under the restriction.
 */
export function policyParams(
  f: PolicyForm, buyer: Address, need: { budget: bigint; fee: bigint }, sellers: readonly string[],
): { ok: true; params: PolicyParamsArgs } | { ok: false; message: string } {
  const perDay = base(f.perDay);
  const maxPrice = base(f.maxPrice);
  if (perDay === null || maxPrice === null) return { ok: false, message: "Enter the policy's budget per day and max price in USDC." };
  if (maxPrice > perDay) return { ok: false, message: "The max price per deal can't be more than the budget per day." };
  if (maxPrice < need.fee) return { ok: false, message: `The max price per deal must cover the team fee (${fmt(need.fee)}).` };
  if (perDay < need.budget + need.fee) return { ok: false, message: `The budget per day must cover the mission budget plus the team fee (${fmt(need.budget + need.fee)}).` };
  const allowed = [...new Set(sellers)] as Address[];
  if (!f.anySeller && allowed.length > MAX_SELLERS) return { ok: false, message: `This team pays ${allowed.length} sellers; a policy lists at most ${MAX_SELLERS}. Allow any seller.` };
  return {
    ok: true,
    params: {
      periodSecs: 86_400, periodBudget: perDay, maxPrice, approvalThreshold: 10n ** 15n, approver: buyer,
      allowAnySeller: f.anySeller, allowedSellers: f.anySeller ? [] : allowed,
    },
  };
}
