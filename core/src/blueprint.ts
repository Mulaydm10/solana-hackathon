/**
 * Team blueprints and mission terms (PLAN §2.3, §3). A blueprint is what a Team listing sells: roles with
 * capabilities and caps, stages behind human gates, and a hash-checkable deliverable. `missionTerms` turns
 * a blueprint, a goal and a budget into the canonical terms whose hash is the on-chain `Mission.terms_hash`,
 * so the mandate set *is* the terms (from Batas). The capability catalogue is a parameter: core stays pure.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalize, hasOnlyKeys, isObject, isPlainText, sha256Bytes, SLUG, type Json } from "./canonical.ts";

export type Role = {
  /** Slug, unique in the blueprint. */
  name: string;
  purpose: string;
  /** Capability ids from the broker's catalogue, e.g. "market-data:read". */
  capabilities: string[];
  /** Mandate cap and per-transaction cap, token base units. */
  cap: bigint;
  perTxCap: bigint;
  /** Token owners this role may pay; empty or absent = only Listing sellers (PLAN §2.3). */
  payees?: string[];
};

export type Stage = {
  name: string;
  /** Roles that work in this stage. */
  roles: string[];
  /** Most the whole team may spend in this stage. */
  cap: bigint;
  /** Every stage opens only after a human approves its plan; anything else is refused. */
  gate: "human";
};

export type Deliverable = {
  description: string;
  /** How the buyer checks the final product against the delivery hash. */
  check: "sha256";
};

export type Blueprint = {
  version: 1;
  name: string;
  roles: Role[];
  stages: Stage[];
  deliverable: Deliverable;
  /** Seconds from mission start to expiry. */
  maxDuration: number;
};

export type PlatformLimits = {
  maxRoles: number;
  /** On-chain `Mission.stages` holds at most 8. */
  maxStages: number;
  maxCap: bigint;
  maxPerTxCap: bigint;
  /** On-chain `Mandate.payees` holds at most 8. */
  maxPayees: number;
  maxDuration: number;
};

export const DEFAULT_LIMITS: PlatformLimits = {
  maxRoles: 8,
  maxStages: 8,
  maxCap: 1_000_000_000n,
  maxPerTxCap: 100_000_000n,
  maxPayees: 8,
  maxDuration: 30 * 86_400,
};

export type BlueprintRefusal =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FIELD"
  | "BAD_VERSION"
  | "BAD_NAME"
  | "NO_ROLES"
  | "TOO_MANY_ROLES"
  | "DUPLICATE_ROLE"
  | "BAD_ROLE"
  | "UNKNOWN_CAPABILITY"
  | "BAD_CAP"
  | "CAP_OVER_LIMIT"
  | "PER_TX_OVER_CAP"
  | "BAD_PAYEES"
  | "NO_STAGES"
  | "TOO_MANY_STAGES"
  | "BAD_STAGE"
  | "NO_HUMAN_GATE"
  | "UNKNOWN_STAGE_ROLE"
  | "ROLE_NEVER_WORKS"
  | "BAD_DELIVERABLE"
  | "NOT_HASH_CHECKABLE"
  | "BAD_DURATION";

/** `at` names the offending part, e.g. "roles[1].cap", for the seller's error message. */
export type BlueprintResult = { ok: true; value: Blueprint } | { ok: false; reason: BlueprintRefusal; at: string };

const isAmount = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n;
/** Base58 address shape (32-44 chars); the chain checks the real key. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateBlueprint(
  bp: unknown,
  ctx: { limits: PlatformLimits; capabilities: readonly string[] },
): BlueprintResult {
  const fail = (reason: BlueprintRefusal, at: string) => ({ ok: false as const, reason, at });
  const L = ctx.limits;
  if (!isObject(bp)) return fail("NOT_AN_OBJECT", "");
  if (!hasOnlyKeys(bp, ["version", "name", "roles", "stages", "deliverable", "maxDuration"])) return fail("UNKNOWN_FIELD", "");
  if (bp.version !== 1) return fail("BAD_VERSION", "version");
  if (!isPlainText(bp.name, 80)) return fail("BAD_NAME", "name");

  if (!Array.isArray(bp.roles) || bp.roles.length === 0) return fail("NO_ROLES", "roles");
  if (bp.roles.length > L.maxRoles) return fail("TOO_MANY_ROLES", "roles");
  const roleNames = new Set<string>();
  for (const [i, r] of bp.roles.entries()) {
    const at = `roles[${i}]`;
    if (!isObject(r) || !hasOnlyKeys(r, ["name", "purpose", "capabilities", "cap", "perTxCap"], ["payees"])) return fail("BAD_ROLE", at);
    if (typeof r.name !== "string" || !SLUG.test(r.name)) return fail("BAD_ROLE", `${at}.name`);
    if (roleNames.has(r.name)) return fail("DUPLICATE_ROLE", `${at}.name`);
    roleNames.add(r.name);
    if (!isPlainText(r.purpose, 500)) return fail("BAD_ROLE", `${at}.purpose`);
    if (!Array.isArray(r.capabilities) || new Set(r.capabilities).size !== r.capabilities.length) return fail("BAD_ROLE", `${at}.capabilities`);
    for (const c of r.capabilities) if (!ctx.capabilities.includes(c as string)) return fail("UNKNOWN_CAPABILITY", `${at}.capabilities`);
    if (!isAmount(r.cap)) return fail("BAD_CAP", `${at}.cap`);
    if (!isAmount(r.perTxCap)) return fail("BAD_CAP", `${at}.perTxCap`);
    if (r.cap > L.maxCap) return fail("CAP_OVER_LIMIT", `${at}.cap`);
    if (r.perTxCap > L.maxPerTxCap) return fail("CAP_OVER_LIMIT", `${at}.perTxCap`);
    if (r.perTxCap > r.cap) return fail("PER_TX_OVER_CAP", `${at}.perTxCap`);
    if (r.payees !== undefined) {
      const p = r.payees;
      if (!Array.isArray(p) || p.length > L.maxPayees || new Set(p).size !== p.length || !p.every((x) => typeof x === "string" && ADDRESS.test(x))) {
        return fail("BAD_PAYEES", `${at}.payees`);
      }
    }
  }

  if (!Array.isArray(bp.stages) || bp.stages.length === 0) return fail("NO_STAGES", "stages");
  if (bp.stages.length > L.maxStages) return fail("TOO_MANY_STAGES", "stages");
  const working = new Set<string>();
  for (const [i, s] of bp.stages.entries()) {
    const at = `stages[${i}]`;
    if (!isObject(s) || !hasOnlyKeys(s, ["name", "roles", "cap", "gate"])) return fail("BAD_STAGE", at);
    if (!isPlainText(s.name, 80)) return fail("BAD_STAGE", `${at}.name`);
    if (s.gate !== "human") return fail("NO_HUMAN_GATE", `${at}.gate`);
    if (!isAmount(s.cap)) return fail("BAD_CAP", `${at}.cap`);
    if (!Array.isArray(s.roles) || s.roles.length === 0 || new Set(s.roles).size !== s.roles.length) return fail("BAD_STAGE", `${at}.roles`);
    for (const r of s.roles) {
      if (!roleNames.has(r as string)) return fail("UNKNOWN_STAGE_ROLE", `${at}.roles`);
      working.add(r as string);
    }
  }
  for (const r of roleNames) if (!working.has(r)) return fail("ROLE_NEVER_WORKS", "roles");

  const d = bp.deliverable;
  if (!isObject(d) || !hasOnlyKeys(d, ["description", "check"]) || !isPlainText(d.description, 500)) return fail("BAD_DELIVERABLE", "deliverable");
  if (d.check !== "sha256") return fail("NOT_HASH_CHECKABLE", "deliverable.check");
  if (!Number.isSafeInteger(bp.maxDuration) || (bp.maxDuration as number) <= 0 || (bp.maxDuration as number) > L.maxDuration) {
    return fail("BAD_DURATION", "maxDuration");
  }
  return { ok: true, value: bp as unknown as Blueprint };
}

const sortStr = (xs: readonly string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function roleJson(r: Role): Json {
  return { name: r.name, purpose: r.purpose, capabilities: sortStr(r.capabilities), cap: r.cap, perTxCap: r.perTxCap, payees: sortStr(r.payees ?? []) };
}

/** Canonical blueprint: role order and the order inside capability and payee lists do not matter; stage order does. */
export function canonicalBlueprint(bp: Blueprint): string {
  return canonicalize({
    version: bp.version,
    name: bp.name,
    roles: [...bp.roles].sort((a, b) => (a.name < b.name ? -1 : 1)).map(roleJson),
    stages: bp.stages.map((s) => ({ name: s.name, roles: sortStr(s.roles), cap: s.cap, gate: s.gate })),
    deliverable: { description: bp.deliverable.description, check: bp.deliverable.check },
    maxDuration: bp.maxDuration,
  });
}

/** sha256 of the canonical blueprint: a Team listing's `content_hash` (hex of it in `TeamMeta.blueprintHash`). */
export function blueprintHash(bp: Blueprint): Uint8Array {
  return sha256Bytes(canonicalBlueprint(bp));
}

/** sha256 of one role's canonical JSON: the on-chain `Mandate.role_hash`. */
export function roleHash(r: Role): Uint8Array {
  return sha256Bytes(canonicalize(roleJson(r)));
}

/** `roleHash` is hex. */
export type MissionMandate = { role: string; roleHash: string; capabilities: string[]; cap: bigint; perTxCap: bigint; payees: string[] };

export type MissionTerms = {
  version: 1;
  goal: string;
  /** Mission expense budget, token base units (the team's fee is a separate escrow deal). */
  budget: bigint;
  /** Hex. */
  blueprintHash: string;
  mandates: MissionMandate[];
  stages: { name: string; roles: string[]; cap: bigint }[];
  deliverable: Deliverable;
  maxDuration: number;
};

export type MissionRefusal = "BAD_GOAL" | "ZERO_BUDGET" | "CAPS_OVER_BUDGET" | "STAGE_CAP_OVER_BUDGET";

export type MissionResult =
  | { ok: true; value: { terms: MissionTerms; canonical: string; hash: Uint8Array } }
  | { ok: false; reason: MissionRefusal };

/**
 * The terms the buyer signs with `create_mission`. Refuses what `add_mandate` would refuse on chain:
 * the sum of all mandate caps must fit the budget, and no stage may be allowed more than the budget.
 * Pass a blueprint that passed `validateBlueprint`.
 */
export function missionTerms(bp: Blueprint, goal: string, budget: bigint): MissionResult {
  const fail = (reason: MissionRefusal) => ({ ok: false as const, reason });
  if (!isPlainText(goal, 2_000, true)) return fail("BAD_GOAL");
  if (budget <= 0n) return fail("ZERO_BUDGET");
  if (bp.roles.reduce((s, r) => s + r.cap, 0n) > budget) return fail("CAPS_OVER_BUDGET");
  if (bp.stages.some((s) => s.cap > budget)) return fail("STAGE_CAP_OVER_BUDGET");

  const terms: MissionTerms = {
    version: 1,
    goal,
    budget,
    blueprintHash: bytesToHex(blueprintHash(bp)),
    mandates: [...bp.roles]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((r) => ({ role: r.name, roleHash: bytesToHex(roleHash(r)), capabilities: sortStr(r.capabilities), cap: r.cap, perTxCap: r.perTxCap, payees: sortStr(r.payees ?? []) })),
    stages: bp.stages.map((s) => ({ name: s.name, roles: sortStr(s.roles), cap: s.cap })),
    deliverable: { description: bp.deliverable.description, check: bp.deliverable.check },
    maxDuration: bp.maxDuration,
  };
  const canonical = canonicalize(terms as unknown as Json);
  return { ok: true, value: { terms, canonical, hash: sha256Bytes(canonical) } };
}
