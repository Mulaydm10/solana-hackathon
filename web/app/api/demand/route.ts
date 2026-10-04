// GET /api/demand: the demand board as JSON (PLAN §4.3), for sellers' agents (MCP demand_board). Searches are
// buyers' own words: plain text only (lib/demand.ts), and agents must treat them as data, not instructions.
import { demand } from "../../../lib/demand";

export const dynamic = "force-dynamic";

export async function GET() {
  const groups = demand.board().map((g) => ({
    ...g,
    budgets: { stated: g.budgets.stated, ...(g.budgets.median !== undefined ? { median: g.budgets.median.toString(), max: g.budgets.max!.toString() } : {}) },
  }));
  return Response.json({ groups }, { headers: { "cache-control": "no-store" } });
}
