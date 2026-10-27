// Storage helpers: a 60-second in-memory cache in front of KV, change
// detection so unchanged data is never rewritten (KV writes are the scarcest
// free-plan resource), and an in-memory KV for dummy mode and tests.

export const MEMORY_TTL = 60_000;

const memory = new Map();

export function clearMemory() {
  memory.clear();
}

export function memoryGet(key) {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return hit;
}

export function memorySet(key, value, hash) {
  memory.set(key, { value, hash, expires: Date.now() + MEMORY_TTL });
}

/** FNV-1a: a short, stable fingerprint of a JSON value. */
export function fingerprint(value) {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

/**
 * Reads JSON from memory, then KV.
 * @param {KVNamespace} kv
 */
export async function read(kv, key) {
  const hit = memoryGet(key);
  if (hit) return hit.value;
  // Reads of the same key at the same time (a request's data sets all check
  // the property list) share one KV read: the free plan allows 100,000 a day.
  let pending = inflight.get(key);
  if (!pending) {
    pending = kv.getWithMetadata(key, 'json').then(({ value, metadata }) => {
      if (value != null) memorySet(key, value, metadata?.h);
      return value ?? null;
    });
    inflight.set(key, pending);
    pending.finally(() => inflight.delete(key)).catch(() => {});
  }
  return pending;
}

const inflight = new Map();

/**
 * Writes data as {...data, updated_at} unless it is unchanged.
 * @param {KVNamespace} kv
 * @param {string} key
 * @param {object} data
 * @param {string} [knownHash] the stored fingerprint, when the caller already has it
 * @returns {Promise<boolean>} whether KV was written
 */
export async function write(kv, key, data, knownHash) {
  const h = fingerprint(data);
  let previous = knownHash;
  if (previous === undefined) previous = memoryGet(key)?.hash;
  if (previous === h) return false;
  const value = { ...data, updated_at: new Date().toISOString() };
  await kv.put(key, JSON.stringify(value), { metadata: { h } });
  memorySet(key, value, h);
  return true;
}

/** Lists every key with its stored fingerprint. */
export async function listKeys(kv) {
  const out = new Map();
  let cursor;
  do {
    const page = await kv.list({ cursor });
    for (const k of page.keys) out.set(k.name, k.metadata?.h);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** A Map-backed stand-in for a KV namespace (dummy mode and tests). */
export class MemoryKV {
  constructor() {
    this.data = new Map();
    this.writes = 0;
    this.reads = 0;
  }
  async get(key, type) {
    return (await this.getWithMetadata(key, type)).value;
  }
  async getWithMetadata(key, type) {
    this.reads++;
    const hit = this.data.get(key);
    if (!hit) return { value: null, metadata: null };
    return { value: type === 'json' ? JSON.parse(hit.value) : hit.value, metadata: hit.metadata ?? null };
  }
  async put(key, value, options = {}) {
    this.writes++;
    this.data.set(key, { value: String(value), metadata: options.metadata });
  }
  async delete(key) {
    this.writes++;
    this.data.delete(key);
  }
  async list({ prefix = '' } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: this.data.get(name).metadata }));
    return { keys, list_complete: true, cursor: '' };
  }
}
