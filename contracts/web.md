# web - contract

Public marketplace site, deployed on Vercel. Infrastructure only for now; features come in later issues.

- Buyers sign every buyer-side transaction with their own wallet (Wallet Standard, e.g. Phantom on devnet).
  The site never holds buyer keys.
- Server routes (Vercel functions) hold only what must be server-side: the drafting model key and the
  verifier key. Secrets come from Vercel environment variables, never from the repo.
- Uses `@deal/core` (terms) and `@deal/chain` (program client) through their browser-safe entry points.
- Verify: `npm test --prefix web` (unit tests + a production build).

## Registry (the one data interface for pages, API routes and the MCP package)

From #99/#105 (`web/lib/registry.ts`). Fixtures implement it today; the `@deal/chain` implementation follows the
devnet upgrade, behind the same interface.

```ts
interface Registry {
  list(): Promise<RegistryListing[]>;               // active listings only
  get(address: string): Promise<RegistryListing | null>;
}

type RegistryListing = {
  address: string; seller: string; kind: "Data" | "Service" | "Team"; mint: string;
  price: bigint;                 // token base units; per call for a Service
  contentHash: string;           // sha256 hex
  meta: ListingMeta;             // core listing.ts, seller-written, bound by meta_hash: display only, always quoted
  report: AttestedReport | null; // null until a registered assessor attests
  active: boolean;
  sales: number;                 // statistic only (can be under-counted), never for ranking
  rep: RepCounts;                // core rep.ts, from SellerRep in this mint
  createdAt: number;
};

type AttestedReport = {
  grade: "A" | "B" | "C" | "D";  // from the assessor's report, verified against Listing.report_hash
  reportHash: string; assessor: string; assessedAt: number; ageDays?: number; containsPersonalData: boolean;
};
```

Rules: grade, quality and trust shown anywhere come from `report` and `rep`, never from `meta`. The chain
implementation drops any listing whose stored metadata or report JSON does not hash to `meta_hash` / `report_hash`.
Seller-written text may be matched for search but must never outrank verified signals on its own.

## Machines page (#229, peaq track; add only)

`/machines` shows one loop: a simulated delivery robot pays a simulated charging pad on devnet, settled on a signed
meter reading, with peaq events for both machines. It reuses `@deal/agents` `machines/` (contracts/agents.md); the
existing site, `/hire`, "Try the demo" and `DEMO_BUYER_KEY` are untouched.

- Routes: `app/machines/page.tsx`, `POST app/api/machines/charge` (Node runtime), `GET app/api/machines/status`.
- Server-only env (capability `machines`, devnet only): `ROBOT_AGENT_KEY`, `PAD_KEY`, `MACHINE_MISSION`,
  `PEAQ_EVENT_KEY`, `PEAQ_RPC_URL`, `PEAQ_DEPLOYMENT`, `PEAQ_EVENT_REGISTRY`, `PEAQ_SOURCE_CHAIN_ID` (`0`: self-reported events),
  `ROBOT_MACHINE_ID`, `PAD_MACHINE_ID`; optional `PEAQ_EXPLORER_TX_URL`. Any missing: the page says "machine demo
  not configured" and the routes refuse (fail closed). No key or RPC secret in a response, log or the client bundle.
- The fleet mission's owner key is never on the server: the owner sets the robot's rules once, offline
  (`agents/scripts/machines/`, #228); the site only needs the mission address (`MACHINE_MISSION`).
- Every machine transaction is simulated first and sent only if the simulation passes (the default client still
  sends after a failed estimate), so a refusal never lands on chain. The robot pays the fees.
- The peaq SDK is a runtime external (`serverExternalPackages`), never bundled, and never in the client bundle.
- `POST /api/machines/charge` body `{ amount: "0.40" | "0.60" }` only. 0.60 is the over-limit case: it is simulated,
  never sent, and returns the program's refusal code. Per-IP and daily limits as in `lib/demo.ts`.
- Rules, totals and MCR are read (chain, peaq), never hard-coded. An MCR rise is shown only if the MCR API reports it.
- `NAV` gets one appended entry `{ href: "/machines", label: "Machines" }`.

## The robot charges on its own (#253, #255; add only)

- `POST /api/machines/tick`: `Authorization: Bearer $MACHINE_TICK_SECRET` (server env, >= 32 chars, compared in
  constant time); 401 wrong secret, 503 `NOT_CONFIGURED` when the secret or the machines env is missing. Driven by the
  mission service (#257), not a Vercel Cron (Hobby allows one per day).
- One tick per time slot (`floor(now / 30 min)`, idempotent, serialized); at most one charge per tick. Steps: load the
  simulated battery from Blob (first tick: 60 %), `advance()`, read the robot's mandate from chain, `decide()` (or
  `decideWithModel()` when a model key is set, #255), and on `charge` run the existing simulate-first charge for the
  decided amount through an internal path. The public `POST /api/machines/charge` still accepts only "0.40" / "0.60".
  On success `afterCharge()`. Every decision goes to a decision log in Blob (last 30): `{ at, action, kWh?, amount?,
  reason, by: "robot" | "claude" | "simulated", chargeId? }`.
- `GET /api/machines/status` adds `battery: { levelPct, updatedAt, simulated: true }` and `decisions` (last 10).
  `ChargeView` adds `by?: "visitor" | "robot"`.
- `/machines`: a battery gauge labelled simulated, the last decision and its reason, and "decided by the robot" on
  autonomous charges. Model text (#255) is shown only as escaped, quoted text.
