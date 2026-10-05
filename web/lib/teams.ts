// Team blueprints the site can hire (PLAN §8 "Hire a team"). A Team listing's content hash is the blueprint's
// hash (core blueprintHash), so the blueprint here must hash to what the listing commits to on chain; the
// test checks that for every fixture. Amounts are token base units (6-decimal USDC).
import { blueprintHash, type Blueprint } from "@deal/core";

const USDC = 1_000_000n;

/** The devnet data seller the Trip planner researcher buys market data from (its listings are on chain). */
export const TRIP_DATA_SELLER = "CntPDGuHGHnpG24n6SmZUjTfqdwa6SpPfWUZjiX9CjHR";

/**
 * Earlier Trip planner blueprints (deterministic workers, researcher cap 5). Kept byte-for-byte so a Team listing
 * still committed to their hash stays hireable until it is updated; never offered for new listings.
 */
const legacyTripPlanner = (researcher: Pick<Blueprint["roles"][number], "payees">): Blueprint => ({
  version: 1,
  name: "Trip planner",
  roles: [
    { name: "researcher", purpose: "Finds options and prices for the trip", capabilities: ["market:read"], cap: 5n * USDC, perTxCap: 2n * USDC, ...researcher },
    { name: "writer", purpose: "Writes the day-by-day plan", capabilities: [], cap: 1n * USDC, perTxCap: 1n * USDC },
  ],
  stages: [
    { name: "Research", roles: ["researcher"], cap: 5n * USDC, gate: "human" },
    { name: "Write the plan", roles: ["writer"], cap: 1n * USDC, gate: "human" },
  ],
  deliverable: { description: "A day-by-day trip plan", check: "sha256" },
  maxDuration: 604_800,
});

/**
 * The Trip planner the site hires (#220), the same team as the recorded CLI demo (demo-mission.ts): both agents may
 * call the model through the broker (llm:complete; the labelled Simulated AI demo when AI_PROVIDER=simulated), the
 * researcher may pay the data seller up to 3 USDC (2 per payment), and the writer pays no one (least privilege).
 */
export const TRIP_PLANNER: Blueprint = {
  version: 1,
  name: "Trip planner",
  roles: [
    { name: "researcher", purpose: "Researches the trip and buys one dataset", capabilities: ["market:read", "llm:complete"], cap: 3n * USDC, perTxCap: 2n * USDC, payees: [TRIP_DATA_SELLER] },
    { name: "writer", purpose: "Writes the day-by-day plan", capabilities: ["llm:complete"], cap: 1n * USDC, perTxCap: 1n * USDC },
  ],
  stages: [
    { name: "Research", roles: ["researcher"], cap: 3n * USDC, gate: "human" },
    { name: "Write the plan", roles: ["writer"], cap: 1n * USDC, gate: "human" },
  ],
  deliverable: { description: "A day-by-day trip plan", check: "sha256" },
  maxDuration: 604_800,
};

const KNOWN: Blueprint[] = [
  TRIP_PLANNER,
  // Earlier versions, while a devnet Team listing may still commit to them (remove once none does).
  legacyTripPlanner({ payees: [TRIP_DATA_SELLER] }),
  legacyTripPlanner({}),
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
