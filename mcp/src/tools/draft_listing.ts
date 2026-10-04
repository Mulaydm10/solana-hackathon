import { z } from "zod";
import { formatAmount } from "@deal/core";
import { defineTool, ok } from "../tool.ts";
import { badInput, plain, usdcToBase } from "../access.ts";
import { buildMeta, readSource, runSellerChain } from "../seller.ts";

const service = z.object({ endpoint: z.string(), input_schema: z.record(z.string(), z.unknown()), output_schema: z.record(z.string(), z.unknown()), example_input: z.unknown().optional() });

/** The seller chain on the agent's own data, without signing: what a listing would look like and cost. */
export default defineTool({
  name: "draft_listing",
  description:
    "Draft a listing for your data (file_path or text) or your service (https endpoint + schemas): classifies it, assesses it (grade, personal data, secrets), suggests a price range with reasons and drafts the deal terms. Signs nothing; then call publish_listing.",
  input: {
    file_path: z.string().optional(), text: z.string().optional(), service: service.optional(),
    name: z.string().optional(), description: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(),
    task: z.string().max(500).optional(), price_usdc: z.string().optional(),
    delivery_hours: z.number().int().min(1).max(720).optional(), review_hours: z.number().int().min(1).max(720).optional(),
  },
  writes: false,
  async run(args, c) {
    const src = readSource(args);
    if (!src.ok) return src.result;
    const chosen = args.price_usdc === undefined ? undefined : usdcToBase(args.price_usdc);
    if (chosen === null) return badInput("price_usdc must be decimal USDC, e.g. \"4.5\".");
    const signer = c.chain ? (await c.chain()).signer : null;
    const task = args.task ?? (src.value.kind === "Data" ? "Deliver the listed dataset exactly as assessed" : "Answer calls within the declared output schema");
    const d = await runSellerChain(c, src.value, {
      seller: signer?.address ?? "draft-seller", task, price: chosen, deliveryHours: args.delivery_hours ?? 24, reviewHours: args.review_hours ?? 6,
    });
    if (!d.ok) return d.result;
    const v = d.value;
    const meta = args.name && args.description && args.category ? buildMeta({ name: args.name, description: args.description, category: args.category, tags: args.tags }, v.classification) : null;
    const usdc = (b: bigint) => formatAmount(b, 6);
    return ok(plain({
      kind: v.report.kind,
      grade: v.report.grade,
      report: v.report,
      reportHash: v.reportHash,
      needsConfirmation: v.report.needsConfirmation,
      price: { lowUsdc: usdc(v.suggestion.low), midUsdc: usdc(v.suggestion.mid), highUsdc: usdc(v.suggestion.high), chosenUsdc: usdc(v.template.price), reasons: v.suggestion.reasons },
      terms: v.template,
      termsHash: v.templateHash,
      meta: meta === null ? null : meta.ok ? meta.value : { refused: meta.result },
      next: v.report.needsConfirmation
        ? "Personal data was found: publish_listing needs confirm_personal_data: true after you have checked you may sell it."
        : "To list it, call publish_listing with the same source, a name, description and category, and your price.",
    }));
  },
});
