/**
 * The verifier service (#108): every challenge needs the deal's independent verifier to rule, and the marketplace
 * names its own verifier on the deals it opens. Each tick lists the Challenged deals that name our key, reads the
 * facts (chain first, then custody and the delivery store, each injected), judges them, and sends `resolve` once
 * per deal through the deal library (safeSend: an uncertain send is settled by reading the chain, never by sending
 * twice). An abstain sends nothing, so the resolve window lapses into NoVerdict.
 *
 * The verifier's key is a TransactionSigner held in this closure. It is never returned, logged or put in a ruling.
 */
import type { Address, Base58EncodedBytes, GetProgramAccountsApi, Rpc, TransactionSigner } from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DEAL_ESCROW_PROGRAM_ADDRESS, STATUS_NAMES, deals, fetchMaybeDealLink, findLinkPda, getDeal, getDealSize, readWithRetry, type DealContext, type DealView, type Refusal } from "@deal/chain";
import { judge, type JudgeFacts, type Verdict } from "./judge.ts";

/** Byte offsets in a Deal account: discriminator (8) + buyer, seller, mint (32 each) = 104; status after the fixed fields. */
export const DEAL_VERIFIER_OFFSET = 104;
export const DEAL_STATUS_OFFSET = 308;

/** Where the off-chain facts come from. A source that throws counts as "can't be had" (abstain). */
export type FactSources = {
  /** The wallet custody sealed this deal's key to, or null if it never released one. */
  keyReleasedTo(deal: Address, buyer: Address): Promise<string | null>;
  /** The canonical terms JSON (core `canonicalJson`) whose sha256 is the deal's on-chain terms hash; null if unknown. */
  terms(deal: Address, termsHashHex: string): Promise<string | null>;
  /** The delivered bytes for this deal, or null if the store has none. */
  content(deal: Address, deliveryHashHex: string): Promise<Uint8Array | null>;
};

export type Ruling = {
  deal: Address;
  kind: JudgeFacts["kind"];
  verdict: Verdict;
  /** Absent for an abstain (nothing sent). */
  sent?: { ok: true; signature: string } | Refusal;
};

export type VerifierOptions = {
  ctx: DealContext;
  /** The marketplace verifier's key: the deals name its address. */
  verifier: TransactionSigner;
  sources: FactSources;
  /** Challenged deals naming this verifier. Default: `challengedDealsFor` over the context's RPC. */
  listChallenged?: () => Promise<Address[]>;
  log?: (line: string) => void;
};

type ProgramAccountsRpc = Rpc<GetProgramAccountsApi>;

/** Challenged deals that name `verifier`, straight from the program's accounts (two memcmp filters, one size filter). */
export async function challengedDealsFor(rpc: ProgramAccountsRpc, verifier: Address): Promise<Address[]> {
  const challenged = STATUS_NAMES.indexOf("Challenged");
  const accounts = await rpc
    .getProgramAccounts(DEAL_ESCROW_PROGRAM_ADDRESS, {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: BigInt(getDealSize()) },
        { memcmp: { offset: BigInt(DEAL_VERIFIER_OFFSET), bytes: verifier as unknown as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: BigInt(DEAL_STATUS_OFFSET), bytes: base58Byte(challenged), encoding: "base58" } },
      ],
    })
    .send();
  return accounts.map((a) => a.pubkey);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A single byte in base58 (for a one-byte memcmp): 0 -> "1", 1..57 -> one digit, larger -> two. */
function base58Byte(b: number): Base58EncodedBytes {
  const s = b === 0 ? "1" : b < 58 ? B58[b]! : B58[Math.floor(b / 58)]! + B58[b % 58]!;
  return s as Base58EncodedBytes;
}

const ZERO32 = "0".repeat(64);
const attempt = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await f();
  } catch {
    return undefined;
  }
};

/** The facts for one deal, or null when it is not a Challenged deal naming this verifier (nothing to rule). */
export async function gatherFacts(ctx: DealContext, verifier: Address, deal: Address, sources: FactSources): Promise<{ view: DealView; facts: JudgeFacts } | null> {
  const view = await getDeal(ctx, deal);
  if (!view || view.status !== "Challenged" || view.verifier !== verifier) return null;
  const link = await readWithRetry(ctx, async () => fetchMaybeDealLink(ctx.client.rpc, (await findLinkPda({ deal }))[0]));
  // Only Data listings set an expected delivery hash, so this holds even after the listing was closed.
  if (link.exists && bytesToHex(Uint8Array.from(link.data.expectedDeliveryHash)) !== ZERO32) {
    const released = await attempt(() => sources.keyReleasedTo(deal, view.buyer));
    return { view, facts: { kind: "Data", buyer: view.buyer, keyReleasedTo: released } };
  }
  const termsJson = await attempt(() => sources.terms(deal, view.termsHash));
  const task = termsJson && bytesToHex(sha256(new TextEncoder().encode(termsJson))) === view.termsHash ? taskOf(termsJson) : undefined;
  const content = await attempt(() => sources.content(deal, view.deliveryHash));
  return { view, facts: { kind: link.exists ? "Service" : "Plain", task, deliveryHash: view.deliveryHash, content } };
}

function taskOf(termsJson: string): string | undefined {
  try {
    const t = JSON.parse(termsJson) as { task?: unknown };
    return typeof t.task === "string" ? t.task : undefined;
  } catch {
    return undefined;
  }
}

/** Refusals worth another try on the next tick; anything else (a program refusal) is final. */
const RETRYABLE = new Set(["RATE_LIMITED", "RPC_UNAVAILABLE", "CONFIRMATION_TIMEOUT", "CHAIN_ERROR"]);

export function createVerifierService(o: VerifierOptions) {
  const me = o.verifier.address;
  const list = o.listChallenged ?? (() => challengedDealsFor(o.ctx.client.rpc as unknown as ProgramAccountsRpc, me));
  const log = o.log ?? (() => {});
  const settled = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  /** One pass over the challenged deals. Each deal is resolved at most once by this service. */
  async function tick(): Promise<Ruling[]> {
    const rulings: Ruling[] = [];
    for (const deal of await list()) {
      if (settled.has(deal)) continue;
      const got = await gatherFacts(o.ctx, me, deal, o.sources);
      if (!got) continue;
      const verdict = judge(got.facts);
      const ruling: Ruling = { deal, kind: got.facts.kind, verdict };
      if (verdict.verdict !== "abstain") {
        ruling.sent = await deals.resolve(o.ctx, o.verifier, deal, verdict.verdict === "pass");
        if (ruling.sent.ok || !RETRYABLE.has(ruling.sent.reason)) settled.add(deal);
      }
      log(`verifier: ${deal} ${got.facts.kind} ${verdict.verdict} (${verdict.reason})${ruling.sent ? ` -> ${ruling.sent.ok ? ruling.sent.signature : ruling.sent.reason}` : ""}`);
      rulings.push(ruling);
    }
    return rulings;
  }

  return {
    address: me,
    tick,
    /** Ticks every `intervalMs` until stopped; one tick at a time. */
    start(intervalMs = 30_000) {
      running = true;
      const loop = async () => {
        try {
          await tick();
        } catch (e) {
          log(`verifier: tick failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
        }
        if (running) timer = setTimeout(loop, intervalMs);
      };
      void loop();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
