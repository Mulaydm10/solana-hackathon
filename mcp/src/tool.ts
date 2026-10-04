// The shape every tool follows. Adding a capability = one file in src/tools/ that default-exports
// defineTool({...}) plus one line in src/tools/index.ts (a test fails if that line is forgotten).
import type { z } from "zod";
import type { TransactionSigner } from "@solana/kit";
import type { DealContext } from "@deal/chain";
import type { Config } from "./config.ts";

/** Tools never throw for expected outcomes: a refusal is a normal result carrying a reason code. */
export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string; message: string };

/** The chain as a tool sees it: the deal library's context and the agent's own signer (null = read-only). */
export type ChainAccess = { ctx: DealContext; signer: TransactionSigner | null };

export type ToolContext = {
  config: Config;
  /** Opened on first use by the server; tests inject a LiteSVM one. Absent = offline. */
  chain?: () => Promise<ChainAccess>;
  /** HTTP to the marketplace site (injectable for tests). */
  fetch?: typeof fetch;
};

export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ToolDef<S extends z.ZodRawShape> = {
  /** snake_case, unique. */
  name: string;
  /** What the tool does and when an agent should use it. */
  description: string;
  input: S;
  /** true if the tool can move funds or change chain state (shown to MCP clients as a hint). */
  writes: boolean;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

export function defineTool<S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

export const ok = (data: Record<string, unknown>): ToolResult => ({ ok: true, data });
export const refuse = (reason: string, message: string): ToolResult => ({ ok: false, reason, message });
