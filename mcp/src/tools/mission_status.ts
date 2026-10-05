import { z } from "zod";
import { getMission } from "@deal/chain";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, plain } from "../access.ts";
import { providerMode, teamProgress, type ProviderMode } from "../progress.ts";

export default defineTool({
  name: "mission_status",
  description:
    "Follow a hired team's mission: the chain's facts (budget, spent, stages approved, closed) and, when DEAL_SITE_URL is set, the team's progress (stage waiting for the human's approval, agents' spends including on-chain refusals, their results, the delivered product hash) plus providerMode: which workers ran the team — \"simulated\" (a labelled Simulated AI demo, no model call), \"anthropic\" (live model) or \"deterministic\" (no AI provider); null when the site did not answer. Approving stages is for the human, in their wallet.",
  input: { mission: z.string() },
  writes: false,
  async run(args, c) {
    if (!isAddress(args.mission)) return badInput("mission must be a mission address.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const m = await getMission(ch.value.ctx, args.mission as never);
    if (!m) return refuse("NOT_FOUND", "No mission at that address.");
    let team: unknown = null;
    let mode: ProviderMode | null = null;
    if (c.config.siteUrl) {
      try {
        const r = await (c.fetch ?? fetch)(new URL(`/api/missions/${args.mission}`, c.config.siteUrl), { headers: { accept: "application/json" } });
        const body = await r.json().catch(() => null);
        team = teamProgress(body) ?? { unavailable: `the site answered ${r.status}` };
        mode = providerMode(body);
      } catch {
        team = { unavailable: "the marketplace site did not answer" };
      }
    }
    return ok({ ...plain(m), team, providerMode: mode });
  },
});
