// /hire?team=&goal=&budget= (the link MCP hire_team returns, #216): the form's starting values, validated here.
// Anything invalid is dropped and the form keeps its defaults. Prefilling never signs or submits: the human still
// reviews the terms and signs in their own wallet.
import { isPlainText } from "@deal/core";

export type HirePrefill = { team?: string; goal?: string; budget?: string };

/** Decimal USDC, positive, at most 6 decimals (what MCP's budget_usdc sends). */
const USDC = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function hirePrefill(query: Record<string, string | string[] | undefined>, teams: readonly string[]): HirePrefill {
  const out: HirePrefill = {};
  const team = one(query.team);
  if (team && teams.includes(team)) out.team = team;
  const goal = one(query.goal)?.trim();
  if (goal && goal.length >= 3 && isPlainText(goal, 2000, true)) out.goal = goal;
  const budget = one(query.budget)?.trim();
  if (budget && USDC.test(budget) && Number(budget) > 0) out.budget = budget;
  return out;
}
