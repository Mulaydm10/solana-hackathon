import { z } from "zod";
import { defineTool, ok, refuse } from "../tool.ts";

// Only the fields the tool reports, coerced to plain types: the site's answer is data, never passed through as is.
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function shape(body: Record<string, unknown>) {
  const machines = Array.isArray(body.machines) ? body.machines.map(obj) : [];
  const rules = body.rules ? obj(body.rules) : null;
  const totals = obj(body.totals);
  const history = Array.isArray(body.history) ? body.history.map(obj).slice(0, 5) : [];
  return {
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
    "Read-only status of the machine-economy demo (peaq track): a simulated delivery robot that pays a simulated charging pad on Solana devnet under an on-chain mandate, settled on a signed meter reading, with peaq events for both machines. Returns both machines' peaq IDs and credit rating (or that it is not served on testnet), how much of the robot's mandate is left, totals, and the last charges with their Solana release and peaq event transactions. Needs DEAL_SITE_URL. Signs nothing.",
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
