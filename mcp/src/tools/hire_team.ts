import { z } from "zod";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, usdcToBase } from "../access.ts";

/**
 * Hiring a team is the human's decision: this tool only prepares the link. Funding the mission, the agents'
 * mandates and every stage approval are signed in the human's own wallet on the site, never by an agent.
 */
export default defineTool({
  name: "hire_team",
  description:
    "Prepare hiring an agent team for a goal: returns a link the human must open to review the terms and sign (fund, mandates, stage approvals). This tool signs nothing and cannot approve anything.",
  input: { team: z.string(), goal: z.string().min(3).max(2000), budget_usdc: z.string() },
  writes: false,
  async run(args, c) {
    if (!isAddress(args.team) || typeof args.goal !== "string" || args.goal.length < 3 || usdcToBase(args.budget_usdc) === null) {
      return badInput("team must be a team listing address, goal 3-2000 characters, budget_usdc decimal USDC.");
    }
    if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Set DEAL_SITE_URL to the marketplace site.");
    const u = new URL("/hire", c.config.siteUrl);
    u.searchParams.set("team", args.team);
    u.searchParams.set("goal", args.goal);
    u.searchParams.set("budget", args.budget_usdc);
    return ok({ approvalUrl: u.toString(), note: "A human must open this link and sign in their own wallet." });
  },
});
