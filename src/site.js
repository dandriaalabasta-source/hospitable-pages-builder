// The published site and its versions, in the SITE KV namespace:
//
//   site:v:<id>     { id, published_at, preview, site }   one per version, never changed
//   site:current    the live version's id
//   site:versions   [{ id, published_at, pages, preview }], newest first
//
// The live id is read from KV on every request, so a publish shows at once.
// Version documents never change after they are written, so they can stay in
// memory as long as the isolate lives.

import { isDummy } from './listings.js';
import { MemoryKV } from './store.js';

export const KEEP_VERSIONS = 10;

/** Version ids sort by time, and their random half makes a preview's address unguessable. */
export const VERSION_ID = /^[0-9a-z]{8,24}$/;

const MEMORY_DOCS = 12;
const docs = new Map();
let dummyKV = null;

export function resetSite() {
  docs.clear();
  dummyKV = null;
}

export class MissingStorage extends Error {}

let lastTime = 0;

/**
 * Time in base 36 (8 characters until 2059) and 10 random base-36 characters.
 * Two publishes in the same millisecond still get ids in publish order.
 */
export function newVersionId(now = Date.now()) {
  lastTime = Math.max(now, lastTime + 1);
  const random = crypto.getRandomValues(new Uint8Array(10));
  return lastTime.toString(36).padStart(8, '0') + Array.from(random, (b) => (b % 36).toString(36)).join('');
}

export class SiteStore {
  /** @param {any} env Worker env */
  constructor(env) {
    if (env.SITE) this.kv = env.SITE;
    else if (isDummy(env)) this.kv = dummyKV ||= new MemoryKV();
    else throw new MissingStorage('KV binding SITE is missing: redeploy from GitHub so Cloudflare creates it');
  }

  /** @returns {Promise<string|null>} */
  async liveId() {
    return (await this.kv.get('site:current')) || null;
  }

  /** @returns {Promise<{ id: string, published_at: string, preview: boolean, site: object } | null>} */
  async version(id) {
    if (!VERSION_ID.test(String(id))) return null;
    if (docs.has(id)) return docs.get(id);
    const doc = await this.kv.get(`site:v:${id}`, 'json');
    if (doc) remember(doc);
    return doc || null;
  }

  /** The live version's document, or null before the first publish. */
  async live() {
    const id = await this.liveId();
    if (!id) return null;
    const doc = await this.version(id);
    if (!doc) console.error(`[hospitable-pages] site:current points to ${id}, which is missing`);
    return doc;
  }

  /** @returns {Promise<{ id: string, published_at: string, pages: number, preview: boolean }[]>} */
  async versions() {
    const list = await this.kv.get('site:versions', 'json');
    return Array.isArray(list) ? list : [];
  }

  /**
   * Stores a checked site as a new version and, unless it is a preview, makes it live.
   * @param {object} site the output of validateSite()
   * @param {{ preview?: boolean }} [options]
   */
  async publish(site, { preview = false } = {}) {
    const doc = { id: newVersionId(), published_at: new Date().toISOString(), preview, site };
    // The document goes first: site:current must never name a version that isn't there.
    await this.kv.put(`site:v:${doc.id}`, JSON.stringify(doc));
    remember(doc);
    const live = preview ? await this.liveId() : doc.id;
    const entry = { id: doc.id, published_at: doc.published_at, pages: site.pages.length, preview };
    await this.saveList([entry, ...(await this.versions()).filter((v) => v.id !== doc.id)], live);
    if (!preview) await this.kv.put('site:current', doc.id);
    return doc;
  }

  /**
   * Makes a stored version live again. A preview made live stops counting as a preview.
   * @returns {Promise<object|null>} the version's document, or null if it is unknown
   */
  async rollback(id) {
    const list = await this.versions();
    const entry = list.find((v) => v.id === id);
    const doc = entry && (await this.version(id));
    if (!doc) return null;
    await this.kv.put('site:current', id);
    if (entry.preview) await this.saveList(list.map((v) => (v.id === id ? { ...v, preview: false } : v)), id);
    return doc;
  }

  /** Writes the list, trimmed to KEEP_VERSIONS, and deletes the versions that fell off. The live one always stays. */
  async saveList(list, live) {
    const keep = list.slice(0, KEEP_VERSIONS);
    if (live && !keep.some((v) => v.id === live)) {
      const liveEntry = list.find((v) => v.id === live);
      if (liveEntry) keep.splice(KEEP_VERSIONS - 1, 1, liveEntry);
    }
    const kept = new Set(keep.map((v) => v.id));
    await this.kv.put('site:versions', JSON.stringify(list.filter((v) => kept.has(v.id))));
    for (const v of list) {
      if (kept.has(v.id)) continue;
      await this.kv.delete(`site:v:${v.id}`);
      docs.delete(v.id);
    }
  }
}

function remember(doc) {
  docs.delete(doc.id);
  docs.set(doc.id, doc);
  // Up to ten 512 KB sites would fit, but an isolate's memory is better spent elsewhere.
  while (docs.size > MEMORY_DOCS) docs.delete(docs.keys().next().value);
}
