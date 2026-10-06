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
      <header className="page-head">
        <span className="eyebrow">Machines · simulated · settled on Solana devnet · recorded on peaq</span>
        <h1>Charge on <em>delivery</em></h1>
        <p>
          A delivery robot&apos;s agent buys charging from a charging pad. The owner set the rules once, on chain: at most
          0.50 USDC per charge, 2 USDC in total, only this pad. After that the robot pays on its own, with no human per
          payment. The USDC waits in escrow until the pad proves the energy it delivered (a signed meter reading,
          hashed on chain), and each settled charge is written to peaq for both machines.
        </p>
        <p className="fine">
          Both machines are simulated. Their peaq machine IDs, peaq events and Solana transactions are real; the money
          is devnet test USDC.
        </p>
      </header>
      {status ? <MachinesView initial={status} /> : <p data-testid="machines-not-configured" className="empty-note">{problem}</p>}
    </main>
  );
}
