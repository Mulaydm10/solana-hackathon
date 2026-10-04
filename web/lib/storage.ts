// Server-only storage for the sell flow (#110): listing documents (metadata, the assessor's report) and custody
// ciphertext in one writable DocStore; custody keys in a separate KeyVault, sealed under the custody master key.
// Two backends behind one byte-store interface: files (local dev, the Omen) and Vercel Blob (private blobs),
// chosen by env. A per-listing key is never written to the DocStore, and never written unsealed anywhere.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sealedKeyStore, type KeyEntry } from "./agents-sell";
import type { DocStore } from "./chain-registry";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NAME = /^[a-z]+\/[1-9A-HJ-NP-Za-km-z]{32,44}\.(json|bin)$|^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/;

/** Bytes by name. Names are built here from validated listing addresses only, never from a request. */
export type Blobs = {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
};

const checkName = (name: string) => {
  if (!NAME.test(name)) throw new Error("bad storage name");
  return name;
};

export function fileBlobs(dir: string): Blobs {
  return {
    async read(name) {
      const p = join(dir, checkName(name));
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
    },
    async write(name, bytes) {
      const p = join(dir, checkName(name));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    },
  };
}

/** The two Vercel Blob calls used, so tests can stand in for the service. */
export type BlobApi = {
  put(pathname: string, body: Uint8Array, o: { access: "private"; token: string; addRandomSuffix: false; allowOverwrite: true; contentType: string }): Promise<unknown>;
  get(pathname: string, o: { access: "private"; token: string; useCache: false }): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
};

/** Private Vercel Blob objects under `prefix/` (production on Vercel, whose disk is read-only). */
export function vercelBlobs(api: BlobApi, token: string, prefix: string): Blobs {
  if (!/^[a-z-]+$/.test(prefix)) throw new Error("bad blob prefix");
  return {
    async read(name) {
      const r = await api.get(`${prefix}/${checkName(name)}`, { access: "private", token, useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return new Uint8Array(await new Response(r.stream).arrayBuffer());
    },
    async write(name, bytes) {
      await api.put(`${prefix}/${checkName(name)}`, bytes, {
        access: "private", token, addRandomSuffix: false, allowOverwrite: true, contentType: name.endsWith(".json") ? "application/json" : "application/octet-stream",
      });
    },
  };
}

/** A listing's documents: as the chain registry reads them, plus the server's own report awaiting attestation. */
export type ListingDocs = { meta?: string; report?: string; assessed?: string };

export type WritableDocStore = Omit<DocStore, "get"> & {
  get(listing: string): Promise<ListingDocs | null>;
  /** Merges fields into the listing's documents. */
  put(listing: string, d: ListingDocs): Promise<void>;
  putCiphertext(listing: string, bytes: Uint8Array): Promise<void>;
  getCiphertext(listing: string): Promise<Uint8Array | null>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Documents at `<listing>.json` (the layout fileDocStore reads), ciphertext at `ciphertext/<listing>.bin`. */
export function docStore(blobs: Blobs): WritableDocStore {
  const get = async (listing: string): Promise<ListingDocs | null> => {
    if (!ADDRESS.test(listing)) return null;
    const b = await blobs.read(`${listing}.json`);
    if (!b) return null;
    try {
      return JSON.parse(dec.decode(b)) as ListingDocs;
    } catch {
      return null;
    }
  };
  const need = (listing: string) => {
    if (!ADDRESS.test(listing)) throw new Error("bad listing address");
  };
  return {
    get,
    async put(listing, d) {
      need(listing);
      await blobs.write(`${listing}.json`, enc.encode(JSON.stringify({ ...(await get(listing)), ...d })));
    },
    async putCiphertext(listing, bytes) {
      need(listing);
      await blobs.write(`ciphertext/${listing}.bin`, bytes);
    },
    async getCiphertext(listing) {
      return ADDRESS.test(listing) ? blobs.read(`ciphertext/${listing}.bin`) : null;
    },
  };
}

/** Per-listing custody keys, each sealed under the master key (agents `sealedKeyStore`), one object per listing. */
export type KeyVault = {
  get(listing: string): Promise<KeyEntry | undefined>;
  set(listing: string, e: KeyEntry): Promise<void>;
};

export function keyVault(blobs: Blobs, masterKey: Uint8Array): KeyVault {
  // One sealed document per listing, so two listings stored at once can never overwrite each other's key.
  const forListing = async (listing: string) => {
    if (!ADDRESS.test(listing)) throw new Error("bad listing address");
    const name = `keys/${listing}.json`;
    let doc = await blobs.read(name).then((b) => (b ? dec.decode(b) : null));
    let dirty = false;
    const store = sealedKeyStore(masterKey, { read: () => doc, write: (d) => { doc = d; dirty = true; } });
    return { store, flush: async () => { if (dirty && doc !== null) await blobs.write(name, enc.encode(doc)); } };
  };
  return {
    async get(listing) {
      return (await forListing(listing)).store.get(listing);
    },
    async set(listing, e) {
      const v = await forListing(listing);
      v.store.set(listing, e);
      await v.flush();
    },
  };
}
