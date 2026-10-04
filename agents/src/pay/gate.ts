/**
 * Seller side of a per-call payment (PLAN §5): x402 `exact` on Solana through a facilitator, with
 * **no answer, no charge**. The order is fixed:
 *   1. no payment header           -> 402 with the payment requirements
 *   2. payment that does not match -> 402, nothing verified, nothing run
 *   3. facilitator verify fails    -> 402, the seller's code never runs
 *   4. the seller's code runs
 *   5. no valid answer (throw, non-2xx, or the body fails `isValid`) -> the payment is NEVER settled
 *   6. only now settle; if settlement fails the answer is withheld (the seller was not paid)
 * Framework-agnostic: give it a header getter, get back status, headers and body.
 */
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

export type Accepts = {
  scheme: "exact";
  /** CAIP-2, e.g. `SOLANA_DEVNET` below. */
  network: `${string}:${string}`;
  /** The seller's wallet (token owner), base58. */
  payTo: string;
  /** Token base units and mint; never a USD string, so no conversion happens behind our back. */
  amount: bigint;
  asset: string;
  maxTimeoutSeconds?: number;
};

export type Resource = { url: string; description?: string; mimeType?: string };

/** What the seller's code returns. */
export type Answer = { status: number; body: unknown };

export type GateReason =
  | "PAYMENT_REQUIRED"
  | "BAD_PAYMENT_HEADER"
  | "NO_MATCHING_REQUIREMENTS"
  | "VERIFY_FAILED"
  | "HANDLER_FAILED"
  | "INVALID_ANSWER"
  | "SETTLE_FAILED";

export type GateResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** True only when the facilitator reported a successful settlement. */
  charged: boolean;
  reason?: GateReason;
  /** Settlement transaction signature when charged. */
  transaction?: string;
};

export const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type PayGate = {
  /** Requirements as the facilitator completes them (the SVM fee payer comes from it). */
  requirements(): Promise<PaymentRequirements[]>;
  handle(
    header: (name: string) => string | undefined,
    run: () => Promise<Answer>,
    isValid: (body: unknown) => boolean,
  ): Promise<GateResponse>;
};

/** `server` must be initialized (`await server.initialize()`) with the scheme registered for `accepts.network`. */
export function createPayGate(server: x402ResourceServer, accepts: Accepts, resource: Resource): PayGate {
  let cached: PaymentRequirements[] | undefined;
  const requirements = async () =>
    (cached ??= await server.buildPaymentRequirements({
      scheme: accepts.scheme,
      network: accepts.network,
      payTo: accepts.payTo,
      price: { amount: accepts.amount.toString(), asset: accepts.asset },
      maxTimeoutSeconds: accepts.maxTimeoutSeconds ?? 60,
    }));

  const required = async (reason: GateReason, error?: string): Promise<GateResponse> => {
    const pr = await server.createPaymentRequiredResponse(await requirements(), resource, error);
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }, body: pr, charged: false, reason };
  };

  return {
    requirements,
    async handle(header, run, isValid) {
      const raw = header(PAYMENT_SIGNATURE) ?? header(PAYMENT_SIGNATURE.toLowerCase());
      if (!raw) return required("PAYMENT_REQUIRED");

      let payload: PaymentPayload;
      try {
        payload = decodePaymentSignatureHeader(raw);
      } catch {
        return required("BAD_PAYMENT_HEADER", "payment header does not decode");
      }
      const match = server.findMatchingRequirements(await requirements(), payload);
      if (!match) return required("NO_MATCHING_REQUIREMENTS", "payment does not match what this route accepts");

      let verified: { isValid: boolean; invalidReason?: string };
      try {
        verified = await server.verifyPayment(payload, match);
      } catch (e) {
        verified = { isValid: false, invalidReason: e instanceof Error ? e.message : String(e) };
      }
      if (!verified.isValid) return required("VERIFY_FAILED", verified.invalidReason ?? "payment not valid");

      // The payment is verified but not settled: from here on, a failure costs the buyer nothing.
      let answer: Answer;
      try {
        answer = await run();
      } catch {
        return { status: 502, headers: {}, body: { error: "the service failed; you were not charged" }, charged: false, reason: "HANDLER_FAILED" };
      }
      if (answer.status < 200 || answer.status > 299 || !isValid(answer.body)) {
        return { status: 502, headers: {}, body: { error: "the service gave no valid answer; you were not charged" }, charged: false, reason: "INVALID_ANSWER" };
      }

      let settled: { success: boolean; transaction: string; errorReason?: string };
      try {
        settled = await server.settlePayment(payload, match);
      } catch (e) {
        settled = { success: false, transaction: "", errorReason: e instanceof Error ? e.message : String(e) };
      }
      if (!settled.success) return required("SETTLE_FAILED", settled.errorReason ?? "settlement failed");
      return {
        status: answer.status,
        headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled as never) },
        body: answer.body,
        charged: true,
        transaction: settled.transaction,
      };
    },
  };
}
