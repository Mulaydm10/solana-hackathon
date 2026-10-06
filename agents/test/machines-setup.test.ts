// #228: the machine demo's setup helpers: keys (created once, 0600, reused, validated), the owner's rules document
// and the robot's mandate, and the site env file (only after both setups; never printed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_DEFAULTS, fleetAddresses, fleetRules, loadFleetKeys, machineEnv, readFleetState, robotMandate, writeEnvFile, writeFleetState } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "fleet-"));

test("keys: created once with 0600 files, reused on the next run, and never created when not asked", () => {
  const dir = join(tmp(), "machines");
  assert.throws(() => loadFleetKeys(dir, false), /missing key/);
  const first = loadFleetKeys(dir, true);
  assert.deepEqual(first.created.sort(), ["owner", "pad", "padPeaq", "peaqOperator", "robot", "robotPeaq"]);
  for (const f of ["owner", "peaqOperator"]) assert.equal(statSync(join(dir, `${f}.key`)).mode & 0o777, 0o600);
  const again = loadFleetKeys(dir, true);
  assert.deepEqual(again.created, []);
  assert.deepEqual(fleetAddresses(again.keys), fleetAddresses(first.keys));
  const a = fleetAddresses(first.keys);
  assert.notEqual(a.robot, a.pad);
  assert.match(a.peaqOperator, /^0x[0-9a-fA-F]{40}$/);
});

test("keys: a corrupted key file is refused, not silently replaced", () => {
  const dir = tmp();
  loadFleetKeys(dir, true);
  const bad = JSON.parse(readFileSync(join(dir, "robot.key"), "utf8")) as number[];
  bad[40] = (bad[40]! + 1) % 256;
  writeFileSync(join(dir, "robot.key"), JSON.stringify(bad));
  assert.throws(() => loadFleetKeys(dir, true), /robot: not a valid 64-byte Solana keypair/);
});

test("rules: the robot's mandate is the plan's (0.50 per charge, 2 USDC cap, only the pad, stage 0) and the rules hash is stable", () => {
  const { keys } = loadFleetKeys(tmp(), true);
  const a = fleetAddresses(keys);
  const o = { robot: a.robot, pad: a.pad, cap: FLEET_DEFAULTS.cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt: 1_800_000_000 };
  const m = robotMandate(o);
  assert.equal(m.agent, a.robot);
  assert.equal(m.perTxCap, 500_000n);
  assert.equal(m.cap, 2_000_000n);
  assert.deepEqual(m.payees, [a.pad]);
  assert.equal(m.stageMask, 1);
  assert.deepEqual(fleetRules(o).hash, fleetRules({ ...o }).hash);
  assert.notDeepEqual(fleetRules(o).hash, fleetRules({ ...o, perCharge: 600_000n }).hash, "different rules, different hash");
  assert.ok(FLEET_DEFAULTS.days * 86_400 <= 30 * 86_400, "within the program's 30-day window");
});

test("site env: refused until both setups ran; written 0600 with self-reported peaq events (source chain 0)", () => {
  const dir = tmp();
  const { keys } = loadFleetKeys(dir, true);
  assert.throws(() => machineEnv(keys, readFleetState(dir), { peaqRpcUrl: "https://agung" }), /run fleet-setup and activate first/);
  writeFleetState(dir, { mission: "Dea1Address11111111111111111111111111111111", missionId: "1", expiresAt: 1 });
  assert.throws(() => machineEnv(keys, readFleetState(dir), { peaqRpcUrl: "https://agung" }), /run fleet-setup and activate first/);
  writeFleetState(dir, { ...readFleetState(dir), peaq: { network: "agung", eventRegistry: "0x2DAD8905380993940e340C5cE6d313d5c2780040", identityRegistry: "0x9E", robotMachineId: "348", padMachineId: "349" } });
  const env = machineEnv(keys, readFleetState(dir), { peaqRpcUrl: "https://agung" });
  assert.equal(env.PEAQ_SOURCE_CHAIN_ID, "0");
  assert.equal(env.ROBOT_MACHINE_ID, "348");
  assert.deepEqual(JSON.parse(env.ROBOT_AGENT_KEY!), Array.from(keys.robot));
  assert.equal(env.PEAQ_EVENT_KEY, keys.peaqOperator);
  assert.ok(!("MACHINE_OWNER_KEY" in env), "the owner key never goes to the site");
  const f = join(dir, "machines.env");
  writeEnvFile(f, env);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});
