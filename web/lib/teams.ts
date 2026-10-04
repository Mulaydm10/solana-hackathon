// Team blueprints the site can hire (PLAN §8 "Hire a team"). A Team listing's content hash is the blueprint's
// hash (core blueprintHash), so the blueprint here must hash to what the listing commits to on chain; the
// test checks that for every fixture. Amounts are token base units (6-decimal USDC).
import { blueprintHash, type Blueprint } from "@deal/core";

const USDC = 1_000_000n;

const KNOWN: Blueprint[] = [
  // Trip planner
  {
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
];

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Known blueprints keyed by their hash. A Team listing commits to its blueprint through its content hash, so any
 * listing (fixture or on chain, any address) whose content hash is one of these is hireable.
 */
export const TEAM_BLUEPRINTS: Record<string, Blueprint> = Object.fromEntries(KNOWN.map((bp) => [hex(blueprintHash(bp)), bp]));

/** The blueprint a Team listing commits to, if the site knows it. */
export const blueprintFor = (contentHash: string): Blueprint | undefined => TEAM_BLUEPRINTS[contentHash.toLowerCase()];

/** The blueprint as JSON for the mission service (bigints as decimal strings). */
export const toWire = (bp: Blueprint) => JSON.parse(JSON.stringify(bp, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
