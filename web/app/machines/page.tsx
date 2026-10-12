// /machines (#229, peaq track): a simulated delivery robot pays a simulated charging pad on Solana devnet, settled on
// the pad's signed meter reading, with peaq events for both machines. Fails closed when not configured.
import { parseEnv, requireEnv } from "../../lib/env";
import { machineStatus, type MachineStatus } from "../../lib/machines-status";
import { MachinesView } from "./machines-view";

export const dynamic = "force-dynamic";

export default async function Machines() {
  const env = requireEnv(parseEnv(process.env), "machines");
  let status: MachineStatus | null = null;
  let problem: string | null = env.ok ? null : "The machine demo is not configured on this deployment.";
  if (env.ok) {
    try {
      status = await machineStatus(env.env);
    } catch {
      problem = "Machine status could not be read right now. Try again shortly.";
    }
  }
  return (
    <main>
      {/* This page needs no wallet, and the marketplace's event ticker is not about machines: hide both here only. */}
      <style>{".ticker, [data-testid=wallet-none] { display: none !important; }"}</style>
      <header className="page-head">
        <span className="eyebrow">Machines · simulated · settled on Solana devnet · recorded on peaq</span>
        <h1>Charge on <em>delivery</em></h1>
        <p>
          One loop, with no human per payment: a delivery robot earns (a shop pays it per delivery), its battery drops,
          it chooses one of three charging pads by price and track record, and pays into escrow. The pad proves the energy
          it delivered with a signed meter reading (hashed on chain); the robot releases exactly that payment, and both
          machines get the event on peaq. The owner set the rules once, on chain: at most 0.50 USDC per charge, 35 USDC in
          total, only these three pads. Each pad insures itself against downtime from its own earnings.
        </p>
        <p className="fine">
          The machines, battery, driving, deliveries and outages are simulated. Their peaq machine IDs, peaq events and Solana
          transactions are real; the money is devnet test USDC.
        </p>
      </header>
      {status ? <MachinesView initial={status} /> : <p data-testid="machines-not-configured" className="empty-note">{problem}</p>}
    </main>
  );
}
