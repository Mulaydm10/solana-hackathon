// #241: events on both EventRegistry versions (agung v1 without currency, mainnet v2), and the peaq mainnet
// fallback's activation parameters. No network: chain I/O is stubbed with the selectors read on chain on 7 Oct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ed25519Multibase, eventParams, fleetAddresses, loadFleetKeys, machineActivation, machineEnv, PEAQ_AGUNG, PEAQ_MAINNET, registryVersion, sdkSubmit,
  v1Args, writeFleetState, readFleetState, type RegistryIo,
} from "../src/index.ts";

const REG = "0x2DAD8905380993940e340C5cE6d313d5c2780040";
const IMPL = "0x21d32ff6fbb5ebd1f65a2196b1c705172a820d04";
const slot = `0x${"0".repeat(24)}${IMPL.slice(2)}` as const;
const io = (code: string, opts: { ok?: boolean } = {}) => {
  const writes: unknown[][] = [];
  const x: RegistryIo = {
    getStorageAt: async () => slot, getCode: async (a) => (a.toLowerCase() === IMPL ? (`0x00${code}00` as const) : "0x"),
    writeV1: async (_r, args) => (writes.push([...args]), "0xabc"), waitOk: async () => opts.ok ?? true,
  };
  return { x, writes };
};
const settlement = { chargeId: "c", deal: "Dea1Address11111111111111111111111111111111" as never, releaseSignature: "sig", deliveryHash: new Uint8Array(32).fill(1), amount: 400_000n };

test("registry version from the implementation's selectors: agung v1, mainnet v2, anything else refused", async () => {
  assert.equal(await registryVersion(io("6b58c7dc").x, REG), 1);
  assert.equal(await registryVersion(io("e58a43ca").x, REG), 2);
  assert.equal(await registryVersion(io("deadbeef").x, REG), 0);
});

test("v1 event: v2's arguments without currency, dataHash = keccak256(rawData), sent once and confirmed", async () => {
  const p = eventParams("revenue", 12n, settlement, { sourceChainId: 0 }, "Prog", 1_800_000_000);
  assert.ok(p.ok);
  const args = v1Args(p.params);
  assert.deepEqual(args.slice(0, 4), [12n, 0, 40n, 1_800_000_000n]);
  assert.equal(args[4], keccak256(p.params.rawData));
  assert.deepEqual(args.slice(5, 7), [0, 0n]);
  assert.equal(args[7], p.params.sourceTxHash);
  const { x, writes } = io("6b58c7dc");
  const submit = sdkSubmit({ rpcUrl: "x", deployment: "agung", eventRegistry: REG, sourceChainId: 0 }, `0x${"11".repeat(32)}`, x);
  assert.deepEqual(await submit(p.params), { txHash: "0xabc" });
  assert.equal(writes.length, 1);
  const reverted = sdkSubmit({ rpcUrl: "x", deployment: "agung", eventRegistry: REG, sourceChainId: 0 }, `0x${"11".repeat(32)}`, io("6b58c7dc", { ok: false }).x);
  await assert.rejects(reverted(p.params), (e: { code?: string }) => e.code === "REVERTED");
  const none = sdkSubmit({ rpcUrl: "x", deployment: "agung", eventRegistry: REG, sourceChainId: 0 }, `0x${"11".repeat(32)}`, io("deadbeef").x);
  await assert.rejects(none(p.params), (e: { code?: string }) => e.code === "NOT_AN_EVENT_REGISTRY");
});

test("mainnet activation: Entry tier, DID key = the machine's Solana key, subject names its wallet, ids differ", () => {
  const { keys } = loadFleetKeys(mkdtempSync(join(tmpdir(), "act-")), true);
  const a = fleetAddresses(keys);
  const robot = machineActivation("robot", keys.robot, a.peaqOperator);
  const pad = machineActivation("pad", keys.pad, a.peaqOperator);
  assert.equal(robot.tier, 0);
  assert.equal(robot.controller, a.peaqOperator);
  assert.equal(robot.verificationMethods[0]!.publicKeyMultibase, ed25519Multibase(keys.robot.slice(32)));
  assert.match(robot.verificationMethods[0]!.publicKeyMultibase, /^z6Mk/, "ed25519 multibase keys start with z6Mk");
  const subject = JSON.parse(Buffer.from(robot.credentialSubject.slice(2), "hex").toString());
  assert.deepEqual(subject, { kind: "fiducia-simulated-machine-v1", role: "robot", simulated: true, solanaCluster: "devnet", solanaWallet: a.robot });
  assert.notEqual(robot.machineType, pad.machineType);
  assert.notEqual(robot.credentialSubject, pad.credentialSubject);
  assert.throws(() => ed25519Multibase(ed25519.getPublicKey(new Uint8Array(32)).slice(1)), TypeError);
});

test("site env follows the network the machines were activated on", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-"));
  const { keys } = loadFleetKeys(dir, true);
  writeFleetState(dir, { mission: "Dea1Address11111111111111111111111111111111", peaq: { network: PEAQ_MAINNET.deployment, eventRegistry: PEAQ_MAINNET.eventRegistry, identityRegistry: "2.0", robotMachineId: "1", padMachineId: "2" } });
  const m = machineEnv(keys, readFleetState(dir));
  assert.equal(m.PEAQ_RPC_URL, PEAQ_MAINNET.rpcUrl);
  assert.equal(m.PEAQ_EXPLORER_TX_URL, PEAQ_MAINNET.explorerTx);
  assert.equal(m.PEAQ_DEPLOYMENT, "peaq-mainnet");
  writeFleetState(dir, { ...readFleetState(dir), peaq: { ...readFleetState(dir).peaq!, network: "agung", eventRegistry: PEAQ_AGUNG.eventRegistry } });
  assert.equal(machineEnv(keys, readFleetState(dir)).PEAQ_RPC_URL, PEAQ_AGUNG.rpcUrl);
});
