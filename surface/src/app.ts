// HTTP API + static demo page for Ask -> Find -> Draft terms -> Lock -> Deliver -> Settle.
// Refusals (core reasons, program errors) are normal JSON results with a reason code. See contracts/surface.md.
import express, { type Request, type Response } from "express";
import type { Address } from "@solana/kit";
import { canonicalJson, describeTerms, termsHash, validateTerms, type DealTerms } from "@deal/core";
import type { Sent } from "@deal/chain";
import type { Service } from "./catalog.ts";
import type { Desk } from "./desk.ts";
import type { Drafter } from "./draft.ts";
import { sha256, type Producer } from "./deliver.ts";
import { guardWrites, securityHeaders, type GuardConfig } from "./guard.ts";
import { judge } from "./verifier.ts";

export type AppDeps = {
  desk: Desk;
  draft: Drafter;
  produce: Producer;
  services: Service[];
  decimals: number;
  symbol: string;
  /** Budget used when the buyer names none, in whole tokens. */
  defaultBudgetUsdc: number;
  now?: () => number;
  cluster?: string;
  /** "claude" or "rules", shown on the proof panel. */
  drafting?: string;
  /** Token + limits for write requests. Required: there is no unauthenticated mode. */
  guard: GuardConfig;
};

type Record_ = { terms: DealTerms; serviceId: string; delivery?: string; log: { step: string; signature: string }[] };

/** Deal shape for the demo (v2): seller stake 10% of the price, buyer challenge bond 10%,
 * invoice tolerance 5%, verifier has 2 minutes to decide a challenge. */
export const DEAL_SHAPE = { stakeBps: 1000n, bondBps: 1000, toleranceBps: 500, resolveSecs: 120 } as const;

/** Terms travel as JSON; price is a decimal string there. */
type TermsJson = Omit<DealTerms, "price"> & { price: string };
const toJson = (t: DealTerms): TermsJson => ({ ...t, price: t.price.toString() });
const fromJson = (t: TermsJson): DealTerms => ({ ...t, price: BigInt(t.price) });

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const cluster = deps.cluster ?? "devnet";
  const units = (usdc: number) => BigInt(Math.round(usdc * 10 ** deps.decimals));
  const deals = new Map<string, Record_>();
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", guardWrites(deps.guard));
  app.use(express.static(new URL("../public", import.meta.url).pathname));

  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
  const refuse = (res: Response, reason: string, message: string) => res.json({ ok: false, reason, message });
  /** Library results -> JSON. Refusals are normal results; only infrastructure failures are 502. */
  const respond = (res: Response, r: Sent, rec: Record_ | undefined, step: string, extra: object = {}) => {
    if (!r.ok) {
      // Infrastructure failures are logged with their message so they can be diagnosed later;
      // program refusals are normal outcomes and are not.
      if (["CHAIN_ERROR", "RPC_UNAVAILABLE", "CONFIRMATION_TIMEOUT"].includes(r.reason)) console.error(`[${step}] ${r.reason}: ${r.message}`);
      return res.status(r.reason === "CHAIN_ERROR" ? 502 : 200).json(r);
    }
    rec?.log.push({ step, signature: r.signature });
    res.json({ ok: true, signature: r.signature, explorer: explorer(r.signature), ...extra });
  };
  const record = (deal: string) => deals.get(deal);

  app.get("/api/config", (_req, res) => {
    res.json({ buyer: deps.desk.buyer, symbol: deps.symbol, decimals: deps.decimals, cluster, defaultBudgetUsdc: deps.defaultBudgetUsdc });
  });

  app.get("/api/status", async (_req, res, next) => {
    try {
      res.json({ ok: true, ...(await deps.desk.status()), drafting: deps.drafting ?? "rules", cluster });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/services", (_req, res) => {
    res.json(deps.services.map(({ keywords: _k, ...s }) => ({ ...s, seller: deps.desk.sellerFor(s.id) ?? null })));
  });

  app.post("/api/draft", async (req: Request, res: Response) => {
    const request = String(req.body?.request ?? "").trim();
    if (!request) return refuse(res, "EMPTY_REQUEST", "Describe what you need.");
    if (request.length > 2000) return refuse(res, "REQUEST_TOO_LONG", "Keep the request under 2000 characters.");
    const draft = await deps.draft(request, deps.services);
    const service = deps.services.find((s) => s.id === draft.serviceId)!;
    const seller = deps.desk.sellerFor(service.id);
    if (!seller) return refuse(res, "NO_SELLER", `No seller key for ${service.id}.`);
    const t = now();
    const terms: DealTerms = {
      template: "pay_on_delivery", buyer: deps.desk.buyer, seller, serviceId: service.id, task: draft.task,
      price: units(service.priceUsdc), deadline: t + draft.deadlineMins * 60, reviewSecs: draft.reviewMins * 60,
    };
    res.json({
      ok: true, source: draft.source, service, options: draft.options,
      budgetUsdc: draft.budgetUsdc ?? deps.defaultBudgetUsdc, terms: toJson(terms),
      summary: describeTerms(terms, { decimals: deps.decimals, symbol: deps.symbol }),
    });
  });

  /** Re-describe edited terms (e.g. a shorter deadline) before approval. */
  app.post("/api/describe", (req, res) => {
    let terms: DealTerms;
    try {
      terms = fromJson(req.body.terms as TermsJson);
    } catch {
      return refuse(res, "BAD_TERMS", "Terms could not be read.");
    }
    res.json({ ok: true, summary: describeTerms(terms, { decimals: deps.decimals, symbol: deps.symbol }) });
  });

  app.post("/api/lock", async (req, res) => {
    let terms: DealTerms;
    try {
      terms = fromJson(req.body.terms as TermsJson);
    } catch {
      return refuse(res, "BAD_TERMS", "Terms could not be read.");
    }
    if (terms.buyer !== deps.desk.buyer || terms.seller !== deps.desk.sellerFor(terms.serviceId)) {
      return refuse(res, "BAD_PARTIES", "Buyer or seller does not match the listing.");
    }
    const budget = units(Number(req.body.budgetUsdc ?? deps.defaultBudgetUsdc));
    const checked = validateTerms(terms, { now: now(), budgetRemaining: budget });
    if (!checked.ok) return refuse(res, checked.reason, `Terms refused before any money moved: ${checked.reason}`);
    const r = await deps.desk.lock({
      dealId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      seller: terms.seller as Address, price: terms.price, deadline: terms.deadline, reviewSecs: terms.reviewSecs,
      termsHash: termsHash(terms), stake: (terms.price * DEAL_SHAPE.stakeBps) / 10_000n, bondBps: DEAL_SHAPE.bondBps,
      toleranceBps: DEAL_SHAPE.toleranceBps, resolveSecs: DEAL_SHAPE.resolveSecs,
    });
    if (!r.ok) return respond(res, r, undefined, "lock");
    const rec: Record_ = { terms, serviceId: terms.serviceId, log: [] };
    deals.set(r.deal, rec);
    respond(res, r, rec, "lock", { deal: r.deal, termsJson: canonicalJson(terms) });
  });

  /** The seller agent accepts the terms and posts its stake. */
  app.post("/api/deals/:deal/accept", async (req, res) => {
    const deal = req.params.deal as Address;
    respond(res, await deps.desk.accept(deal), record(deal), "accept");
  });

  /** The seller agent produces the work and submits its hash + invoice. quality=junk simulates a bad seller. */
  app.post("/api/deals/:deal/deliver", async (req, res) => {
    const deal = req.params.deal as Address;
    const rec = record(deal);
    if (!rec) return refuse(res, "UNKNOWN_DEAL", "This server did not open that deal.");
    const service = deps.services.find((s) => s.id === rec.serviceId)!;
    const content = req.body?.quality === "junk"
      ? `[junk] ${service.name} placeholder output, not the requested work.`
      : await deps.produce(service, rec.terms.task);
    const r = await deps.desk.deliver(deal, sha256(content), rec.terms.price);
    if (r.ok) rec.delivery = content;
    respond(res, r, rec, "deliver", { delivery: content });
  });

  /** Buyer releases payment for exactly the delivery it received (hash-bound approval). */
  app.post("/api/deals/:deal/release", async (req, res) => {
    const deal = req.params.deal as Address;
    const rec = record(deal);
    if (!rec?.delivery) return refuse(res, "NO_DELIVERY", "Nothing has been delivered to this buyer yet.");
    respond(res, await deps.desk.release(deal, sha256(rec.delivery)), rec, "release");
  });

  /** The independent verifier judges a challenged delivery and records its verdict on chain. */
  app.post("/api/deals/:deal/verify", async (req, res) => {
    const deal = req.params.deal as Address;
    const rec = record(deal);
    const onChain = await deps.desk.get(deal);
    if (!rec?.delivery || !onChain) return refuse(res, "UNKNOWN_DEAL", "No delivery on record for that deal.");
    if (onChain.status !== "Challenged") return refuse(res, "WrongStatus", `Deal is ${onChain.status}, not Challenged.`);
    const verdict = judge(rec.terms.task, rec.delivery, onChain.deliveryHash);
    respond(res, await deps.desk.resolve(deal, verdict.ok), rec, verdict.ok ? "verify: pass" : "verify: fail", { verdict });
  });

  const simple = { challenge: "challenge", timeout: "timeoutRefund", refund: "refund", claim: "claim", cancel: "cancel" } as const;
  for (const [path, method] of Object.entries(simple)) {
    app.post(`/api/deals/:deal/${path}`, async (req, res) => {
      const deal = req.params.deal as Address;
      respond(res, await deps.desk[method](deal), record(deal), path);
    });
  }

  app.get("/api/deals/:deal", async (req, res, next) => {
    try {
      const deal = req.params.deal as Address;
      const onChain = await deps.desk.get(deal);
      const rec = record(deal);
      res.json({ ok: true, onChain, delivery: rec?.delivery ?? null, log: rec?.log.map((l) => ({ ...l, explorer: explorer(l.signature) })) ?? [] });
    } catch (e) {
      next(e);
    }
  });

  // Fail closed: anything unexpected is a refusal with a reason code, never an HTML stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ ok: false, reason: "INTERNAL", message: "Request failed. Check the deal status before retrying." });
  });

  return app;
}
