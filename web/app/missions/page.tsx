// Missions (#73): your hired team's progress, the next stage's plan to approve in your wallet, and one-click
// revoke for any agent. Status comes from the mission service; every approval and revoke is your own transaction.
import { Suspense } from "react";
import { MissionView } from "./mission-view";

export default function Missions() {
  return (
    <main>
      <h1>Missions</h1>
      <p>Your hired teams: stage approvals waiting for you, agents&apos; spends judged on chain, and the final product.</p>
      <Suspense fallback={<p>Loading…</p>}>
        <MissionView />
      </Suspense>
    </main>
  );
}
