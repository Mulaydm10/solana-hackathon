/**
 * Sealed credentials (PLAN §6.3, from Harness and GhostKey). Provider API keys and account tokens are
 * stored only as AES-256-GCM ciphertext, under a master key that lives outside the repo (env or the OS
 * keychain). The plaintext exists only inside `withCredential`, for the duration of one provider call,
 * and is never returned to callers: the vault has no "read" method.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SealedCredential = {
  /** Provider id this credential belongs to; bound into the ciphertext as associated data. */
  provider: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

const AAD = (provider: string) => Buffer.from(`deal-broker-credential-v1\n${provider}`);

/** Seal one credential under the master key (32 bytes). */
export function sealCredential(masterKey: Uint8Array, provider: string, secret: string): SealedCredential {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey, iv);
  c.setAAD(AAD(provider));
  const ciphertext = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return { provider, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

export type CredentialVault = {
  /** Providers that have a credential (names only). */
  providers(): string[];
  /**
   * Opens the credential for one call and hands it to `use`; the plaintext never leaves this call.
   * Refuses if there is no credential or it does not decrypt (wrong key, tampered, moved to another provider).
   */
  withCredential<T>(provider: string, use: (secret: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: "NO_CREDENTIAL" | "TAMPERED" }>;
};

export function createVault(masterKey: Uint8Array, sealed: readonly SealedCredential[]): CredentialVault {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const byProvider = new Map(sealed.map((s) => [s.provider, s]));
  const key = Buffer.from(masterKey);
  return {
    providers: () => [...byProvider.keys()],
    async withCredential(provider, use) {
      const s = byProvider.get(provider);
      if (!s) return { ok: false, reason: "NO_CREDENTIAL" };
      let secret: string;
      try {
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "hex"));
        d.setAAD(AAD(provider));
        d.setAuthTag(Buffer.from(s.tag, "hex"));
        secret = Buffer.concat([d.update(Buffer.from(s.ciphertext, "hex")), d.final()]).toString("utf8");
      } catch {
        return { ok: false, reason: "TAMPERED" };
      }
      return { ok: true, value: await use(secret) };
    },
  };
}

/** Master key from `BROKER_MASTER_KEY` (64 hex chars). Never logged. */
export function masterKeyFromEnv(env: Record<string, string | undefined> = process.env): Uint8Array {
  const hex = env.BROKER_MASTER_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("BROKER_MASTER_KEY must be 64 hex characters (32 bytes)");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
