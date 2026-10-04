// Client for the deal_escrow program. Generated code lives in ./generated (run `npm run codegen`
// after changing the program); this file adds the few helpers surface needs. See contracts/chain.md.
// This entry must stay browser/bundler-safe (web and mcp lanes): no Node built-ins, no file paths.
// Node-only helpers (the program binary path) live in ./node.ts, exported as "@deal/chain/node".
import type { Address } from "@solana/kit";
import { findPolicyPda, findDealPda } from "./generated/index.ts";
import idl from "../program/deal_escrow.json" with { type: "json" };

export * from "./generated/index.ts";


/** Deal PDA for (buyer, dealId). */
export async function dealAddress(buyer: Address, dealId: bigint): Promise<Address> {
  const [address] = await findDealPda({ buyer, dealId });
  return address;
}

/** Buyer policy PDA. */
export async function policyAddress(buyer: Address): Promise<Address> {
  const [address] = await findPolicyPda({ buyer });
  return address;
}

/** Status names in on-chain order, for display (read from the IDL so they cannot drift). */
export const STATUS_NAMES: readonly string[] = (
  idl.types.find((t) => t.name === "DealStatus")!.type as { variants: { name: string }[] }
).variants.map((v) => v.name);

/** Program error names in code order (6000 + index), as in the IDL. */
export const PROGRAM_ERRORS: readonly string[] = idl.errors.map((e) => e.name);
export type ProgramErrorName = string;

/** The deal_escrow error behind a failed transaction, if any (walks the Kit error cause chain). */
export function programErrorName(e: unknown): ProgramErrorName | undefined {
  for (let cur = e as { context?: { code?: unknown }; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    const code = cur.context?.code;
    if (typeof code === "number" && code >= 6000 && code < 6000 + PROGRAM_ERRORS.length) return PROGRAM_ERRORS[code - 6000]!;
  }
  return undefined;
}

export * from "./deals.ts";
export { isRateLimited, isTransient } from "./retry.ts";
