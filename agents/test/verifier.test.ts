// The marketplace verifier (#108) on the real program in LiteSVM: pass, fail and abstain for Data, Service and
// plain deals, ending in VerifiedPass, VerifiedFail and NoVerdict on chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createClient, createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress, lamports,
  type Address, type KeyPairSigner,
} from "@solana/kit";
import { litesvm } from "@solana/kit-plugin-litesvm";
import { airdropSigner, generatedSigner } from "@solana/kit-plugin-signer";
import { getCreateMintInstructionPlan, getMintToATAInstructionPlanAsync } from "@solana-program/token";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  DEAL_ESCROW_PROGRAM_ADDRESS, DealStatus, STATUS_NAMES, deals, getDeal, getDealEncoder, getInitPolicyInstructionAsync, getSetAssessorsInstructionAsync,
  listings, type DealClient, type DealContext,
} from "@deal/chain";
import { PROGRAM_SO } from "@deal/chain/node";
import { canonicalJson, type DealTerms } from "@deal/core";
import { DEAL_STATUS_OFFSET, DEAL_VERIFIER_OFFSET, createVerifierService, judge, type FactSources } from "../src/index.ts";

const USDC = 1_000_000n;
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const PRICE = 5n * USDC;
const enc = new TextEncoder();
const GOOD = "EURUSD weekly forecast: the euro is expected to trade between 1.08 and 1.10 against the dollar.";
const TASK = "Weekly EURUSD forecast with a trading range";

async function chain() {
  const client = await createClient().use(generatedSigner()).use(litesvm()).use(airdropSigner(lamports(10_000_000_000n)));
  client.svm.addProgramFromFile(DEAL_ESCROW_PROGRAM_ADDRESS, PROGRAM_SO);
  const clock = client.svm.getClock();
  clock.unixTimestamp = 1_800_000_000n;
  client.svm.setClock(clock);
  const buyer = client.payer;
  const [seller, assessor, mint] = (await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()))) as [KeyPairSigner, KeyPairSigner, KeyPairSigner];
  // A known secret, so the test can look for it in everything the service emits.
  const seed = new Uint8Array(randomBytes(32));
  const secret = new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);
  const verifier = await createKeyPairSignerFromBytes(secret);
  for (const s of [seller, assessor, verifier]) client.svm.airdrop(s.address, lamports(1_000_000_000n));
  await client.sendTransaction(await getCreateMintInstructionPlan(client, { payer: buyer, newMint: mint, decimals: 6, mintAuthority: buyer.address }));
  for (const [owner, amount] of [[buyer.address, 200n * USDC], [seller.address, 50n * USDC]] as const) {
    await client.sendTransaction(await getMintToATAInstructionPlanAsync({ payer: buyer, owner, mint: mint.address, mintAuthority: buyer, amount, decimals: 6 }));
  }
  await client.sendTransaction([
    await getInitPolicyInstructionAsync({
      buyer, mint: mint.address,
      params: { periodSecs: 86_400, periodBudget: 400n * USDC, maxPrice: 50n * USDC, approvalThreshold: 100n * USDC, approver: buyer.address, allowAnySeller: false, allowedSellers: [seller.address] },
    }),
  ]);
  // Assessor registry: LiteSVM loads the program non-upgradeable, so its ProgramData is written directly (as in chain's harness).
  const [programData] = await getProgramDerivedAddress({ programAddress: LOADER_V3, seeds: [getAddressEncoder().encode(DEAL_ESCROW_PROGRAM_ADDRESS)] });
  const pd = new Uint8Array(45);
  pd.set([3, 0, 0, 0], 0);
  pd[12] = 1;
  pd.set(getAddressEncoder().encode(buyer.address), 13);
  client.svm.setAccount({ address: programData, data: pd, executable: false, lamports: lamports(1_000_000_000n), programAddress: LOADER_V3, space: 45n });
  await client.sendTransaction([await getSetAssessorsInstructionAsync({ authority: buyer, programData, assessors: [assessor.address] })]);

  const sending: DealClient = {
    rpc: (client as unknown as DealClient).rpc,
    sendTransaction: (ixs) => { client.svm.expireBlockhash(); return (client as unknown as DealClient).sendTransaction(ixs); },
  };
  const ctx: DealContext = { client: sending, mint: mint.address, sleep: async () => {} };
  const now = () => client.svm.getClock().unixTimestamp;
  const warp = (secs: bigint) => {
    const c = client.svm.getClock();
    c.unixTimestamp += secs;
    client.svm.setClock(c);
    client.svm.expireBlockhash();
  };
  return { client, ctx, buyer, seller, assessor, verifier, secret, now, warp };
}

type Chain = Awaited<ReturnType<typeof chain>>;
type Kind = "Data" | "Service" | "Plain";
let nextId = 1n;

/** Opens, accepts, delivers and challenges one deal naming the verifier; returns the deal and its off-chain records. */
async function challengedDeal(c: Chain, kind: Kind, delivered: Uint8Array) {
  const dealId = nextId++;
  const terms: DealTerms = {
    template: "pay_on_delivery", buyer: c.buyer.address, seller: c.seller.address, serviceId: `svc-${dealId}`, task: TASK, price: PRICE,
    deadline: Number(c.now() + 3_600n), reviewSecs: 600,
  };
  const termsJson = canonicalJson(terms);
  const contentHash = sha256(delivered);
  let listing: Address | undefined;
  if (kind !== "Plain") {
    const made = await listings.create(c.ctx, c.seller, {
      listingId: dealId, kind, price: PRICE, contentHash: kind === "Data" ? contentHash : new Uint8Array(32).fill(1), metaHash: new Uint8Array(32).fill(2),
      assessor: c.assessor.address,
    });
    assert.ok(made.ok, JSON.stringify(made));
    listing = made.listing;
    const reportHash = new Uint8Array(32).fill(3);
    const attested = await listings.attest(c.ctx, c.assessor, listing, kind === "Data" ? contentHash : new Uint8Array(32).fill(1), reportHash);
    assert.ok(attested.ok, JSON.stringify(attested));
  }
  const opened = await deals.open(c.ctx, c.buyer, {
    seller: c.seller.address, dealId, amount: PRICE, deadline: c.now() + 3_600n, reviewSecs: 600, resolveSecs: 600,
    stakeRequired: 1n * USDC, bondBps: 1_000, verifier: c.verifier.address, termsHash: sha256(enc.encode(termsJson)), listing,
    listingContentHash: listing ? (kind === "Data" ? contentHash : new Uint8Array(32).fill(1)) : undefined,
  });
  assert.ok(opened.ok, JSON.stringify(opened));
  const deal = opened.deal;
  for (const step of [
    () => deals.accept(c.ctx, c.seller, deal),
    () => deals.deliver(c.ctx, c.seller, deal, contentHash, PRICE),
    () => deals.challenge(c.ctx, c.buyer, deal),
  ]) {
    const r = await step();
    assert.ok(r.ok, JSON.stringify(r));
  }
  assert.equal((await getDeal(c.ctx, deal))!.status, "Challenged");
  return { deal, termsJson };
}

/** In-memory fact stores, as custody and the delivery store would answer. */
function stores() {
  const terms = new Map<string, string>();
  const content = new Map<string, Uint8Array>();
  const released = new Map<string, string>();
  const down = new Set<string>();
  const sources: FactSources = {
    async keyReleasedTo(deal) {
      if (down.has(deal)) throw new Error("custody unreachable");
      return released.get(deal) ?? null;
    },
    async terms(deal) {
      return terms.get(deal) ?? null;
    },
    async content(deal) {
      if (down.has(deal)) throw new Error("store unreachable");
      return content.get(deal) ?? null;
    },
  };
  return { terms, content, released, down, sources };
}

test("judge: the rules, without a chain", () => {
  const h = bytesToHex(sha256(enc.encode(GOOD)));
  assert.equal(judge({ kind: "Plain", task: TASK, deliveryHash: h, content: enc.encode(GOOD) }).verdict, "pass");
  assert.deepEqual(judge({ kind: "Service", task: TASK, deliveryHash: "00".repeat(32), content: enc.encode(GOOD) }), {
    verdict: "fail", reason: "HASH_MISMATCH", reasons: ["HASH_MISMATCH"],
  });
  const junk = enc.encode("[junk] lorem ipsum dolor sit amet, nothing here at all, really");
  const r = judge({ kind: "Plain", task: TASK, deliveryHash: bytesToHex(sha256(junk)), content: junk });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.verdict === "fail" && r.reasons, ["MARKED_JUNK", "OFF_TOPIC"]);
  const short = enc.encode("EURUSD forecast");
  assert.equal(judge({ kind: "Plain", task: TASK, deliveryHash: bytesToHex(sha256(short)), content: short }).reason, "TOO_SHORT");
  assert.equal(judge({ kind: "Plain", task: TASK, deliveryHash: h, content: null }).reason, "NOT_DELIVERED");
  assert.equal(judge({ kind: "Plain", task: TASK, deliveryHash: h, content: undefined }).verdict, "abstain");
  assert.equal(judge({ kind: "Plain", task: undefined, deliveryHash: h, content: enc.encode(GOOD) }).verdict, "abstain");
  assert.equal(judge({ kind: "Data", buyer: "B", keyReleasedTo: "B" }).verdict, "pass");
  assert.equal(judge({ kind: "Data", buyer: "B", keyReleasedTo: "X" }).reason, "KEY_RELEASED_TO_OTHER");
  assert.equal(judge({ kind: "Data", buyer: "B", keyReleasedTo: null }).reason, "KEY_NOT_RELEASED");
  assert.equal(judge({ kind: "Data", buyer: "B", keyReleasedTo: undefined }).verdict, "abstain");
});

test("the memcmp offsets match the Deal account layout", () => {
  const verifier = "Vrf1111111111111111111111111111111111111111" as Address;
  const zero = "11111111111111111111111111111111" as Address;
  const bytes = getDealEncoder().encode({
    buyer: zero, seller: zero, mint: zero, verifier, dealId: 0n, amount: 0n, invoiceAmount: 0n, toleranceBps: 0, stakeRequired: 0n, stakePosted: 0n,
    bondBps: 0, bondPosted: 0n, deadline: 0n, reviewSecs: 0n, resolveSecs: 0n, termsHash: new Uint8Array(32), deliveryHash: new Uint8Array(32),
    createdAt: 0n, acceptedAt: 0n, deliveredAt: 0n, challengedAt: 0n, status: DealStatus.Challenged, bump: 0,
  });
  assert.deepEqual(Array.from(bytes.subarray(DEAL_VERIFIER_OFFSET, DEAL_VERIFIER_OFFSET + 32)), Array.from(getAddressEncoder().encode(verifier)));
  assert.equal(bytes[DEAL_STATUS_OFFSET], STATUS_NAMES.indexOf("Challenged"));
});

test("pass, fail and abstain for Data, Service and plain deals, on chain", async () => {
  const c = await chain();
  const s = stores();
  const bad = enc.encode("Recipe for a lemon cake: flour, sugar, eggs, butter and two lemons.");
  const cases: { kind: Kind; want: "pass" | "fail" | "abstain"; delivered: Uint8Array; facts: (deal: Address, termsJson: string) => void }[] = [
    { kind: "Data", want: "pass", delivered: enc.encode("date,close\n2026-10-01,1.09\n"), facts: (d) => void s.released.set(d, c.buyer.address) },
    { kind: "Data", want: "fail", delivered: enc.encode("date,close\n2026-10-02,1.08\n"), facts: () => {} },
    { kind: "Data", want: "abstain", delivered: enc.encode("date,close\n2026-10-03,1.07\n"), facts: (d) => void s.down.add(d) },
    { kind: "Service", want: "pass", delivered: enc.encode(GOOD), facts: (d, t) => { s.terms.set(d, t); s.content.set(d, enc.encode(GOOD)); } },
    { kind: "Service", want: "fail", delivered: bad, facts: (d, t) => { s.terms.set(d, t); s.content.set(d, bad); } },
    { kind: "Service", want: "abstain", delivered: enc.encode(GOOD), facts: (d, t) => { s.terms.set(d, t); s.down.add(d); } },
    { kind: "Plain", want: "pass", delivered: enc.encode(GOOD), facts: (d, t) => { s.terms.set(d, t); s.content.set(d, enc.encode(GOOD)); } },
    // The store holds bytes that are not what the seller committed to on chain.
    { kind: "Plain", want: "fail", delivered: enc.encode(GOOD), facts: (d, t) => { s.terms.set(d, t); s.content.set(d, enc.encode(`${GOOD} (edited)`)); } },
    // Terms that do not hash to the on-chain terms hash are not trusted: no task, no verdict.
    { kind: "Plain", want: "abstain", delivered: enc.encode(GOOD), facts: (d, t) => { s.terms.set(d, t.replace("Weekly", "Daily")); s.content.set(d, enc.encode(GOOD)); } },
  ];
  const opened: Address[] = [];
  for (const k of cases) {
    const { deal, termsJson } = await challengedDeal(c, k.kind, k.delivered);
    k.facts(deal, termsJson);
    opened.push(deal);
  }
  // A challenged deal naming another verifier is not ours to rule, even if it is listed.
  const other = await generateKeyPairSigner();
  const lines: string[] = [];
  const svc = createVerifierService({ ctx: c.ctx, verifier: c.verifier, sources: s.sources, listChallenged: async () => [...opened, other.address], log: (l) => lines.push(l) });

  const rulings = await svc.tick();
  assert.deepEqual(rulings.map((r) => [r.kind, r.verdict.verdict]), cases.map((k) => [k.kind, k.want]));
  for (const r of rulings) assert.equal(r.sent === undefined, r.verdict.verdict === "abstain", JSON.stringify(r));
  for (const r of rulings.filter((x) => x.sent)) assert.ok(r.sent!.ok, JSON.stringify(r.sent));

  // Once per deal: a second tick sends nothing for the deals it already resolved.
  const again = await svc.tick();
  assert.deepEqual(again.map((r) => r.verdict.verdict), ["abstain", "abstain", "abstain"]);

  // No verdict: after the resolve window anyone can time the deal out.
  c.warp(601n);
  for (const [i, k] of cases.entries()) {
    if (k.want === "abstain") assert.ok((await deals.timeoutRefund(c.ctx, c.buyer, opened[i]!)).ok);
  }
  const final = await Promise.all(opened.map(async (d) => (await getDeal(c.ctx, d))!.status));
  const want = { pass: "VerifiedPass", fail: "VerifiedFail", abstain: "NoVerdict" } as const;
  assert.deepEqual(final, cases.map((k) => want[k.want]));

  // The verifier key never leaves the service: not in rulings, logs, or the service object.
  const emitted = JSON.stringify({ rulings, again, lines, svc: Object.keys(svc) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const form of [bytesToHex(c.secret), bytesToHex(c.secret.subarray(0, 32)), getBase58Decoder().decode(c.secret), JSON.stringify(Array.from(c.secret.subarray(0, 8))).slice(1, -1)]) {
    assert.ok(!emitted.includes(form), "the verifier secret appeared in the service's output");
  }
  assert.ok(!Object.values(svc).includes(c.verifier as never));
});
