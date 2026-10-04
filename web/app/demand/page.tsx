import { demand } from "../../lib/demand";
import { usdc } from "../../lib/catalogue-json";

export const dynamic = "force-dynamic";

export default function Demand() {
  const board = demand.board();
  return (
    <main>
      <h1>Demand</h1>
      <p>What buyers searched for and found nothing, grouped by category, with the budgets they stated. Sellers: this is what to list.</p>
      {board.length === 0 ? (
        <p data-testid="demand-empty">No unmet searches yet.</p>
      ) : (
        <table data-testid="demand">
          <thead><tr><th>Category</th><th>Searches</th><th>Budget (median / max)</th><th>Asked for</th></tr></thead>
          <tbody>
            {board.map((g) => (
              <tr key={g.category}>
                <td>{g.category}</td>
                <td>{g.requests}</td>
                <td>{g.budgets.median !== undefined ? `${usdc(g.budgets.median)} / ${usdc(g.budgets.max!)}` : "not stated"}</td>
                <td>{g.examples.map((q) => `"${q}"`).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
