import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { fetchMaybeAssessorRegistry, listings, registryAddress } from "@deal/chain";
import { publish, type Custody } from "@deal/agents";
import { defineTool, ok, refuse } from "../tool.ts";
import { badInput, isAddress, needChain, needSigner, plain, usdcToBase } from "../access.ts";
import { buildMeta, readSource, runSellerChain } from "../seller.ts";

const service = z.object({ endpoint: z.string(), input_schema: z.record(z.string(), z.unknown()), output_schema: z.record(z.string(), z.unknown()), example_input: z.unknown().optional() });

/**
 * Lists the agent's data or service with the agent's own key as seller. The assessment is re-run here from the
 * source (a report passed in is never trusted), then agents' `publish` creates the listing on chain. The assessor
 * signs separately: the marketplace's assessor service re-assesses and attests. Data goes to the marketplace's
 * custody, never kept by the seller (PLAN §4.2), so the buyer's key comes from a party that is not the seller.
 */
export default defineTool({
  name: "publish_listing",
  description:
    "List your data or service on the marketplace, signed with this agent's own key as seller. Re-runs the assessment from the same source as draft_listing; refuses personal data you have not confirmed and needs a registered assessor. The listing is buyable once the marketplace assessor attests it.",
  input: {
    file_path: z.string().optional(), text: z.string().optional(), service: service.optional(),
    name: z.string(), description: z.string(), category: z.string(), tags: z.array(z.string()).optional(),
    task: z.string().max(500).optional(), price_usdc: z.string(),
    delivery_hours: z.number().int().min(1).max(720).optional(), review_hours: z.number().int().min(1).max(720).optional(),
    confirm_personal_data: z.boolean().optional(), assessor: z.string().optional(),
  },
  writes: true,
  async run(args, c) {
    const src = readSource(args);
    if (!src.ok) return src.result;
    const chosen = usdcToBase(args.price_usdc);
    if (chosen === null || chosen <= 0n) return badInput("price_usdc must be a positive decimal USDC amount.");
    const assessor = args.assessor ?? c.config.assessor;
    if (!assessor || !isAddress(assessor)) return refuse("NO_ASSESSOR", "Name a registered assessor (assessor, or DEAL_ASSESSOR).");
    if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Set DEAL_SITE_URL: the marketplace runs the assessor and the custody.");
    const ch = await needChain(c);
    if (!ch.ok) return ch.result;
    const s = needSigner(ch.value);
    if (!s.ok) return s.result;
    const { ctx } = ch.value;
    const seller = s.value;
    if (assessor === seller.address) return refuse("SELF_ASSESSED", "The assessor must not be the seller.");
    const reg = await fetchMaybeAssessorRegistry(ctx.client.rpc as never, await registryAddress());
    if (!reg.exists || !reg.data.assessors.includes(assessor as never)) return refuse("ASSESSOR_NOT_REGISTERED", "That assessor is not in the on-chain registry; buyers could not open deals on this listing.");

    const task = args.task ?? (src.value.kind === "Data" ? "Deliver the listed dataset exactly as assessed" : "Answer calls within the declared output schema");
    const d = await runSellerChain(c, src.value, { seller: seller.address, task, price: chosen, deliveryHours: args.delivery_hours ?? 24, reviewHours: args.review_hours ?? 6 });
    if (!d.ok) return d.result;
    const v = d.value;
    const meta = buildMeta({ name: args.name, description: args.description, category: args.category, tags: args.tags }, v.classification);
    if (!meta.ok) return meta.result;

    const site = c.config.siteUrl;
    const post = (path: string, body: unknown) =>
      (c.fetch ?? fetch)(new URL(path, site), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const bytes = v.source.kind === "Data" ? v.source.bytes : undefined;
    // The marketplace custody encrypts and keeps the key; this adapter only hands it the bytes. The site must accept
    // them only if sha256(bytes) equals the listing's on-chain content hash.
    const custody: Custody = {
      store: (_listing, data) => ({ ciphertext: data, contentHash: sha256(data) }),
      releaseKey: async () => ({ ok: false, reason: "NOT_HERE", message: "keys are released by the marketplace custody" }),
    };
    const att: { status: "requested" | "not_available" } = { status: "not_available" };
    const listingId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
    let published: Awaited<ReturnType<typeof publish>>;
    try {
      published = await publish(
        {
          seller: seller.address, listingId, meta: meta.value, price: chosen, report: v.report, reportHash: Uint8Array.from(Buffer.from(v.reportHash, "hex")),
          template: v.template, assessor, data: bytes, confirmedPii: args.confirm_personal_data === true,
        },
        {
          async ensureTokenAccount(owner) {
            await ctx.client.sendTransaction([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: seller, owner: owner as never, mint: ctx.mint })]);
          },
          async createListing(p) {
            const r = await listings.create(ctx, seller, { ...p, assessor: p.assessor as never });
            return r.ok ? { ok: true, listing: r.listing } : r;
          },
          async storeCiphertext(listing, data) {
            const r = await post("/api/sell/custody", { listing, seller: seller.address, data: Buffer.from(data).toString("base64") });
            if (!r.ok) throw Object.assign(new Error(`custody answered ${r.status}`), { listing });
          },
          async attest(p) {
            // The assessor service re-assesses on its own and signs attest_listing; it never trusts this report.
            const r = await post("/api/sell/assess", { listing: p.listing, contentHash: bytesToHex(p.contentHash), report: plain(v.report), reportHash: bytesToHex(p.reportHash) }).catch(() => null);
            att.status = r?.ok ? "requested" : "not_available";
            return { ok: true };
          },
        },
        bytes ? custody : undefined,
      );
    } catch (e) {
      const listing = (e as { listing?: string }).listing;
      return listing
        ? refuse("CUSTODY_FAILED", `The listing ${listing} is on chain but the marketplace custody did not take the data; it stays unbuyable until it does.`)
        : refuse("CHAIN_ERROR", e instanceof Error ? e.message.slice(0, 300) : String(e));
    }
    if (!published.ok) return published;
    return ok(plain({
      listing: published.listing, listingId: listingId.toString(), kind: v.report.kind, grade: v.report.grade, priceUsdc: args.price_usdc,
      contentHash: bytesToHex(published.contentHash), metaHash: bytesToHex(published.metaHash), termsHash: bytesToHex(published.termsTemplateHash),
      reportHash: v.reportHash, assessor, attestation: att.status,
      next: att.status === "requested"
        ? "The marketplace assessor will attest it; get_listing shows buyable: true once it has."
        : "The assessor service did not answer; the listing is not buyable until the assessor attests it.",
    }));
  },
});
