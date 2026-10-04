// Node-only helpers for @deal/chain, exported as "@deal/chain/node". Kept out of the main entry
// so bundlers (Next.js on Vercel, the bundled MCP package) never try to resolve the binary.

/** Path of the compiled program, committed so tests and deploys need no Rust toolchain. */
export const PROGRAM_SO = new URL("../program/deal_escrow.so", import.meta.url).pathname;
