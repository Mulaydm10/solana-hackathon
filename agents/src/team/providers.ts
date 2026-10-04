/**
 * Mock providers for team missions until real ones are wired (PLAN §6.1). Deterministic, so a mission
 * run is reproducible in tests; they still go through the broker like a real provider, credential and all.
 */
import type { Provider } from "../broker/broker.ts";

/** Market data: `read` a resource like "fx/EURUSD" -> a fixed quote derived from the name. */
export const mockMarketData: Provider = {
  id: "market",
  hosts: ["market.mock:443"],
  async call(action, resource, _args, credential) {
    if (!credential) throw new Error("no credential");
    if (action !== "read") throw new Error(`unknown action ${action}`);
    const seed = [...resource].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 10_000, 7);
    return { resource, price: (1 + seed / 10_000).toFixed(4), asOf: "2026-10-04" };
  },
};

/** Bookings: `quote` is free, `pay` is elevated (needs the buyer's one-time signature). */
export const mockBooking: Provider = {
  id: "booking",
  hosts: ["booking.mock:443"],
  elevated: ["pay"],
  async call(action, resource) {
    if (action === "quote") return { resource, total: "120.00", currency: "USD" };
    if (action === "pay") return { resource, confirmation: `MOCK-${resource.replace(/\W/g, "").toUpperCase()}` };
    throw new Error(`unknown action ${action}`);
  },
};
