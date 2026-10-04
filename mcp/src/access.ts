// Small helpers shared by the tools (kept outside src/tools, which holds only registered tools).
import type { TransactionSigner } from "@solana/kit";
import { ADDRESS, refuse, type ChainAccess, type ToolContext, type ToolResult } from "./tool.ts";

export type Need<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

export async function needChain(ctx: ToolContext): Promise<Need<ChainAccess>> {
  if (!ctx.chain) return { ok: false, result: refuse("NOT_CONNECTED", "This server has no chain connection.") };
  return { ok: true, value: await ctx.chain() };
}

export function needSigner(c: ChainAccess): Need<TransactionSigner> {
  if (!c.signer) return { ok: false, result: refuse("NO_SIGNER", "Set DEAL_KEYPAIR to the agent's own keypair file to use tools that sign.") };
  return { ok: true, value: c.signer };
}

export const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS.test(v);
export const badInput = (what: string) => refuse("BAD_INPUT", what);

/** "12.5" USDC -> 12_500_000n base units; null if malformed. */
export function usdcToBase(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d{1,12}(\.\d{1,6})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export const isHex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Plain JSON for a tool result (bigints as decimal strings). */
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;

const CLOCK = "SysvarC1ock11111111111111111111111111111111";

/** The chain's own clock (unix seconds) from the Clock sysvar; deadlines are judged by it, not by this machine. */
export async function chainNow(c: ChainAccess): Promise<number> {
  const rpc = c.ctx.client.rpc as unknown as { getAccountInfo(a: string, o: { encoding: "base64" }): { send(): Promise<{ value: { data: [string, string] } | null }> } };
  const info = await rpc.getAccountInfo(CLOCK, { encoding: "base64" }).send();
  const b64 = info.value?.data?.[0];
  if (!b64) return Math.floor(Date.now() / 1000);
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return Number(new DataView(bytes.buffer).getBigInt64(32, true)); // slot, epoch_start_ts, epoch, leader_epoch, unix_ts
}
