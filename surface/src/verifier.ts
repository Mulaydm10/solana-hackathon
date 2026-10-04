// The demo verifier: an independent party (its own key, never buyer or seller) that decides a
// challenge. It only judges the exact bytes the seller committed to on chain: if the delivery does
// not hash to the on-chain delivery hash, it fails. The content check is deterministic so anyone can
// re-run it: non-trivial length, not marked junk, and on topic (shares a meaningful word with the task).
import { createHash } from "node:crypto";

export type Verdict = { ok: boolean; reasons: string[] };

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "under", "within", "hours", "minutes", "usdc", "page", "pages"]);

export function judge(task: string, content: string, onChainHashHex: string): Verdict {
  const reasons: string[] = [];
  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== onChainHashHex) reasons.push("HASH_MISMATCH");
  if (content.trim().length < 40) reasons.push("TOO_SHORT");
  if (/\[junk\]/i.test(content)) reasons.push("MARKED_JUNK");
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);
  const taskWords = words(task);
  if (taskWords.size > 0 && ![...words(content)].some((w) => taskWords.has(w))) reasons.push("OFF_TOPIC");
  return { ok: reasons.length === 0, reasons };
}
