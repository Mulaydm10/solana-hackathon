// Deterministic writer (until the Claude workers of PLAN §11): turns the goal and the earlier stages'
// results (INPUTS, already checked by the orchestrator's reader) into a day-by-day plan. Node built-ins only.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let next = 1;
rl.on("line", (l) => { const r = JSON.parse(l); pending.get(r.id)?.(r.result); pending.delete(r.id); });
const ask = (req) => new Promise((res) => { const id = next++; pending.set(id, res); process.stdout.write(JSON.stringify({ id, ...req }) + "\n"); });

const goal = (process.env.GOAL ?? "").trim();
let inputs = [];
try {
  const v = JSON.parse(process.env.INPUTS ?? "[]");
  if (Array.isArray(v)) inputs = v.filter((x) => x && typeof x.role === "string" && typeof x.output === "string");
} catch {
  // no usable inputs: plan from the goal alone
}
const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const m = goal.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[- ]days?\b/i) ?? goal.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+nights?\b/i);
const n = m ? Number(m[1]) || words[m[1].toLowerCase()] : 3;
const days = Math.min(Math.max(n, 1), 14);
const place = goal.match(/\b(?:to|in|around|across|through)\s+((?:[A-Z][\p{L}'-]*)(?:\s+(?:[A-Z][\p{L}'-]*|de|del|la|le|of))*)/u)?.[1]?.replace(/\s+(?:de|del|la|le|of)$/u, "") ?? "the destination";

const plan = (d) => {
  if (d === 1) return [`Arrive in ${place}, check in and drop the bags`, "Walk the central old town to get your bearings", "Dinner near the stay; early night"];
  if (d === days) return ["Pack, check out, leave bags at the stay", "One last neighbourhood or market you missed", "Head to the station or airport with time to spare"];
  const themes = [
    ["Main landmark or museum, booked for opening time", "Lunch in the historic centre, then a guided or self-guided walk", "Sunset viewpoint, then dinner at a local spot"],
    ["Day trip or nature outside the city", "Picnic or a long lunch on the way", "Back in town: evening in a lively district"],
    ["Local market and food tasting", "Second museum or gallery, or time at the waterfront", "Live music or a show"],
    ["Slow morning in a café", "Shopping street or a park", "Farewell dinner"],
  ];
  return themes[(d - 2) % themes.length];
};

const lines = [`Trip plan: ${goal || "your trip"}`, `Destination: ${place} · ${days} day${days === 1 ? "" : "s"}`, ""];
if (inputs.length) {
  lines.push("From the research stage:");
  for (const x of inputs) lines.push(`- ${x.role}: ${x.output.replace(/\s+/g, " ").slice(0, 400)}`);
  lines.push("");
}
for (let d = 1; d <= days; d++) {
  const [morning, afternoon, evening] = plan(d);
  lines.push(`Day ${d}`, `  Morning: ${morning}`, `  Afternoon: ${afternoon}`, `  Evening: ${evening}`);
}
lines.push("", "Budget and bookings: within the mission's on-chain caps; nothing is booked without your approval.");
const output = lines.join("\n").slice(0, 4_000);
await ask({ kind: "message", message: { type: "result", output } });
process.exit(0);
