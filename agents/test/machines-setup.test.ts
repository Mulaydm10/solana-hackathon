// #228: the machine demo's setup helpers: keys (created once, 0600, reused, validated), the owner's rules document
// and the robot's mandate, and the site env file (only after both setups; never printed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNetworkState, NETWORK_DEFAULT_PRICES, networkAddresses, networkPads } from "../src/index.ts";
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

// ---------- peaq v2 network (#272) ----------
test("network keys: pad2, pad3, insurer, verifier, shop (+ peaq keys) created 0600, reused, absent unless asked, never in output", () => {
  const dir = join(tmp(), "machines");
  assert.equal((loadFleetKeys(dir, true).keys as { pad2?: unknown }).pad2, undefined, "the v1 call does not create the v2 keys");
  const first = loadFleetKeys(dir, true, { network: true });
  assert.deepEqual(first.created.sort(), ["insurer", "pad2", "pad2Peaq", "pad3", "pad3Peaq", "shop", "verifier"]);
  for (const f of ["pad2", "pad3", "insurer", "verifier", "shop", "pad2Peaq", "pad3Peaq"]) assert.equal(statSync(join(dir, `${f}.key`)).mode & 0o777, 0o600);
  const again = loadFleetKeys(dir, true, { network: true });
  assert.deepEqual(again.created, []);
  const n = networkAddresses(again.keys);
  assert.deepEqual(n, networkAddresses(first.keys));
  assert.equal(new Set([n.pad2, n.pad3, n.insurer, n.verifier, n.shop, fleetAddresses(again.keys).pad]).size, 6, "all distinct");
  const shown = JSON.stringify([n, fleetAddresses(again.keys)]);
  for (const k of [again.keys.pad2, again.keys.shop, again.keys.insurer, again.keys.verifier]) assert.ok(!shown.includes(JSON.stringify(Array.from(k))));
  assert.ok(!shown.includes(again.keys.pad2Peaq) && !shown.includes(again.keys.pad3Peaq));
  assert.throws(() => loadFleetKeys(join(tmp(), "none"), false, { network: true }), /missing key/);
});

test("network state: pads pad, pad2, pad3 with machine ids, addresses and the default prices; custom prices kept", () => {
  const { keys } = loadFleetKeys(tmp(), true, { network: true });
  const ids = { pad: "349", pad2: "400", pad3: "401" };
  const s = buildNetworkState(keys, { machineIds: ids, mission: "Mission1111", missionId: "2", expiresAt: 5 });
  assert.deepEqual(s.pads.map((p) => [p.role, p.machineId, p.pricePerKwhMicro]), [["pad", "349", "320000"], ["pad2", "400", "280000"], ["pad3", "401", "300000"]]);
  assert.deepEqual(NETWORK_DEFAULT_PRICES, { pad: 320_000n, pad2: 280_000n, pad3: 300_000n });
  const a = fleetAddresses(keys), n = networkAddresses(keys);
  assert.equal(s.pads[0]!.address, a.pad);
  assert.equal(s.pads[1]!.peaqAddress, n.pad2Peaq);
  assert.equal(s.insurer, n.insurer);
  assert.equal(s.verifier, n.verifier);
  assert.equal(s.shop, n.shop);
  assert.equal(s.mission, "Mission1111");
  assert.equal(networkPads(keys, ids, { pad2: 250_000n })[1]!.pricePerKwhMicro, "250000");
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "plain JSON, no bigint");
});

test("network mission: the robot mandate pays exactly the three pads (and the rules document lists them)", () => {
  const { keys } = loadFleetKeys(tmp(), true, { network: true });
  const a = fleetAddresses(keys), n = networkAddresses(keys);
  const o = { robot: a.robot, pads: [a.pad, n.pad2, n.pad3] as typeof a.pad[], cap: FLEET_DEFAULTS.cap, perCharge: FLEET_DEFAULTS.perCharge, expiresAt: 1_800_000_000 };
  assert.deepEqual(robotMandate(o).payees, [a.pad, n.pad2, n.pad3]);
  assert.equal(robotMandate(o).perTxCap, 500_000n);
  assert.deepEqual((fleetRules(o).doc as { pads: string[] }).pads, [a.pad, n.pad2, n.pad3]);
});

test("site env v2: PAD2_KEY, PAD3_KEY, PAD_PEAQ_KEYS, INSURER_KEY, SHOP_KEY, MACHINE_NETWORK, INSURANCE_VERIFIER, written 0600", () => {
  const dir = tmp();
  const { keys } = loadFleetKeys(dir, true, { network: true });
  const peaq = { network: "agung", eventRegistry: "0x2DAD8905380993940e340C5cE6d313d5c2780040", identityRegistry: "0x9E", robotMachineId: "348", padMachineId: "349" };
  writeFleetState(dir, { mission: "V1Mission", missionId: "1", expiresAt: 1, peaq });
  const v1 = machineEnv(keys, readFleetState(dir), { peaqRpcUrl: "https://agung" });
  assert.ok(!("PAD2_KEY" in v1), "no network section, v1 env unchanged");
  writeFleetState(dir, { ...readFleetState(dir), network: buildNetworkState(keys, { machineIds: { pad: "349", pad2: "400", pad3: "401" }, mission: "NetMission", missionId: "2", expiresAt: 9 }) });
  const env = machineEnv(keys, readFleetState(dir), { peaqRpcUrl: "https://agung" });
  for (const k of ["PAD2_KEY", "PAD3_KEY", "PAD_PEAQ_KEYS", "INSURER_KEY", "SHOP_KEY", "MACHINE_NETWORK", "INSURANCE_VERIFIER"]) assert.ok(env[k], k);
  assert.deepEqual(JSON.parse(env.PAD2_KEY!), Array.from(keys.pad2));
  assert.deepEqual(JSON.parse(env.SHOP_KEY!), Array.from(keys.shop));
  assert.deepEqual(JSON.parse(env.PAD_PEAQ_KEYS!), { pad: keys.padPeaq, pad2: keys.pad2Peaq, pad3: keys.pad3Peaq });
  assert.equal(JSON.parse(env.MACHINE_NETWORK!).pads.length, 3);
  assert.equal(env.INSURANCE_VERIFIER, networkAddresses(keys).verifier);
  assert.equal(env.MACHINE_MISSION, "NetMission", "the web mission is the one paying all three pads");
  assert.ok(!("MACHINE_OWNER_KEY" in env));
  assert.throws(() => machineEnv(loadFleetKeys(dir, false).keys, readFleetState(dir)), /network keys are not loaded/);
  const f = join(dir, "net.env");
  writeEnvFile(f, env);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});
