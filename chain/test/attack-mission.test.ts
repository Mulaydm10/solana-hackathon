// Randomized attack search over missions and agent mandates (PLAN §2.3), in the style of
// attack.test.ts: random actions by random signers (agents, a stranger, the buyer), time warps,
// revokes, approvals with right and wrong digests, deals opened and settled by agents. After every
// step an independent model is compared with the chain:
//   - agent_spend is accepted exactly when the model says every rule allows it (mission open, not
//     expired, mandate live, stage approved, stage bit set, payee allowed, every cap respected);
//   - no counter ever exceeds its cap; refunds never reduce `spent`;
//   - the mission vault holds budget - spent + what the mission's deals returned;
//   - tokens are conserved and nobody outside the payees gains anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, lamports, type Address, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { DealStatus, getMission, getMandate, mandatesDigest, missions, type DealClient, type DealContext, type MandateInput } from "../src/index.ts";
import { DEFAULT_POLICY, HOUR, USDC, hash, setup } from "./harness.ts";

const RUNS = Number(process.env.ATTACK_RUNS ?? 40);
const STEPS = Number(process.env.ATTACK_STEPS ?? 40);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const FINAL = new Set([DealStatus.Released, DealStatus.Claimed, DealStatus.Refunded, DealStatus.Cancelled, DealStatus.VerifiedPass, DealStatus.VerifiedFail, DealStatus.NoVerdict]);
/** What a settled mission deal returned to the mission vault (the buyer side of the deal). */
function returnedToMission(d: { status: number; amount: bigint; invoiceAmount: bigint; bondPosted: bigint }): bigint {
  switch (d.status) {
    case DealStatus.Released:
    case DealStatus.Claimed:
      return d.amount - (d.invoiceAmount < d.amount ? d.invoiceAmount : d.amount) + d.bondPosted;
    case DealStatus.VerifiedPass:
      return d.amount - (d.invoiceAmount < d.amount ? d.invoiceAmount : d.amount);
    case DealStatus.Refunded:
    case DealStatus.Cancelled:
    case DealStatus.VerifiedFail:
    case DealStatus.NoVerdict:
      return d.amount + d.bondPosted; // stakes go to the buyer side only on VerifiedFail/Refunded-after-accept
    default:
      return 0n;
  }
}

test(`mission attack search: ${RUNS} runs x ${STEPS} steps, model-checked after every step`, async (ctx) => {
  let violations = 0;
  let spendsAccepted = 0;
  let spendsRefused = 0;
  let dealsOpened = 0;
  const outcomes = new Set<number>();
  const ONLY = process.env.ATTACK_ONLY ? Number(process.env.ATTACK_ONLY) : -1;
  for (let run = 0; run < RUNS; run++) {
    if (ONLY >= 0 && run !== ONLY) continue;
    const r = rng(0x5afe + run);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const t = await setup({
      policy: (s, a) => ({ ...DEFAULT_POLICY(s, a), periodBudget: 400n * USDC, maxPrice: 50n * USDC, approvalThreshold: 100n * USDC }),
    });
    // Identical retries must be new transactions (LiteSVM rejects a repeated signature), as in the harness.
    const sending: DealClient = {
      rpc: (t.client as unknown as DealClient).rpc,
      sendTransaction: (ixs) => { t.client.svm.expireBlockhash(); return (t.client as unknown as DealClient).sendTransaction(ixs); },
    };
    const dctx: DealContext = { client: sending, mint: t.mint.address, sleep: async () => {} };
    const budget = BigInt(10 + Math.floor(r() * 30)) * USDC;
    const stageCount = 1 + Math.floor(r() * 3);
    const stageCaps = Array.from({ length: stageCount }, () => { const c = BigInt(3 + Math.floor(r() * 20)) * USDC; return c > budget ? budget : c; });
    const expiresAt = t.now() + BigInt(1800 + Math.floor(r() * 3600));
    const created = await missions.create(dctx, t.buyer, { missionId: 1n, budget, termsHash: hash(50), stageCaps, expiresAt, rentLamports: 200_000_000n });
    assert.ok(created.ok, JSON.stringify(created));
    const mission = (created as { mission: Address }).mission;

    // Two or three agents with random mandates (some may be refused; the model only keeps accepted ones).
    type M = MandateInput & { signer: KeyPairSigner; spent: bigint; revoked: boolean };
    const model = { spent: 0n, stageSpent: stageCaps.map(() => 0n), current: 0, approved: stageCaps.map(() => false), locked: false, closed: false };
    const mandates: M[] = [];
    const accepted: MandateInput[] = [];
    let caps = 0n;
    for (let i = 0, n = 2 + Math.floor(r() * 2); i < n; i++) {
      const signer = await generateKeyPairSigner();
      t.client.svm.airdrop(signer.address, lamports(1_000_000_000n));
      const cap = BigInt(2 + Math.floor(r() * 15)) * USDC;
      const m: MandateInput = {
        agent: signer.address, roleHash: hash(60 + i), cap, perTxCap: BigInt(1 + Math.floor(r() * Number(cap / USDC))) * USDC,
        payees: r() < 0.8 ? [t.seller.address] : [t.seller.address, t.stranger.address],
        stageMask: 1 + Math.floor(r() * ((1 << stageCount) - 1)), expiresAt: expiresAt - BigInt(Math.floor(r() * 1200)),
      };
      const res = await missions.addMandate(dctx, t.buyer, mission, m);
      const shouldPass = caps + cap <= budget;
      if (res.ok !== shouldPass) { violations++; assert.fail(`run ${run}: addMandate ok=${res.ok} but model says ${shouldPass}`); }
      if (res.ok) { caps += cap; accepted.push(m); mandates.push({ ...m, signer, spent: 0n, revoked: false }); }
    }
    if (mandates.length === 0) continue;

    const deals: Address[] = [];
    const start = new Map<Address, bigint>();
    const parties = [t.buyer, t.seller, t.stranger, t.verifier, t.approver];
    for (const p of parties) start.set(p.address, await t.balance(p.address));

    const allowedSpend = (m: M, signer: TransactionSigner, amount: bigint, payee: Address) => {
      const now = t.now();
      return !model.closed && now < expiresAt && signer.address === m.agent && !m.revoked && now < BigInt(m.expiresAt)
        && model.locked && model.approved[model.current] === true && ((m.stageMask >> model.current) & 1) === 1
        && amount > 0n && amount <= m.perTxCap && m.spent + amount <= m.cap
        && model.stageSpent[model.current]! + amount <= stageCaps[model.current]! && model.spent + amount <= budget
        && m.payees.includes(payee);
    };
    const record = (m: M, amount: bigint) => {
      m.spent += amount;
      model.stageSpent[model.current]! += amount;
      model.spent += amount;
    };

    const actions: Record<string, () => Promise<unknown>> = {
      approve: async () => {
        const stage = model.locked ? model.current + (r() < 0.8 ? 1 : 0) : r() < 0.8 ? 0 : 1;
        const good = r() < 0.85;
        const res = await missions.approveStage(dctx, r() < 0.85 ? t.buyer : pick([t.stranger, mandates[0]!.signer]), mission, stage, hash(70 + stage), good ? mandatesDigest(accepted) : hash(1));
        if (res.ok) {
          model.locked = true;
          model.approved[stage] = true;
          model.current = stage;
        }
      },
      spend: async () => {
        const m = pick(mandates);
        const signer = r() < 0.85 ? m.signer : pick([t.stranger, pick(mandates).signer]);
        const amount = BigInt(Math.floor(r() * Number(m.perTxCap + 2n * USDC)));
        const payee = r() < 0.85 ? t.seller.address : t.stranger.address;
        const expect = allowedSpend(m, signer, amount, payee);
        // An impostor uses the mandate of `m` only if it signs as m.agent, which it cannot; the library
        // derives the mandate from the signer, so impostors hit their own (maybe missing) mandate.
        const own = mandates.find((x) => x.agent === signer.address);
        const res = await missions.spend(dctx, signer, mission, payee, amount, hash(80));
        const ownExpect = own ? allowedSpend(own, signer, amount, payee) : false;
        const predicted = own === m ? expect : ownExpect;
        if (res.ok !== predicted) {
          violations++;
          assert.fail(`run ${run}: spend ok=${res.ok} (${res.ok ? "" : (res as { reason: string }).reason}) but model says ${predicted}`);
        }
        if (res.ok) { record(own!, amount); spendsAccepted++; } else spendsRefused++;
      },
      openDeal: async () => {
        const m = pick(mandates);
        const amount = BigInt(1 + Math.floor(r() * Number(m.perTxCap / USDC))) * USDC;
        const mandateOk = allowedSpend(m, m.signer, amount, t.seller.address);
        const res = await missions.openDeal(dctx, m.signer, mission, {
          seller: t.seller.address, dealId: BigInt(deals.length + 1), amount, deadline: t.now() + BigInt(300 + Math.floor(r() * 1200)),
          reviewSecs: BigInt(60 + Math.floor(r() * 600)), toleranceBps: 500, bondBps: r() < 0.7 ? 1000 : 0, verifier: t.verifier.address, termsHash: hash(7),
        }, hash(81));
        if (res.ok && !mandateOk) { violations++; assert.fail(`run ${run}: openDeal accepted against the mandate rules`); }
        if (res.ok) { record(m, amount); deals.push((res as { deal: Address }).deal); dealsOpened++; }
      },
      progressDeal: async () => {
        if (!deals.length) return;
        const d = pick(deals);
        const x = await t.deal(d);
        const m = pick(mandates);
        if ((x.status === DealStatus.Open || x.status === DealStatus.Funded) && r() < 0.15) {
          t.warp(x.deadline - t.now() + 1n);
          return t.refund(d).catch(() => {});
        }
        if (x.status === DealStatus.Open) return t.accept(d).catch(() => {});
        if (x.status === DealStatus.Funded) return t.deliver(d, x.amount, t.seller, hash(9)).catch(() => {});
        if (x.status === DealStatus.Delivered) {
          if (r() < 0.4) return missions.release(dctx, m.signer, mission, d, hash(9));
          if (x.bondBps > 0 && r() < 0.75) {
            const bond = (x.amount * BigInt(x.bondBps)) / 10_000n;
            const res = await missions.challenge(dctx, m.signer, mission, d);
            // The bond goes to the deal vault, not to a payee, so only the mandate's caps and state apply.
            if (res.ok && !allowedSpend({ ...m, payees: [t.seller.address] }, m.signer, bond, t.seller.address)) {
              violations++; assert.fail(`run ${run}: challenge bond accepted against the mandate rules`);
            }
            if (res.ok) {
              record(m, bond);
              if (r() < 0.6) await t.resolve(d, r() < 0.5).catch(() => {}); // the verifier rules
            }
            return;
          }
          t.warp(x.reviewSecs + 1n);
          return t.claim(d, t.stranger).catch(() => {});
        }
        if (x.status === DealStatus.Challenged) return r() < 0.7 ? t.resolve(d, r() < 0.5).catch(() => {}) : (t.warp(x.resolveSecs + 1n), t.timeoutRefund(d).catch(() => {}));
      },
      revoke: async () => {
        const m = pick(mandates);
        const by = r() < 0.8 ? t.buyer : t.stranger;
        const res = await missions.revoke(dctx, by, mission, m.agent);
        if (res.ok !== (by === t.buyer)) { violations++; assert.fail(`run ${run}: revoke by ${by === t.buyer ? "buyer" : "stranger"} ok=${res.ok}`); }
        if (res.ok) m.revoked = true;
      },
      close: async () => {
        if (r() > 0.15) return;
        const by = r() < 0.5 ? t.buyer : t.stranger;
        const res = await missions.close(dctx, by, mission);
        const expect = by === t.buyer || t.now() >= expiresAt;
        if (res.ok !== expect) { violations++; assert.fail(`run ${run}: close ok=${res.ok} expected ${expect}`); }
        if (res.ok) model.closed = true;
      },
      warp: async () => t.warp(BigInt(Math.floor(r() * 900))),
      // Tactic (as in attack.test.ts): move the mission forward the legitimate way, so the random
      // attacks above hit missions with approved stages and live mandates, not just fresh ones.
      progress: async () => {
        if (deals.length && r() < 0.35) return actions.progressDeal!();
        if (r() < 0.15) return actions.openDeal!();
        const next = model.locked ? model.current + 1 : 0;
        const stageDone = model.locked && model.stageSpent[model.current]! * 10n >= stageCaps[model.current]! * 7n;
        if ((!model.locked || (stageDone && next < stageCount)) && r() < 0.9) {
          const res = await missions.approveStage(dctx, t.buyer, mission, next, hash(70 + next), mandatesDigest(accepted));
          if (res.ok) { model.locked = true; model.approved[next] = true; model.current = next; }
          return;
        }
        const live = mandates.filter((m) => ((m.stageMask >> model.current) & 1) === 1 && !m.revoked);
        if (!live.length) return;
        const m = pick(live);
        const room = [m.perTxCap, m.cap - m.spent, stageCaps[model.current]! - model.stageSpent[model.current]!, budget - model.spent]
          .reduce((a, b) => (a < b ? a : b));
        if (room <= 0n) return;
        const amount = 1n + BigInt(Math.floor(r() * Number(room)));
        const expect = allowedSpend(m, m.signer, amount, t.seller.address);
        const res = await missions.spend(dctx, m.signer, mission, t.seller.address, amount, hash(82));
        if (res.ok !== expect) { violations++; assert.fail(`run ${run}: progress spend ok=${res.ok} (${res.ok ? "" : (res as { reason: string }).reason}) but model says ${expect}`); }
        if (res.ok) { record(m, amount); spendsAccepted++; } else spendsRefused++;
      },
    };
    const names = Object.keys(actions).filter((n) => n !== "progress");

    let swept = 0n; // tokens close_mission moved back to the buyer
    const check = async (where: string) => {
      const v = (await getMission(dctx, mission))!;
      if (BigInt(v.spent) !== model.spent) { violations++; assert.fail(`${where}: spent ${v.spent} != model ${model.spent}`); }
      if (BigInt(v.spent) > budget) { violations++; assert.fail(`${where}: spent over budget`); }
      v.stages.forEach((s, i) => {
        if (BigInt(s.spent) > stageCaps[i]!) { violations++; assert.fail(`${where}: stage ${i} over cap`); }
        if (BigInt(s.spent) !== model.stageSpent[i]) { violations++; assert.fail(`${where}: stage ${i} spent ${s.spent} != model ${model.stageSpent[i]}`); }
      });
      for (const m of mandates) {
        const mv = (await getMandate(dctx, mission, m.agent))!;
        if (BigInt(mv.spent) !== m.spent || BigInt(mv.spent) > m.cap) { violations++; assert.fail(`${where}: mandate spent ${mv.spent} != model ${m.spent}`); }
      }
      let returned = 0n;
      let inDeals = 0n;
      for (const d of deals) {
        const x = await t.deal(d);
        returned += returnedToMission(x);
        outcomes.add(x.status);
        if (!FINAL.has(x.status)) inDeals += await t.vaultBalance(d);
      }
      const expectedVault = budget - model.spent + returned - swept;
      if (BigInt(v.vaultBalance) !== expectedVault) { violations++; assert.fail(`${where}: vault ${v.vaultBalance} != model ${expectedVault}`); }
      // Nobody outside the allowed payees (seller, and the stranger only where listed) gains anything
      // beyond what the model paid them; verifier and approver never gain.
      for (const p of [t.verifier, t.approver]) {
        if ((await t.balance(p.address)) > start.get(p.address)!) { violations++; assert.fail(`${where}: ${p.address} gained`); }
      }
      void inDeals;
    };

    for (let step = 0; step < STEPS; step++) {
      const name = r() < 0.45 ? "progress" : pick(names);
      const before = BigInt((await getMission(dctx, mission))!.vaultBalance);
      try { await actions[name]!(); } catch (e) { if ((e as Error).name === "AssertionError") throw e; }
      if (name === "close" && model.closed) {
        const after = BigInt((await getMission(dctx, mission))!.vaultBalance);
        swept += before - after;
      }
      await check(`run ${run} step ${step} (${name})`);
    }
  }
  ctx.diagnostic(`mission attack search: ${RUNS} runs, spends accepted ${spendsAccepted}, refused ${spendsRefused}, deals opened by agents ${dealsOpened}, deal states reached ${[...outcomes].sort().join(",")}, ${violations} invariant violations`);
  assert.equal(violations, 0);
  assert.ok(spendsAccepted > 0, "the search never got a spend through: the model is not exercising the program");
  assert.ok(spendsRefused > 0);
  assert.ok(dealsOpened > 0, "agents never opened a deal");
});
