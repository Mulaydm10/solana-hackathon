import { z } from "zod";
import { defineTool, ok, refuse } from "../tool.ts";

// Only the fields the tool reports, coerced to plain types: the site's answer is data, never passed through as is.
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const FACTORS = ["bond", "revenue", "activity", "tenure", "freshness", "penalty"] as const;

// v2 fields (site's "Machines v2"). Only when the site says v2 is configured; otherwise nothing is added.
function v2(body: Record<string, unknown>): Record<string, unknown> {
  if (obj(body.v2).configured !== true) return {};
  const out: Record<string, unknown> = {};
  if (Array.isArray(body.network)) {
    out.network = body.network.map(obj).map((p) => ({
      role: str(p.role), name: str(p.name), machineId: str(p.machineId), pricePerKwh: str(p.pricePerKwh), online: bool(p.online),
      lastHeartbeatAt: num(p.lastHeartbeatAt), upPct24h: num(p.upPct24h), score: num(p.score), grade: str(p.grade), provisioned: bool(p.provisioned),
    }));
  }
  if (body.scores && typeof body.scores === "object") {
    out.scores = Object.fromEntries(Object.entries(obj(body.scores)).map(([role, s]) => {
      const x = obj(s);
      const f = obj(x.factors);
      return [role, {
        score: num(x.score), grade: str(x.grade), provisioned: bool(x.provisioned),
        factors: Object.fromEntries(FACTORS.map((k) => [k, num(f[k])])),
        events: num(x.events), outages7d: num(x.outages7d), explain: str(x.explain),
      }];
    }));
  }
  if (body.insurance && typeof body.insurance === "object") {
    const list = obj(body.insurance).policies;
    const policies = Array.isArray(list) ? list.map(obj).slice(0, 10) : [];
    out.insurance = {
      policies: policies.map((p) => {
        const o = obj(p.outage);
        return {
          id: str(p.id), pad: str(p.pad), padAddress: str(p.padAddress), coverage: str(p.coverage), premium: str(p.premium), grade: str(p.grade),
          termStart: num(p.termStart), termEnd: num(p.termEnd), status: str(p.status), deal: str(p.deal),
          openSig: str(p.openSig), acceptSig: str(p.acceptSig), premiumSig: str(p.premiumSig), claimSig: str(p.claimSig), payoutSig: str(p.payoutSig), refundSig: str(p.refundSig),
          outage: p.outage && typeof p.outage === "object" ? {
            detectedAt: num(o.detectedAt), gapSecs: num(o.gapSecs), peaqEventTx: str(o.peaqEventTx), insurerCheck: str(o.insurerCheck), simulated: bool(o.simulated),
          } : null,
        };
      }),
    };
  }
  if (body.earnings && typeof body.earnings === "object") {
    const e = obj(body.earnings);
    const recent = Array.isArray(e.recent) ? e.recent.map(obj).slice(0, 10) : [];
    out.earnings = {
      jobs: num(e.jobs), earned: str(e.earned), spentOnEnergy: str(e.spentOnEnergy), net: str(e.net),
      recent: recent.map((j) => ({ id: str(j.id), at: num(j.at), amount: str(j.amount), deal: str(j.deal), releaseSig: str(j.releaseSig), robotEventTx: str(j.robotEventTx) })),
    };
  }
  return out;
}

function shape(body: Record<string, unknown>) {
  const machines = Array.isArray(body.machines) ? body.machines.map(obj) : [];
  const rules = body.rules ? obj(body.rules) : null;
  const totals = obj(body.totals);
  const history = Array.isArray(body.history) ? body.history.map(obj).slice(0, 5) : [];
  return {
    ...v2(body),
    simulated: true,
    note: "Both machines are simulated. Their peaq IDs, peaq events and Solana devnet transactions are real; the money is devnet test USDC.",
    peaqNetwork: str(body.deployment),
    mission: str(body.mission),
    machines: machines.map((m) => {
      const mcr = obj(m.mcr);
      return {
        role: str(m.role), name: str(m.name), peaqMachineId: str(m.machineId), solanaWallet: str(m.wallet),
        creditRating: str(mcr.status) ? { status: str(mcr.status), score: num(mcr.score) } : { notServed: str(mcr.unavailable) ?? "not available" },
      };
    }),
    robotMandate: rules && {
      perCharge: str(rules.perTxCap), cap: str(rules.cap), spent: str(rules.spent),
      left: rules.cap && rules.spent ? (Number(str(rules.cap)) - Number(str(rules.spent))).toFixed(2) : null,
      live: rules.live === true, expiresAt: num(rules.expiresAt),
    },
    totals: {
      settledCharges: num(totals.charges), refusedByProgram: num(totals.refused), kWh: str(totals.kWh), paidUsdc: str(totals.usdc), peaqEvents: num(totals.peaqEvents),
    },
    lastCharges: history.map((c) => ({
      at: num(c.at), amountUsdc: str(c.amount), kWh: str(c.kWh), refused: c.refused ? str(obj(c.refused).reason) : null,
      releaseSignature: str(c.releaseSig), padRevenueEventTx: str(c.padEventTx), robotActivityEventTx: str(c.robotEventTx),
    })),
  };
}

export default defineTool({
  name: "machine_status",
  description:
    "Read-only status of the machine-economy demo (peaq track): a simulated delivery robot that pays a simulated charging pad on Solana devnet under an on-chain mandate, settled on a signed meter reading, with peaq events for both machines. Returns both machines' peaq IDs and credit rating (or that it is not served on testnet), how much of the robot's mandate is left, totals, and the last charges with their Solana release and peaq event transactions. When the site reports v2 data, also the simulated pads' network (price, uptime, MCR-style score computed by Fiducia from peaq events), insurance policies and the robot's earnings. Needs DEAL_SITE_URL. Signs nothing.",
  input: {},
  writes: false,
  async run(_args, c) {
    if (!c.config.siteUrl) return refuse("NOT_CONFIGURED", "Set DEAL_SITE_URL to the marketplace site.");
    let r: Response;
    try {
      r = await (c.fetch ?? fetch)(new URL("/api/machines/status", c.config.siteUrl), { headers: { accept: "application/json" } });
    } catch {
      return refuse("SITE_UNAVAILABLE", "The marketplace site did not answer.");
    }
    const body = obj(await r.json().catch(() => null));
    if (r.status === 503 && body.reason === "NOT_CONFIGURED") return refuse("NOT_CONFIGURED", "The machine demo is not configured on the site yet.");
    if (!r.ok || body.ok !== true) return refuse("SITE_UNAVAILABLE", `The site could not report machine status (HTTP ${r.status}).`);
    return ok(shape(body));
  },
});
