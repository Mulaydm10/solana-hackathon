/**
 * Capability broker (PLAN §6.3, idea from GhostKey; contract: contracts/agents.md). Agents never hold a
 * credential. They ask for a capability `{ provider, resource, actions, mission, agent }` and get an opaque,
 * expiring token; every call names the token and one action, and the broker makes the provider call with
 * the sealed credential itself. Rules, all checked before any request leaves:
 *   - the agent's role in the mission's blueprint lists `provider:action` for every action asked for;
 *   - the role is the one the buyer approved on chain (its hash equals the mandate's `role_hash`);
 *   - the mandate is live (not revoked, not expired, mission open) and the current stage is approved
 *     for this agent - checked at grant time AND again on every call, so a revoke stops a running agent;
 *   - an elevated action also needs the buyer's own signature over the exact request, valid once and
 *     only until its `notAfter` (so one human click is one grant, never a standing permission);
 *   - a provider's answer or error that contains the credential, plain or encoded, is refused.
 * Known limit: egress (egress.ts) still lets an agent send data TO an allowed provider host; the
 * quarantined reader (#71) is what keeps injected instructions from steering it.
 * Results, never throws (contract rule).
 */
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, canonicalize, roleHash, type Blueprint, type Json } from "@deal/core";

export type Ok<T> = { ok: true } & T;
export type Refused = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message });

export type Capability = {
  provider: string;
  resource: string;
  actions: string[];
  /** Unix seconds. */
  expiresAt: number;
  mission: string;
  agent: string;
};

/** What the chain says about one agent's mandate right now (read through @deal/chain in production). */
export type MandateState = {
  /** Not revoked, not expired, mission open and not expired. */
  live: boolean;
  /** The mission's current stage is approved and this mandate's stage mask includes it. */
  stageOpen: boolean;
  /** Hex sha256 of the role the buyer approved (Mandate.role_hash). */
  roleHash: string;
};

export type MandateSource = (mission: string, agent: string) => Promise<MandateState | null>;

export type Provider = {
  id: string;
  /**
   * `host:port` endpoints this provider talks to (a bare host means port 443); opened in the egress
   * allowlist only while a capability for it is live. Ports matter: an allowed host's other services stay closed.
   */
  hosts: string[];
  /** Actions that need the buyer's signature (e.g. anything that spends outside the mission vault). */
  elevated?: string[];
  call(action: string, resource: string, args: unknown, credential: string): Promise<unknown>;
};

export type GrantRequest = Omit<Capability, "expiresAt"> & {
  /** Seconds; capped by the broker's maximum. */
  ttlSecs?: number;
  /** For elevated actions: the buyer's ed25519 signature over `approvalBytes(request, notAfter, nonce)`. */
  approval?: Approval;
};

export type Approval = {
  /** Hex ed25519 signature. */
  sig: string;
  /** Unix seconds; the approval is refused after this, and at most `MAX_APPROVAL_SECS` ahead. */
  notAfter: number;
  /** Random, single use (hex, 16-64 chars). */
  nonce: string;
};

export const MAX_APPROVAL_SECS = 900;

export type Broker = {
  /** The orchestrator registers a mission's blueprint and which agent plays which role. */
  registerMission(mission: string, m: { buyer: string; blueprint: Blueprint; agents: Record<string, string> }): void;
  grant(req: GrantRequest): Promise<Ok<{ token: string; expiresAt: number }> | Refused>;
  call(token: string, action: string, args?: unknown): Promise<Ok<{ result: unknown }> | Refused>;
  /** For the egress proxy: may the holder of `token` open a connection to `host:port` right now? */
  egressAllowed(token: string, host: string, port: number): Promise<boolean>;
  /** Drops every token of a mission (or of one agent). */
  revokeTokens(mission: string, agent?: string): void;
};

export type BrokerOptions = {
  vault: import("./seal.ts").CredentialVault;
  providers: Provider[];
  mandates: MandateSource;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** Longest token life, seconds. Default 600. */
  maxTtlSecs?: number;
};

const DOMAIN = "deal-broker-approval-v1\n";

/** The exact bytes a buyer signs to approve an elevated capability, once, until `notAfter`. */
export function approvalBytes(req: Omit<GrantRequest, "approval" | "ttlSecs">, notAfter: number, nonce: string): Uint8Array {
  const body = {
    provider: req.provider, resource: req.resource, actions: [...req.actions].sort(), mission: req.mission, agent: req.agent,
    notAfter, nonce,
  };
  return new TextEncoder().encode(DOMAIN + canonicalize(body as unknown as Json));
}

/** "host:port", lowercased, with 443 for a bare host. */
export function endpoint(hostPort: string): string {
  const h = hostPort.toLowerCase();
  return /:\d+$/.test(h) ? h : `${h}:443`;
}

/** The credential as it could appear in an answer: plain, base64, base64url, hex, URL-encoded. */
function encodings(secret: string): string[] {
  const b = Buffer.from(secret, "utf8");
  const forms = [secret, b.toString("base64"), b.toString("base64url"), b.toString("hex"), encodeURIComponent(secret)];
  // Base64 without padding, and the upper-case hex some providers print.
  forms.push(b.toString("base64").replace(/=+$/, ""), b.toString("hex").toUpperCase());
  return [...new Set(forms)].filter((f) => f.length >= 4);
}

const contains = (text: string, secret: string) => encodings(secret).some((f) => text.includes(f));

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function createBroker(o: BrokerOptions): Broker {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const maxTtl = o.maxTtlSecs ?? 600;
  const providers = new Map(o.providers.map((p) => [p.id, p]));
  const missions = new Map<string, { buyer: string; blueprint: Blueprint; agents: Record<string, string> }>();
  const tokens = new Map<string, Capability>();
  /** Used approval nonces until their notAfter (then they are expired anyway). */
  const usedNonces = new Map<string, number>();

  const liveCheck = async (mission: string, agent: string): Promise<Refused | null> => {
    const s = await o.mandates(mission, agent).catch(() => null);
    if (!s) return refuse("NO_MANDATE", "the chain shows no mandate for this agent on this mission");
    if (!s.live) return refuse("MANDATE_NOT_LIVE", "the mandate is revoked or expired, or the mission is closed");
    if (!s.stageOpen) return refuse("STAGE_NOT_OPEN", "the current stage is not approved for this agent");
    return null;
  };

  return {
    registerMission(mission, m) {
      missions.set(mission, m);
    },

    async grant(req) {
      const m = missions.get(req.mission);
      if (!m) return refuse("UNKNOWN_MISSION", "the broker does not know this mission");
      const roleName = m.agents[req.agent];
      const role = m.blueprint.roles.find((r) => r.name === roleName);
      if (!role) return refuse("UNKNOWN_AGENT", "this agent has no role in the mission");
      const p = providers.get(req.provider);
      if (!p) return refuse("UNKNOWN_PROVIDER", `no provider "${req.provider}"`);
      if (req.actions.length === 0) return refuse("NO_ACTIONS", "a capability needs at least one action");
      for (const a of req.actions) {
        if (!role.capabilities.includes(`${req.provider}:${a}`)) {
          return refuse("NOT_IN_ROLE", `the role "${role.name}" does not list ${req.provider}:${a}`);
        }
      }
      const state = await o.mandates(req.mission, req.agent).catch(() => null);
      if (!state) return refuse("NO_MANDATE", "the chain shows no mandate for this agent on this mission");
      // The role must be exactly the one the buyer approved on chain, so capabilities cannot be widened off chain.
      if (state.roleHash !== hex(roleHash(role))) return refuse("ROLE_MISMATCH", "the role differs from the one approved on chain");
      const dead = await liveCheck(req.mission, req.agent);
      if (dead) return dead;
      const elevated = req.actions.filter((a) => p.elevated?.includes(a));
      if (elevated.length > 0) {
        const a = req.approval;
        if (!a) return refuse("ELEVATED_NEEDS_APPROVAL", `${elevated.join(", ")} needs the buyer's signature over this exact request`);
        const t = now();
        for (const [n, until] of usedNonces) if (until < t) usedNonces.delete(n);
        if (!Number.isSafeInteger(a.notAfter) || a.notAfter < t) return refuse("APPROVAL_EXPIRED", "the buyer's approval has expired");
        if (a.notAfter > t + MAX_APPROVAL_SECS) return refuse("APPROVAL_TOO_LONG", `an approval may be valid for at most ${MAX_APPROVAL_SECS} s`);
        if (typeof a.nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(a.nonce)) return refuse("ELEVATED_NEEDS_APPROVAL", "the approval needs a random nonce");
        if (usedNonces.has(a.nonce)) return refuse("APPROVAL_USED", "this approval was already used; each one grants once");
        const pub = base58Decode(m.buyer);
        let ok = false;
        try {
          ok = !!pub && ed25519.verify(Buffer.from(a.sig, "hex"), approvalBytes(req, a.notAfter, a.nonce), pub);
        } catch {
          ok = false;
        }
        if (!ok) return refuse("ELEVATED_NEEDS_APPROVAL", `${elevated.join(", ")} needs the buyer's signature over this exact request`);
        usedNonces.set(a.nonce, a.notAfter);
      }
      const expiresAt = now() + Math.min(Math.max(1, req.ttlSecs ?? maxTtl), maxTtl);
      const token = randomBytes(32).toString("hex");
      tokens.set(token, { provider: req.provider, resource: req.resource, actions: [...req.actions], expiresAt, mission: req.mission, agent: req.agent });
      return { ok: true, token, expiresAt };
    },

    async call(token, action, args) {
      const cap = tokens.get(token);
      if (!cap) return refuse("BAD_TOKEN", "unknown or revoked capability");
      if (now() >= cap.expiresAt) {
        tokens.delete(token);
        return refuse("EXPIRED", "the capability has expired");
      }
      if (!cap.actions.includes(action)) return refuse("ACTION_NOT_GRANTED", `this capability does not allow "${action}"`);
      // Re-checked on every call: a revoke on chain stops a running agent at its next call.
      const dead = await liveCheck(cap.mission, cap.agent);
      if (dead) {
        tokens.delete(token);
        return dead;
      }
      const p = providers.get(cap.provider)!;
      const r = await o.vault.withCredential(cap.provider, async (secret) => {
        try {
          const result = await p.call(action, cap.resource, args, secret);
          const text = JSON.stringify(result ?? null);
          if (contains(text, secret)) return { leak: true as const };
          return { result };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Never echo a provider error that carries the credential, in any encoding.
          return { error: contains(msg, secret) ? "provider error (redacted)" : msg };
        }
      });
      if (!r.ok) return refuse(r.reason, "the provider credential is missing or does not open");
      const v = r.value;
      if ("leak" in v) return refuse("LEAK_BLOCKED", "the provider's answer contained the credential; it was withheld");
      if ("error" in v) return refuse("PROVIDER_ERROR", v.error ?? "provider error");
      return { ok: true, result: v.result };
    },

    async egressAllowed(token, host, port) {
      const cap = tokens.get(token);
      if (!cap || now() >= cap.expiresAt) return false;
      const p = providers.get(cap.provider);
      if (!p || !Number.isInteger(port) || !p.hosts.map(endpoint).includes(`${host.toLowerCase()}:${port}`)) return false;
      return (await liveCheck(cap.mission, cap.agent)) === null;
    },

    revokeTokens(mission, agent) {
      for (const [t, c] of tokens) if (c.mission === mission && (agent === undefined || c.agent === agent)) tokens.delete(t);
    },
  };
}
