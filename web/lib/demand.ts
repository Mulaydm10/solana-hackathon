// Demand board (PLAN §4.3): what buyers searched for and found nothing, grouped by category, with the budgets
// they stated. Searches are untrusted text, so only plain visible text is kept, and the store is bounded.
import { isPlainText, type ListingKind } from "@deal/core";

export type DemandEntry = { q: string; category: string; kind?: ListingKind; budget?: bigint; at: number };
export type DemandGroup = { category: string; requests: number; budgets: { stated: number; median?: bigint; max?: bigint }; examples: string[] };

export function createDemandStore(o: { max?: number; now?: () => number } = {}) {
  const max = o.max ?? 1_000;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const entries: DemandEntry[] = [];
  return {
    /** Record a search that found nothing. Returns false when the text is not plain (dropped). */
    record(e: { q?: string; category?: string; kind?: ListingKind; budget?: bigint }): boolean {
      const q = e.q?.trim();
      if (!q || !isPlainText(q, 100)) return false;
      entries.push({ q, category: e.category ?? "uncategorized", kind: e.kind, budget: e.budget, at: now() });
      if (entries.length > max) entries.splice(0, entries.length - max);
      return true;
    },
    board(): DemandGroup[] {
      const by = new Map<string, DemandEntry[]>();
      for (const e of entries) by.set(e.category, [...(by.get(e.category) ?? []), e]);
      return [...by.entries()]
        .map(([category, es]) => {
          const budgets = es.flatMap((e) => (e.budget !== undefined ? [e.budget] : [])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const counts = new Map<string, number>();
          for (const e of es) counts.set(e.q.toLowerCase(), (counts.get(e.q.toLowerCase()) ?? 0) + 1);
          return {
            category,
            requests: es.length,
            budgets: { stated: budgets.length, ...(budgets.length ? { median: budgets[budgets.length >> 1]!, max: budgets[budgets.length - 1]! } : {}) },
            examples: [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([q]) => q),
          };
        })
        .sort((a, b) => b.requests - a.requests || (a.category < b.category ? -1 : 1));
    },
  };
}

/** One store per server process (a demo; persistence comes with the deploy). */
export const demand = createDemandStore();
