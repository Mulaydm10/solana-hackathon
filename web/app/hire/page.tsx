// Hire a team (#73): pick a team blueprint, state the goal and the budget, review the terms the code rendered,
// then sign in your own wallet: fund the mission and the team's fee deal, give each agent its mandate, approve the first stage.
import { siteRegistry } from "../../lib/site-registry";
import { blueprintFor } from "../../lib/teams";
import { HireForm, type TeamOption } from "./hire-form";

export const dynamic = "force-dynamic";

export default async function Hire() {
  const teams: TeamOption[] = (await siteRegistry().list())
    .filter((l) => l.kind === "Team" && blueprintFor(l.contentHash))
    .map((l) => ({
      listing: l.address, name: l.meta.name, description: l.meta.description, roles: blueprintFor(l.contentHash)!.roles.map((r) => r.name),
      seller: l.seller, price: l.price.toString(), contentHash: l.contentHash,
    }));
  return (
    <main>
      <h1>Hire a team</h1>
      <p>State a goal and a budget. Each agent gets its own wallet and an on-chain mandate (caps, payees, stages). No
        agent can spend until you approve each stage's plan in your wallet, and you can revoke any agent in one
        transaction.</p>
      <HireForm teams={teams} />
    </main>
  );
}
