/**
 * Buyer side of a per-call payment. PLAN §5 amendment: only for an agent spending its own owner's money
 * (a buyer's own agent, under the buyer's own wallet). Team agents never hold spendable tokens and pay
 * through `agent_spend` / `agent_open_deal` instead.
 *
 * Before anything is signed, the requirements the seller sent are checked in code: the network, the mint,
 * the payee (must be the listing's seller) and the amount (must not exceed the listing price or the cap).
 * A seller cannot raise its own price or redirect the money by changing its 402 response.
 */
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, x402HTTPClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { TransactionSigner } from "@solana/kit";

export type Expect = {
  network: string;
  asset: string;
  /** The listing's seller: the only acceptable `payTo`. */
  payTo: string;
  /** The most this call may cost, token base units (the listing price, or less). */
  maxAmount: bigint;
};

export type PayRefusal = "NO_ACCEPTABLE_REQUIREMENTS" | "NOT_PAYMENT_REQUIRED" | "SIGN_FAILED" | "PAID_CALL_FAILED" | "NETWORK";

export type PaidCall =
  | { ok: true; status: number; body: unknown; charged: boolean; transaction?: string }
  | { ok: false; reason: PayRefusal; message: string; status?: number };

/** Pure: which of the seller's offered requirements this buyer would sign. */
export function acceptable(reqs: readonly PaymentRequirements[], e: Expect): PaymentRequirements[] {
  return reqs.filter((r) => {
    if (r.scheme !== "exact" || r.network !== e.network || r.asset !== e.asset || r.payTo !== e.payTo) return false;
    if (!/^[0-9]{1,20}$/.test(r.amount)) return false;
    const amount = BigInt(r.amount);
    return amount > 0n && amount <= e.maxAmount;
  });
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Call a paid endpoint once. `signer` is the buyer agent's own key. `rpcUrl` is used to build the transfer.
 * Never throws: refusals and failures come back as values.
 */
export async function payAndCall(
  url: string,
  init: RequestInit,
  signer: TransactionSigner,
  expect: Expect,
  opts: { rpcUrl?: string; fetch?: Fetch } = {},
): Promise<PaidCall> {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const client = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: expect.network as `${string}:${string}`, client: new ExactSvmScheme(signer, opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : undefined) }],
      // Our own checks replace the library's USD caps: amounts are compared in base units against the listing.
      spendControls: false,
      policies: [(_v, reqs) => acceptable(reqs, expect)],
    }),
  );
  try {
    const first = await f(url, init);
    if (first.status !== 402) return { ok: false, reason: "NOT_PAYMENT_REQUIRED", message: `expected 402, got ${first.status}`, status: first.status };
    const required = client.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
    if (acceptable(required.accepts, expect).length === 0) {
      return { ok: false, reason: "NO_ACCEPTABLE_REQUIREMENTS", message: "the seller asked for a different payee, mint, network or a higher amount" };
    }
    let headers: Record<string, string>;
    try {
      headers = client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    } catch (e) {
      return { ok: false, reason: "SIGN_FAILED", message: e instanceof Error ? e.message : String(e) };
    }
    const paid = await f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...headers } });
    const body = await paid.json().catch(() => undefined);
    const receipt = paid.headers.get("PAYMENT-RESPONSE");
    const settled = receipt ? decodePaymentResponseHeader(receipt) : undefined;
    if (paid.status < 200 || paid.status > 299) {
      return { ok: false, reason: "PAID_CALL_FAILED", message: `the service answered ${paid.status}; charged: ${settled?.success === true}`, status: paid.status };
    }
    return { ok: true, status: paid.status, body, charged: settled?.success === true, transaction: settled?.transaction };
  } catch (e) {
    return { ok: false, reason: "NETWORK", message: e instanceof Error ? e.message : String(e) };
  }
}
