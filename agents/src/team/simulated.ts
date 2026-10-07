/**
 * Simulated AI demo (#191): a stand-in for the model behind the SAME broker interface as the Claude provider
 * (`llm:complete`, one prompt in, plain text out). The orchestrator, the isolated workers, the quarantined reader,
 * the strict worker message schema, the mandates and the program all run exactly as with a live model; only the
 * text is produced by this deterministic code. Every output says so: it is never presented as Claude, a live model
 * call or real AI reasoning. Like the model, it can only return text: amounts and payees stay in the workers' code.
 */
import type { Provider } from "../broker/broker.ts";
import { LLM_LIMITS } from "./limits.ts";

export const SIMULATED_LABEL = "Simulated AI demo";
const BANNER = `[${SIMULATED_LABEL}: deterministic simulation, not a live model]`;

type City = { areas: string[]; sights: string[]; food: string[]; transport: string };

/** Sweets, pastries and snacks: listed as food, never offered as a dinner. */
const SWEET = /\b(pasteis?|pastel|nata|gelato|ice cream|crepes?|churros?|croissants?|pastr(y|ies)|cakes?|desserts?|sweets?|cookies?|waffles?|donuts?|mochi|dango|baklava)\b/i;

/** A small, hand-written guide per destination; anything else gets a generic plan built from the goal. */
const CITIES: Record<string, City> = {
  lisbon: {
    areas: ["Baixa/Chiado for first-timers", "Alfama for character", "Principe Real for quiet evenings"],
    sights: ["Alfama and the Castelo de Sao Jorge", "Tram 28 across the old town", "Belem: the tower and the Jeronimos Monastery", "LX Factory", "Miradouro da Senhora do Monte at sunset", "Day trip to Sintra (Pena Palace)", "Time Out Market", "Fado in Alfama"],
    food: ["pasteis de nata", "bifana", "grilled sardines", "bacalhau"],
    transport: "Walk the centre; Viva Viagem card for metro, trams and the Sintra train",
  },
  paris: {
    areas: ["Le Marais", "Saint-Germain-des-Pres", "Montmartre on a budget"],
    sights: ["Louvre (booked opening slot)", "Seine walk to Notre-Dame and Ile Saint-Louis", "Musee d'Orsay", "Montmartre and Sacre-Coeur", "Eiffel Tower at dusk", "Le Marais and Place des Vosges", "Canal Saint-Martin", "Day trip to Versailles"],
    food: ["croissants from a local boulangerie", "steak frites", "falafel in the Marais", "crepes"],
    transport: "Metro with a Navigo Easy card; most central sights are walkable",
  },
  rome: {
    areas: ["Centro Storico", "Trastevere", "Monti"],
    sights: ["Colosseum and Roman Forum (timed entry)", "Pantheon and Piazza Navona", "Vatican Museums and St Peter's", "Trevi Fountain early in the morning", "Trastevere evening walk", "Villa Borghese gardens", "Testaccio market", "Appian Way by bike"],
    food: ["cacio e pepe", "supplì", "carbonara", "gelato"],
    transport: "Walk the centre; metro lines A and B for the Vatican and Colosseum",
  },
  barcelona: {
    areas: ["Eixample", "El Born", "Gracia"],
    sights: ["Sagrada Familia (booked)", "Gothic Quarter walk", "Park Guell", "Casa Batllo and Passeig de Gracia", "Barceloneta beach", "Montjuic and the Magic Fountain", "La Boqueria market", "Bunkers del Carmel at sunset"],
    food: ["tapas", "pa amb tomaquet", "paella", "churros"],
    transport: "T-casual metro card; walk between the old town and the beach",
  },
  berlin: {
    areas: ["Mitte", "Kreuzberg", "Prenzlauer Berg"],
    sights: ["Brandenburg Gate and Reichstag dome (booked)", "Museum Island", "East Side Gallery", "Berlin Wall Memorial", "Tempelhofer Feld", "Kreuzberg canal walk", "Topography of Terror", "Day trip to Potsdam"],
    food: ["currywurst", "doner kebab", "Kaffee und Kuchen", "Vietnamese food in Prenzlauer Berg"],
    transport: "AB day ticket for U-Bahn and S-Bahn; bikes everywhere",
  },
  amsterdam: {
    areas: ["Jordaan", "De Pijp", "Canal Belt"],
    sights: ["Rijksmuseum", "Anne Frank House (booked)", "Jordaan canals", "Van Gogh Museum", "Vondelpark by bike", "Albert Cuyp market", "NDSM wharf by ferry", "Day trip to Zaanse Schans"],
    food: ["stroopwafels", "bitterballen", "Indonesian rijsttafel", "herring"],
    transport: "Bike rental or a GVB day pass; the centre is walkable",
  },
  london: {
    areas: ["South Bank", "Covent Garden", "Shoreditch"],
    sights: ["British Museum", "South Bank walk to Tower Bridge", "Tower of London", "Borough Market", "Westminster and the Abbey", "Notting Hill and Portobello Road", "Camden", "Greenwich"],
    food: ["fish and chips", "Sunday roast", "curry on Brick Lane", "afternoon tea"],
    transport: "Contactless on the Tube and buses (daily cap applies)",
  },
  prague: {
    areas: ["Old Town", "Mala Strana", "Vinohrady"],
    sights: ["Old Town Square and the astronomical clock", "Charles Bridge at sunrise", "Prague Castle", "Mala Strana streets", "Letna Park beer garden", "Vysehrad", "Jewish Quarter", "Petrin Hill"],
    food: ["svickova", "trdelnik", "goulash", "Czech beer"],
    transport: "Trams and metro with a 24-hour ticket; the centre is walkable",
  },
  tokyo: {
    areas: ["Shinjuku", "Asakusa", "Shibuya"],
    sights: ["Senso-ji in Asakusa", "Shibuya Crossing and Shibuya Sky", "Meiji Shrine and Harajuku", "Tsukiji Outer Market", "teamLab Planets", "Shinjuku Gyoen", "Akihabara", "Day trip to Nikko or Kamakura"],
    food: ["sushi", "ramen", "yakitori", "tempura"],
    transport: "Suica card for JR and metro",
  },
  "new york": {
    areas: ["Midtown", "Lower East Side", "Williamsburg"],
    sights: ["Central Park", "The Met", "High Line and Chelsea Market", "Statue of Liberty ferry", "Brooklyn Bridge walk", "MoMA", "Greenwich Village", "Top of the Rock at sunset"],
    food: ["bagels", "pizza by the slice", "pastrami on rye", "dumplings in Chinatown"],
    transport: "OMNY contactless on the subway",
  },
};

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export type GoalFacts = { destination: string; key: string | null; days: number; travellers: number | null; budget: string | null; style: string };

/** What the simulation reads from the customer's goal: destination, duration, party size, budget. */
export function readGoal(goal: string): GoalFacts {
  const g = goal.replace(/\s+/g, " ").trim();
  const lower = g.toLowerCase();
  const key = Object.keys(CITIES).find((c) => lower.includes(c)) ?? null;
  const named = g.match(/\b(?:to|in|around|across|through|visit)\s+((?:[A-Z][\p{L}'-]*)(?:\s+(?:[A-Z][\p{L}'-]*|de|del|la|le|of))*)/u)?.[1];
  const destination = key ? key.replace(/\b\w/g, (c) => c.toUpperCase()) : named ?? "your destination";
  const d = g.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[- ](?:days?|nights?)\b/i);
  const days = Math.min(Math.max(d ? Number(d[1]) || WORDS[d[1]!.toLowerCase()]! : /\bweekend\b/i.test(g) ? 2 : 3, 1), 14);
  const t = g.match(/\bfor\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  const travellers = t ? Number(t[1]) || WORDS[t[1]!.toLowerCase()]! : /\bcouple\b/i.test(g) ? 2 : null;
  // The first amount that reads as money (a currency, or "under/budget/up to" before it), not "3-day".
  const money = [...g.matchAll(/(?:\b(?:under|below|max(?:imum)?|budget(?: of)?|up to)\s+)?(?:€|\$|£)?\s*\d[\d,.]*\s*(?:eur\b|euros?\b|usd\b|dollars?\b|usdc\b|gbp\b|€|\$|£)?/gi)]
    .map((m) => m[0].trim())
    .find((m) => /(eur|usd|dollar|usdc|gbp|€|\$|£)/i.test(m) || /^(under|below|max|budget|up to)/i.test(m));
  const budget = money ?? null;
  const style = /\b(luxury|luxurious|5[- ]star)\b/i.test(g) ? "comfortable"
    : /\bmid[- ]range\b/i.test(g) ? "mid-range"
    : /\b(cheap|backpack(?:ing|er)?|low[- ]cost|frugal|on a budget|budget (?:trip|travel|hotels?|stay))\b/i.test(g) ? "budget" : "mid-range";
  return { destination, key, days, travellers, budget, style };
}

const between = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`))?.[1] ?? "";
const goalOf = (prompt: string) => prompt.match(/^Customer goal: (.*)$/m)?.[1] ?? "";

function research(prompt: string): string {
  const f = readGoal(goalOf(prompt));
  const c = f.key ? CITIES[f.key]! : null;
  let quote = "";
  try {
    const d = JSON.parse(between(prompt, "data")) as { marketQuote?: { resource?: unknown; price?: unknown } | null };
    // Only a number is taken from the data block; any other text in it is never repeated.
    if (d.marketQuote && /^\d+(\.\d+)?$/.test(String(d.marketQuote.price))) quote = `EURUSD ${String(d.marketQuote.price)} (from the market data capability)`;
  } catch {
    // no usable data: research from the goal alone
  }
  const lines = [
    BANNER,
    `Destination: ${f.destination} · ${f.days} day${f.days === 1 ? "" : "s"}${f.travellers ? ` · ${f.travellers} traveller${f.travellers === 1 ? "" : "s"}` : ""} · ${f.style}${f.budget ? ` · budget ${f.budget}` : ""}`,
    `Stay: ${c ? c.areas.join("; ") : "a central, walkable neighbourhood near public transport"}`,
    `Sights: ${(c ? c.sights : ["the old town on foot", "the main museum", "a viewpoint at sunset", "the central market", "a local neighbourhood", "a day trip nearby"]).join("; ")}`,
    `Food: ${c ? c.food.join(", ") : "local markets and a couple of well-reviewed local restaurants"}`,
    `Getting around: ${c ? c.transport : "walk the centre and use a public transport day pass"}`,
  ];
  if (quote) lines.push(`Money: ${quote}`);
  if (f.budget) lines.push(`Budget note: keep to ${f.budget} in total; book the paid sights ahead, and the plan leaves free evenings.`);
  return lines.join("\n");
}

function write(prompt: string): string {
  const f = readGoal(goalOf(prompt));
  let notes = "";
  try {
    const inputs = JSON.parse(between(prompt, "research")) as { role?: unknown; output?: unknown }[];
    notes = inputs.filter((x) => x && x.role === "researcher" && typeof x.output === "string").map((x) => x.output as string).join("\n");
  } catch {
    // no research stage result: plan from the goal alone
  }
  // Build on the research stage: its "Sights:" and "Food:" lines, else the guide, else a generic plan.
  const fromNotes = (label: string) => notes.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1]?.split(/;|,/).map((s) => s.trim()).filter(Boolean) ?? [];
  const c = f.key ? CITIES[f.key] : null;
  const sights = fromNotes("Sights").length ? fromNotes("Sights") : c?.sights ?? ["the old town on foot", "the main museum", "a viewpoint at sunset", "the central market", "a local neighbourhood", "a day trip nearby"];
  const food = fromNotes("Food").length ? fromNotes("Food") : c?.food ?? ["a local speciality"];
  const stay = notes.match(/^Stay: (.+)$/m)?.[1]?.split(";")[0]?.trim() ?? c?.areas[0] ?? "a central neighbourhood";
  const lines = [
    BANNER,
    `${f.destination}: ${f.days}-day plan${f.travellers ? ` for ${f.travellers}` : ""} (${f.style}${f.budget ? `, ${f.budget}` : ""})`,
    `Base: ${stay}. ${notes ? "Built on the research stage's notes." : "No research notes were available; planned from the goal."}`,
    "",
  ];
  // Dinner is a savoury dish: sweets and pastries from the food list are snacks, never "Dinner: pasteis de nata".
  const dinners = food.filter((x) => !SWEET.test(x));
  const dinner = (i: number) => (dinners.length ? dinners[i % dinners.length]! : "a local restaurant");
  let s = 0;
  const next = () => sights[s++ % sights.length]!;
  for (let d = 1; d <= f.days; d++) {
    if (d === 1 && f.days > 1) lines.push(`Day ${d}`, `  Morning: Arrive in ${f.destination}, check in near ${stay}`, `  Afternoon: ${next()}`, `  Evening: Dinner: ${dinner(0)}`);
    else if (d === f.days && f.days > 1) lines.push(`Day ${d}`, `  Morning: ${next()}`, `  Afternoon: Last walk and souvenirs; head to the station or airport`, `  Evening: Departure`);
    else lines.push(`Day ${d}`, `  Morning: ${next()}`, `  Afternoon: ${next()}`, `  Evening: Dinner: ${dinner(d)}`);
  }
  lines.push("", `Budget: ${f.budget ? `target ${f.budget.replace(/^(?:under|below|max(?:imum)?|up to|budget(?: of)?)\s+/i, "")} in total` : `${f.style} choices throughout`}; nothing is booked or paid without your approval.`);
  return lines.join("\n");
}

/** The Simulated AI demo provider: same id, action and argument limits as the Claude provider. */
export function simulatedProvider(): Provider {
  return {
    id: "llm",
    hosts: [],
    async call(action, _resource, args) {
      if (action !== "complete") throw new Error(`unknown action ${action}`);
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.system !== "string" || typeof a.prompt !== "string") throw new Error("BAD_ARGS: send { system, prompt } as strings");
      if (a.system.length > LLM_LIMITS.system || a.prompt.length > LLM_LIMITS.prompt) throw new Error("TOO_LONG: system or prompt over the limit");
      // The role is the system prompt's opening sentence ("You are the writer agent ..."), not any later mention.
      const text = /^You are the writer agent\b/.test(a.system) ? write(a.prompt) : research(a.prompt);
      return { text: text.slice(0, LLM_LIMITS.output), model: "simulated" };
    },
  };
}
