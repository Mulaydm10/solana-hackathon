// Team blueprints the site can hire (PLAN §8 "Hire a team"). A Team listing's content hash is the blueprint's
// hash (core blueprintHash), so the blueprint here must hash to what the listing commits to on chain; the
// test checks that for every fixture. Amounts are token base units (6-decimal USDC).
import type { Blueprint } from "@deal/core";

const USDC = 1_000_000n;

export const TEAM_BLUEPRINTS: Record<string, Blueprint> = {
  // Trip planner (registry fixture listing 9sA4TripPlanner...)
  "9sA4TripPlannerTeamListingAddr4444444444444": {
    version: 1,
    name: "Trip planner",
    roles: [
      { name: "researcher", purpose: "Finds options and prices for the trip", capabilities: ["market:read"], cap: 5n * USDC, perTxCap: 2n * USDC },
      { name: "writer", purpose: "Writes the day-by-day plan", capabilities: [], cap: 1n * USDC, perTxCap: 1n * USDC },
    ],
    stages: [
      { name: "Research", roles: ["researcher"], cap: 5n * USDC, gate: "human" },
      { name: "Write the plan", roles: ["writer"], cap: 1n * USDC, gate: "human" },
    ],
    deliverable: { description: "A day-by-day trip plan", check: "sha256" },
    maxDuration: 604_800,
  },
};

/** The blueprint as JSON for the mission service (bigints as decimal strings). */
export const toWire = (bp: Blueprint) => JSON.parse(JSON.stringify(bp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
