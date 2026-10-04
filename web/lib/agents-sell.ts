// Server-only: the ONLY door from the site to the agents lane (#110). It takes just the seller chain and custody
// modules, not the whole package (no runner, broker, team, x402), and only server code imports this file; the
// e2e leak scan checks that none of it reaches the browser. When agents exports subpaths (@deal/agents/seller,
// @deal/agents/custody), these two lines switch to them.
export { assess, classify, draftTerms, price, type AssessmentReport, type ServiceInput } from "../../agents/src/seller/index.ts";
export { seal, sealedKeyStore, sealKeyTo, createCustody, KEY_RELEASE_STATUSES, type KeyEntry, type Custody, type ReadDeal } from "../../agents/src/custody/index.ts";
