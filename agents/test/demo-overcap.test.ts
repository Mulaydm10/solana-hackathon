// #214: missions of the site's demo buyer ("Try the demo") show one over-cap payment refused on chain; real
// missions never do.
import test from "node:test";
import assert from "node:assert/strict";
import { workerEnvFor } from "../src/index.ts";

const DEMO = "818us7NCb6bC3ByXSyBbHVG94irA2NAacKmxubonVngr";
const REAL = "4a5vnQM3ad6NAfhunBxxqbECfxbEFJzHtsW2KAUZj7cp";

test("a demo buyer's mission starts the researcher with TRY_OVER_CAP=1", () => {
  const env = workerEnvFor({ demoBuyers: [DEMO] }, DEMO);
  assert.equal(env?.researcher?.TRY_OVER_CAP, "1");
});

test("a real buyer's mission never gets TRY_OVER_CAP", () => {
  assert.equal(workerEnvFor({ demoBuyers: [DEMO] }, REAL)?.researcher?.TRY_OVER_CAP, undefined);
  assert.equal(workerEnvFor({}, REAL), undefined);
  assert.equal(workerEnvFor({ demoBuyers: [] }, DEMO), undefined, "no demo buyers configured: nobody gets it");
});

test("only the researcher gets it, and the service's own worker env is kept", () => {
  const base: Record<string, Record<string, string>> = { researcher: { FOO: "1" }, writer: { BAR: "2" } };
  const env = workerEnvFor({ demoBuyers: [DEMO], workerEnv: base }, DEMO);
  assert.equal(env?.writer?.TRY_OVER_CAP, undefined);
  assert.deepEqual(env, { researcher: { FOO: "1", TRY_OVER_CAP: "1" }, writer: { BAR: "2" } });
  assert.deepEqual(base.researcher, { FOO: "1" }, "the service's own env object is not mutated");
  assert.equal(workerEnvFor({ demoBuyers: [DEMO], workerEnv: base }, REAL), base, "real missions get the service env unchanged");
});
