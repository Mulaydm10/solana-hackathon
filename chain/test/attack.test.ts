// Randomized attack search (after Cordon's G4): random instruction sequences from random signers,
// including a stranger who tries every instruction, against the compiled program in LiteSVM.
// After every step an independent model of who should hold what is compared with the chain:
//   1. conservation: tokens across all parties + vaults never change in total;
//   2. every vault holds exactly what its deal says it holds (0 once settled);
//   3. buyer and seller balances equal what the deal outcomes entitle them to;
//   4. the stranger, the verifier and the approver never gain anything.
// Negative control: each run also drives one scripted deal that must settle, so the search cannot
// pass by refusing everything. Counts are reported via the test diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, TransactionSigner } from "@solana/kit";
import { DealStatus } from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, NONE, USDC, hash, setup } from "./harness.ts";

const RUNS = Number(process.env.ATTACK_RUNS ?? 60);
const STEPS = Number(process.env.ATTACK_STEPS ?? 40);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Deal = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["deal"]>>;
const FINAL = new Set([
  DealStatus.Released, DealStatus.Claimed, DealStatus.Refunded, DealStatus.Cancelled,
  DealStatus.VerifiedPass, DealStatus.VerifiedFail, DealStatus.NoVerdict,
]);

/** What the vault should hold for a deal, from the deal's own fields. */
function expectedVault(d: Deal): bigint {
  return FINAL.has(d.status) ? 0n : d.amount + d.stakePosted + d.bondPosted;
}

/** Net token change for (buyer, seller) caused by one deal, from its fields and outcome. */
function netEffect(d: Deal): [bigint, bigint] {
  const payout = d.invoiceAmount < d.amount ? d.invoiceAmount : d.amount;
  switch (d.status) {
    case DealStatus.Open:
      return [-d.amount, 0n];
    case DealStatus.Funded:
    case DealStatus.Delivered:
      return [-d.amount, -d.stakePosted];
    case DealStatus.Challenged:
      return [-(d.amount + d.bondPosted), -d.stakePosted];
    case DealStatus.Released:
    case DealStatus.Claimed:
      return [-payout, payout];
    case DealStatus.VerifiedPass:
      return [-(payout + d.bondPosted), payout + d.bondPosted];
    case DealStatus.VerifiedFail:
      return [d.stakePosted, -d.stakePosted];
    case DealStatus.Cancelled:
      return [0n, 0n];
    case DealStatus.NoVerdict:
      return [0n, 0n]; // order + bond back to the buyer, stake back to the seller
    case DealStatus.Refunded:
      return [d.stakePosted, -d.stakePosted]; // missed deadline: stake slashed to the buyer
    default:
      throw new Error(`unknown status ${d.status}`);
  }
}

test(`attack search: ${RUNS} random sequences x ${STEPS} steps, model-checked after every step`, async (ctx) => {
  const counts: Record<string, { tried: number; ok: number }> = {};
  let violations = 0;
  let controls = 0;
  const reached = new Set<number>();

  const ONLY = process.env.ATTACK_ONLY ? Number(process.env.ATTACK_ONLY) : -1;
  for (let run = 0; run < RUNS; run++) {
    if (ONLY >= 0 && run !== ONLY) continue;
    const r = rng(0xdea1 + run);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    // Roomier policy than the default so deals reach the deep states; allowlist and approval stay on.
    const t = await setup({ policy: (sl, ap) => ({ ...DEFAULT_POLICY(sl, ap), periodBudget: 400n * USDC, maxPrice: 30n * USDC }) });
    const parties = [t.buyer, t.seller, t.stranger, t.verifier, t.approver] as const;
    const start = new Map<Address, bigint>();
    for (const p of parties) start.set(p.address, await t.balance(p.address));
    const total0 = [...start.values()].reduce((a, b) => a + b, 0n);
    const deals: Address[] = [];
    const signer = (): TransactionSigner => pick(parties);
    /** Usually the party allowed to act; 30% of the time anyone (the attack). */
    const as = (legit: TransactionSigner): TransactionSigner => (r() < 0.7 ? legit : signer());
    const someDeal = () => (deals.length ? pick(deals) : null);
    /** Usually a deal in a state where the action can apply; otherwise any deal (the attack). */
    const dealIn = async (...statuses: DealStatus[]) => {
      if (!deals.length) return null;
      if (r() < 0.3) return pick(deals);
      const fitting = [];
      for (const d of deals) if (statuses.includes((await t.deal(d)).status)) fitting.push(d);
      return fitting.length ? pick(fitting) : pick(deals);
    };
    const deliveredHash = async (d: Address) => (r() < 0.7 ? Uint8Array.from((await t.deal(d)).deliveryHash) : hash(1 + Math.floor(r() * 3)));

    const SKIP = Symbol("skip");
    const actions: Record<string, () => Promise<unknown>> = {
      open: async () => {
        const amount = BigInt(1 + Math.floor(r() * 25)) * USDC;
        const d = await t.open({
          amount,
          seller: as(t.seller).address,
          verifier: r() < 0.7 ? t.verifier.address : pick([NONE, t.seller.address, t.buyer.address]),
          approver: r() < 0.7 ? t.approver : r() < 0.5 ? signer() : undefined,
          stakeRequired: BigInt(Math.floor(r() * 3)) * USDC,
          bondBps: pick([0, 1000, 5000]),
          deadline: t.now() + BigInt(60 + Math.floor(r() * 7200)),
          reviewSecs: BigInt(Math.floor(r() * 1200)),
          resolveSecs: BigInt(60 + Math.floor(r() * 1200)),
        });
        deals.push(d);
      },
      accept: async () => { const d = await dealIn(DealStatus.Open); if (!d) return SKIP; await t.accept(d, as(t.seller)); },
      deliver: async () => {
        const d = await dealIn(DealStatus.Funded);
        if (!d) return SKIP;
        const amount = (await t.deal(d)).amount;
        const invoice = (amount * BigInt(85 + Math.floor(r() * 31))) / 100n; // 85%..115%, around the 5% tolerance
        await t.deliver(d, invoice, as(t.seller), hash(1 + Math.floor(r() * 3)));
      },
      release: async () => { const d = await dealIn(DealStatus.Delivered); if (!d) return SKIP; await t.release(d, as(t.buyer), await deliveredHash(d)); },
      claim: async () => { const d = await dealIn(DealStatus.Delivered); if (!d) return SKIP; await t.claim(d, signer()); },
      challenge: async () => { const d = await dealIn(DealStatus.Delivered); if (!d) return SKIP; await t.challenge(d, as(t.buyer)); },
      resolve: async () => { const d = await dealIn(DealStatus.Challenged); if (!d) return SKIP; await t.resolve(d, r() < 0.5, as(t.verifier)); },
      timeoutRefund: async () => { const d = await dealIn(DealStatus.Challenged); if (!d) return SKIP; await t.timeoutRefund(d, signer()); },
      refund: async () => { const d = await dealIn(DealStatus.Open, DealStatus.Funded); if (!d) return SKIP; await t.refund(d, signer()); },
      cancel: async () => { const d = await dealIn(DealStatus.Open); if (!d) return SKIP; await t.cancel(d, as(t.buyer)); },
      hijackPolicy: async () =>
        t.updatePolicy({ ...DEFAULT_POLICY(t.stranger.address, t.stranger.address), allowAnySeller: true, periodBudget: 10_000n * USDC, maxPrice: 10_000n * USDC }, pick([t.stranger, t.seller, t.verifier])),
      // Tactic step: move one unsettled deal forward the legitimate way (Cordon-style tactics),
      // so random attacks hit deals in every state, not just freshly opened ones.
      progress: async () => {
        const live = [];
        for (const d of deals) if (!FINAL.has((await t.deal(d)).status)) live.push(d);
        if (!live.length) return SKIP;
        const d = pick(live);
        const deal = await t.deal(d);
        switch (deal.status) {
          case DealStatus.Open:
            return r() < 0.85 ? t.accept(d) : t.cancel(d);
          case DealStatus.Funded:
            if (r() < 0.1) { t.warp(deal.deadline - t.now() + 1n); return t.refund(d); }
            return t.deliver(d, (deal.amount * BigInt(96 + Math.floor(r() * 9))) / 100n, t.seller, hash(1 + Math.floor(r() * 3)));
          case DealStatus.Delivered: {
            const x = r();
            if (x < 0.4) return t.release(d, t.buyer, Uint8Array.from(deal.deliveryHash));
            if (x < 0.7 && deal.verifier !== NONE) return t.challenge(d);
            t.warp(deal.reviewSecs + 1n);
            return t.claim(d, t.stranger);
          }
          case DealStatus.Challenged:
            if (r() < 0.7) return t.resolve(d, r() < 0.5);
            t.warp(deal.resolveSecs + 1n);
            return t.timeoutRefund(d);
        }
        return SKIP;
      },
      warp: async () => t.warp(BigInt(r() < 0.85 ? Math.floor(r() * 400) : Math.floor(r() * 2 * Number(HOUR)))),
    };
    const names = Object.keys(actions);

    const check = async (where: string) => {
      let total = 0n;
      let [buyerNet, sellerNet] = [0n, 0n];
      for (const d of deals) {
        const deal = await t.deal(d);
        const vault = await t.vaultBalance(d);
        total += vault;
        if (vault !== expectedVault(deal)) { violations++; assert.fail(`${where}: vault ${vault} != expected ${expectedVault(deal)} (status ${deal.status})`); }
        reached.add(deal.status);
        const [b, s] = netEffect(deal);
        buyerNet += b;
        sellerNet += s;
      }
      for (const p of parties) total += await t.balance(p.address);
      if (total !== total0) { violations++; assert.fail(`${where}: conservation broken ${total} != ${total0}`); }
      const bal = async (p: { address: Address }) => (await t.balance(p.address)) - start.get(p.address)!;
      if ((await bal(t.buyer)) !== buyerNet) {
        for (const d of deals) { const x = await t.deal(d); console.log(JSON.stringify({ d, status: x.status, amount: x.amount, stake: x.stakePosted, bond: x.bondPosted, inv: x.invoiceAmount, ch: x.challengedAt }, (_k, v) => typeof v === 'bigint' ? v.toString() : v)); }
        violations++; assert.fail(`${where}: buyer ${await bal(t.buyer)} != model ${buyerNet}`); }
      if ((await bal(t.seller)) !== sellerNet) { violations++; assert.fail(`${where}: seller ${await bal(t.seller)} != model ${sellerNet}`); }
      for (const p of [t.stranger, t.verifier, t.approver]) {
        if ((await bal(p)) > 0n) { violations++; assert.fail(`${where}: ${p.address} gained ${await bal(p)}`); }
      }
    };

    for (let step = 0; step < STEPS; step++) {
      const name = r() < 0.5 ? "progress" : pick(names.filter((n) => n !== "progress"));
      counts[name] ??= { tried: 0, ok: 0 };
      if (process.env.ATTACK_TRACE) console.log(`step ${step} ${name}`);
      try {
        if ((await actions[name]!()) === SKIP) continue;
        counts[name].tried++;
        counts[name].ok++;
      } catch {
        counts[name].tried++;
        // refusals are expected; the invariants below are what matter
      }
      await check(`run ${run} step ${step} (${name})`);
    }

    // Negative control: a well-formed deal must go all the way through.
    t.warp(86_400n); // fresh budget period
    const control = await t.open({ amount: 1n * USDC, stakeRequired: 0n });
    deals.push(control);
    await t.accept(control);
    await t.deliver(control, 1n * USDC, t.seller, hash(5));
    await t.release(control, t.buyer, hash(5));
    assert.equal((await t.deal(control)).status, DealStatus.Released);
    controls++;
    await check(`run ${run} control`);
  }

  const tried = Object.values(counts).reduce((a, c) => a + c.tried, 0);
  const ok = Object.values(counts).reduce((a, c) => a + c.ok, 0);
  ctx.diagnostic(`attack search: ${RUNS} runs, ${tried} actions, ${ok} accepted, ${tried - ok} refused, ${violations} invariant violations, ${controls}/${RUNS} controls settled`);
  ctx.diagnostic(`per action (accepted/tried): ${Object.entries(counts).map(([k, c]) => `${k} ${c.ok}/${c.tried}`).join(", ")}`);
  assert.equal(violations, 0);
  assert.equal(controls, RUNS);
  // Coverage: the search must have driven deals into every final outcome, not only refusals.
  const names = Object.fromEntries(Object.entries(DealStatus).filter(([, v]) => typeof v === "number").map(([k, v]) => [v, k]));
  ctx.diagnostic(`outcomes reached: ${[...reached].sort().map((s) => names[s]).join(", ")}`);
  for (const s of FINAL) assert.ok(reached.has(s), `outcome ${names[s]} never reached`);
});
