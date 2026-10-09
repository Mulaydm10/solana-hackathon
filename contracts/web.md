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

## Machines v2 (#273 server, #274 page; plan: docs/handoffs/peaq-v2-plan.md; add only)

- **Tick (#273)**, same route and auth. Order per tick: (1) each online pad signs a heartbeat (stored, verified on read);
  (2) `insuranceStep` for each pad's current policy (a new daily policy is quoted when none is active); (3) `planJob`
  → `runJob` (a delivery drains the battery); (4) the robot decides; on "charge", `choosePad` (or `choosePadWithModel`
  with a model key) picks the pad and the existing charge path pays it. Scores are recomputed from peaq logs at most
  once per tick and cached in the blob store. Each step's failure is recorded and does not stop the next.
- `POST /api/machines/power` body `{ pad: "<role>", online: boolean }`, same Bearer secret as the tick: the owner's
  simulated power switch (an offline pad stops signing heartbeats). Never public.
- New server env: `PAD2_KEY`, `PAD3_KEY`, `PAD_PEAQ_KEYS` (JSON role → peaq key), `INSURER_KEY`, `SHOP_KEY`,
  `MACHINE_NETWORK` (JSON from state.json `network`), `INSURANCE_VERIFIER` (address). Missing: v1 behaviour continues
  and the page says which part is not configured.
- `GET /api/machines/status` adds (all amounts as decimal USDC strings):
  `network: [{ role, name, machineId, pricePerKwh, online, lastHeartbeatAt, upPct24h, score, grade, provisioned }]`,
  `scores: { [role]: MachineScore }` (robot included), `insurance: { policies: Policy[] }` (last 10, amounts as strings),
  `earnings: { jobs, earned, spentOnEnergy, net, recent: [{ id, at, amount, deal, releaseSig, robotEventTx }] }`,
  and on decisions `chosenPad?`, `choiceReason?`, `choiceBy?`.
- **Page (#274)**: "The network" (one card per pad: price, MCR-style grade + score + top factors, uptime 24 h,
  online/offline, last heartbeat), "Insurance" (each policy: coverage, premium and the grade that priced it, term,
  status, a timeline with Solana links for open / premium / claim / payout or refund and the outage peaq event), "The
  robot's earnings" (earned vs spent on energy, recent jobs with links), and on each charge "chose <pad> because …".
  Labels: "MCR-style score, computed by Fiducia from peaq events (peaq's own rating is not served on testnet)";
  outages and deliveries say "simulated". Status fixture for tests: `web/test/fixtures/machines-status-v2.json`.
