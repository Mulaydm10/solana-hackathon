/**
 * The marketplace verifier's rulebook (#108): pass, fail or abstain on a challenged deal, deterministically, so
 * anyone can re-run the same facts and get the same verdict.
 *
 *   Data deal (has a DealLink with an expected delivery hash):
 *     the program already forced the delivery hash to equal the assessed content hash, so the only open question
 *     is the buyer's access (PLAN §4.2): pass if custody released the sealed key to this deal's own buyer.
 *   Service and plain deals:
 *     the delivered bytes must hash to the on-chain delivery hash, be non-trivial, not marked junk, and share a
 *     meaningful word with the task (the same rules as surface/src/verifier.ts, which the demo verifier uses).
 *   Abstain:
 *     whenever a fact can't be had. No verdict lets the resolve window lapse: the timeout refunds the buyer and
 *     returns the seller's stake, which is what the program intends when nobody can tell.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type Verdict =
  | { verdict: "pass"; reason: string }
  | { verdict: "fail"; reason: string; reasons: string[] }
  | { verdict: "abstain"; reason: string };

export type JudgeFacts =
  | {
      kind: "Data";
      /** The deal's on-chain buyer. */
      buyer: string;
      /** Who custody released this deal's key to; null = never released; undefined = custody could not be asked. */
      keyReleasedTo: string | null | undefined;
    }
  | {
      kind: "Service" | "Plain";
      /** The deal's terms task, already checked against the on-chain terms hash; undefined = unknown. */
      task: string | undefined;
      /** On-chain delivery hash, lowercase hex. */
      deliveryHash: string;
      /** The delivered bytes from the delivery store; null = the store has nothing; undefined = store unreachable. */
      content: Uint8Array | null | undefined;
    };

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "under", "within", "hours", "minutes", "usdc", "page", "pages"]);
const MIN_CHARS = 40;
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/** The content rules alone, as reasons (empty = acceptable). */
export function contentReasons(task: string, content: Uint8Array, deliveryHashHex: string): string[] {
  const reasons: string[] = [];
  if (bytesToHex(sha256(content)) !== deliveryHashHex.toLowerCase()) reasons.push("HASH_MISMATCH");
  const text = new TextDecoder().decode(content);
  if (text.trim().length < MIN_CHARS) reasons.push("TOO_SHORT");
  if (/\[junk\]/i.test(text)) reasons.push("MARKED_JUNK");
  const taskWords = words(task);
  if (taskWords.size > 0 && ![...words(text)].some((w) => taskWords.has(w))) reasons.push("OFF_TOPIC");
  return reasons;
}

export function judge(f: JudgeFacts): Verdict {
  if (f.kind === "Data") {
    if (f.keyReleasedTo === undefined) return { verdict: "abstain", reason: "CUSTODY_UNKNOWN" };
    if (f.keyReleasedTo === f.buyer) return { verdict: "pass", reason: "KEY_RELEASED_TO_BUYER" };
    const reason = f.keyReleasedTo === null ? "KEY_NOT_RELEASED" : "KEY_RELEASED_TO_OTHER";
    return { verdict: "fail", reason, reasons: [reason] };
  }
  if (f.task === undefined) return { verdict: "abstain", reason: "TERMS_UNKNOWN" };
  if (f.content === undefined) return { verdict: "abstain", reason: "STORE_UNREACHABLE" };
  // The seller is the one who must make the delivery available; an empty store is the seller's failure.
  if (f.content === null) return { verdict: "fail", reason: "NOT_DELIVERED", reasons: ["NOT_DELIVERED"] };
  const reasons = contentReasons(f.task, f.content, f.deliveryHash);
  return reasons.length === 0 ? { verdict: "pass", reason: "CONTENT_OK" } : { verdict: "fail", reason: reasons[0]!, reasons };
}
