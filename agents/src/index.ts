// One line per module directory (contracts/agents.md layout).
export * from "./pay/index.ts";
export * from "./broker/index.ts";
export * from "./reader/index.ts";
export * from "./custody/index.ts";
export * from "./seller/index.ts";
export * from "./vm/index.ts";
export * from "./team/index.ts";
export * from "./verifier/index.ts";
export * from "./machines/index.ts";
// machines/autonomy.ts also exports `decide` and `Decision`; the root keeps the reader's (machines: @deal/agents/machines).
export { decide, type Decision } from "./reader/index.ts";
