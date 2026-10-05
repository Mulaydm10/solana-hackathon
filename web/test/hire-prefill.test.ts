// #216: /hire?team=&goal=&budget= (MCP hire_team's link) prefills the hire form; invalid values are ignored.
import test from "node:test";
import assert from "node:assert/strict";
import { hirePrefill } from "../lib/hire-prefill.ts";

const TEAM = "4eBKg9mvCEw8ZXhadXwmBfoqYSPWg1VTruhrKNoBvrVV";
const OTHER = "6X3vEeQQYk9qQ1LrwmwXzZGgknLJp3GqCRMA9T6UxJod";
const TEAMS = [TEAM];

test("the link MCP hire_team returns prefills team, goal and budget", () => {
  // Built exactly as mcp/src/tools/hire_team.ts builds it.
  const u = new URL("/hire", "https://fiducia-orpin.vercel.app");
  u.searchParams.set("team", TEAM);
  u.searchParams.set("goal", "Plan 3 days in Lisbon for two, under 400 EUR");
  u.searchParams.set("budget", "12.5");
  const query = Object.fromEntries(u.searchParams);
  assert.deepEqual(hirePrefill(query, TEAMS), { team: TEAM, goal: "Plan 3 days in Lisbon for two, under 400 EUR", budget: "12.5" });
});

test("no query: nothing is prefilled (the form keeps its defaults)", () => {
  assert.deepEqual(hirePrefill({}, TEAMS), {});
});

test("a team that is not a hireable Team listing is ignored", () => {
  assert.deepEqual(hirePrefill({ team: OTHER }, TEAMS), {});
  assert.deepEqual(hirePrefill({ team: "not-an-address" }, TEAMS), {});
});

test("goal: trimmed; too short, too long or not plain text is ignored", () => {
  assert.equal(hirePrefill({ goal: "  Research EV charging in Berlin  " }, TEAMS).goal, "Research EV charging in Berlin");
  assert.equal(hirePrefill({ goal: "ab" }, TEAMS).goal, undefined);
  assert.equal(hirePrefill({ goal: "x".repeat(2001) }, TEAMS).goal, undefined);
  assert.equal(hirePrefill({ goal: "Plan a trip ‮ evil" }, TEAMS).goal, undefined, "bidi override");
  assert.equal(hirePrefill({ goal: "Plan a trip\u0007" }, TEAMS).goal, undefined, "control character");
  assert.equal(hirePrefill({ goal: "Day 1: Lisbon\nDay 2: Sintra" }, TEAMS).goal, "Day 1: Lisbon\nDay 2: Sintra", "line breaks are fine");
});

test("budget: positive decimal USDC with at most 6 decimals, else ignored", () => {
  for (const ok of ["10", "0.5", "12.123456", "999999999"]) assert.equal(hirePrefill({ budget: ok }, TEAMS).budget, ok, ok);
  for (const bad of ["0", "0.0", "-5", "1e3", "12.1234567", "abc", "10 USDC", "1,5", "", "01"]) {
    assert.equal(hirePrefill({ budget: bad }, TEAMS).budget, undefined, JSON.stringify(bad));
  }
});

test("repeated parameters use the first value", () => {
  assert.deepEqual(hirePrefill({ team: [TEAM, OTHER], budget: ["5", "50"] }, TEAMS), { team: TEAM, budget: "5" });
});
