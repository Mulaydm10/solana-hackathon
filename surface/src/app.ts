// HTTP API + static demo page for Ask -> Find -> Draft terms -> Lock -> Deliver -> Settle.
// Refusals (core reasons, program errors) are normal JSON results with a reason code. See contracts/surface.md.
import express, { type Request, type Response } from "express";
import type { Address } from "@solana/kit";
import { canonicalJson, describeTerms, termsHash, validateTerms, type DealTerms } from "@deal/core";
import { programErrorName } from "@deal/chain";
import type { Service } from "./catalog.ts";
import type { Desk } from "./desk.ts";
import type { Drafter } from "./draft.ts";
import { sha256, type Producer } from "./deliver.ts";
import { guardWrites, securityHeaders, type GuardConfig } from "./guard.ts";

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
  /** Program errors become refusals; anything else is a real failure. */
  const chainCall = async (res: Response, fn: () => Promise<object>) => {
    try {
      res.json({ ok: true, ...(await fn()) });
    } catch (e) {
      const reason = programErrorName(e);
      if (reason) return refuse(res, reason, `Solana program refused: ${reason}`);
      console.error(e);
      res.status(502).json({ ok: false, reason: "CHAIN_ERROR", message: (e as Error).message });
    }
  };

  app.get("/api/config", (_req, res) => {
    res.json({ buyer: deps.desk.buyer, symbol: deps.symbol, decimals: deps.decimals, cluster, defaultBudgetUsdc: deps.defaultBudgetUsdc });
  });

  app.get("/api/status", async (_req, res) => {
    await chainCall(res, async () => ({ ...(await deps.desk.status()), drafting: deps.drafting ?? "rules", cluster }));
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
    await chainCall(res, async () => {
      const { deal, signature } = await deps.desk.lock({
        dealId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
        seller: terms.seller as Address, price: terms.price, deadline: terms.deadline,
        reviewSecs: terms.reviewSecs, termsHash: termsHash(terms),
      });
      deals.set(deal, { terms, serviceId: terms.serviceId, log: [{ step: "lock", signature }] });
      return { deal, signature, explorer: explorer(signature), termsJson: canonicalJson(terms) };
    });
  });

  app.post("/api/deals/:deal/deliver", async (req, res) => {
    const deal = req.params.deal as Address;
    const rec = deals.get(deal);
    if (!rec) return refuse(res, "UNKNOWN_DEAL", "This server did not open that deal.");
    const service = deps.services.find((s) => s.id === rec.serviceId)!;
    await chainCall(res, async () => {
      const content = await deps.produce(service, rec.terms.task);
      const signature = await deps.desk.deliver(deal, sha256(content));
      rec.delivery = content;
      rec.log.push({ step: "deliver", signature });
      return { signature, explorer: explorer(signature), delivery: content };
    });
  });

  for (const step of ["release", "refund", "claim"] as const) {
    app.post(`/api/deals/:deal/${step}`, async (req, res) => {
      const deal = req.params.deal as Address;
      await chainCall(res, async () => {
        const signature = await deps.desk[step](deal);
        deals.get(deal)?.log.push({ step, signature });
        return { signature, explorer: explorer(signature) };
      });
    });
  }

  app.get("/api/deals/:deal", async (req, res) => {
    const deal = req.params.deal as Address;
    await chainCall(res, async () => {
      const onChain = await deps.desk.get(deal);
      const rec = deals.get(deal);
      return { onChain, delivery: rec?.delivery ?? null, log: rec?.log.map((l) => ({ ...l, explorer: explorer(l.signature) })) ?? [] };
    });
  });

  // Fail closed: anything unexpected is a refusal with a reason code, never an HTML stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ ok: false, reason: "INTERNAL", message: "Request failed. Check the deal status before retrying." });
  });

  return app;
}
