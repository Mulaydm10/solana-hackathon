// Client for the deal_escrow program. Generated code lives in ./generated (run `npm run codegen`
// after changing the program); this file adds the few helpers surface needs. See contracts/chain.md.
// This entry must stay browser/bundler-safe (web and mcp lanes): no Node built-ins, no file paths.
// Node-only helpers (the program binary path) live in ./node.ts, exported as "@deal/chain/node".
import type { Address } from "@solana/kit";
import { findDealPda } from "./generated/index.ts";

export * from "./generated/index.ts";


/** Deal PDA for (buyer, dealId). */
export async function dealAddress(buyer: Address, dealId: bigint): Promise<Address> {
  const [address] = await findDealPda({ buyer, dealId });
  return address;
}

/** Status names in on-chain order, for display. */
export const STATUS_NAMES = ["Funded", "Delivered", "Released", "Refunded", "Claimed"] as const;

/** Program error names in code order (6000 + index), as in the IDL. */
export const PROGRAM_ERRORS = [
  "ZeroAmount", "DeadlineInPast", "BadReviewWindow", "SelfDeal", "WrongStatus",
  "DeadlinePassed", "DeadlineNotReached", "ReviewWindowOpen", "Unauthorized",
] as const;
export type ProgramErrorName = (typeof PROGRAM_ERRORS)[number];

/** The deal_escrow error behind a failed transaction, if any (walks the Kit error cause chain). */
export function programErrorName(e: unknown): ProgramErrorName | undefined {
  for (let cur = e as { context?: { code?: unknown }; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    const code = cur.context?.code;
    if (typeof code === "number" && code >= 6000 && code < 6000 + PROGRAM_ERRORS.length) return PROGRAM_ERRORS[code - 6000];
  }
  return undefined;
}
