// Listing data for the routes and the hourly cron.
//
// A request reads memory (60 s), then KV. Only when KV has nothing yet does
// it call Hospitable once and store the result before answering. The cron
// refreshes every data set that exists in KV, which is exactly the set some
// widget has asked for.

import { createClient, HospitableError, BudgetError } from './hospitable.js';
import * as N from './normalize.js';
import { read, write, listKeys, MemoryKV } from './store.js';
import { dummyFetch, DUMMY_TOPICS } from './dummy.js';

export const DEFAULT_BUDGET = 45; // of the free plan's 50 subrequests, with room to spare
const FAIL_BACKOFF = 60_000;

let dummyKV = null;
let failUntil = 0;

export function resetState() {
  dummyKV = null;
  failUntil = 0;
}

export function isDummy(env) {
  return String(env.HOSPITABLE_PAT || '').trim() === 'dummy';
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export class NotFound extends Error {}
export class Unavailable extends Error {
  constructor(message, token = 'unknown') {
    super(message);
    this.token = token;
  }
}

export class Listings {
  /**
   * @param {object} env Worker env
   * @param {{ fetch?: typeof fetch, budget?: number }} [options]
   */
  constructor(env, options = {}) {
    this.env = env;
    this.mode = isDummy(env) ? 'dummy' : 'live';
    if (this.mode === 'dummy') {
      dummyKV ||= new MemoryKV();
      this.kv = dummyKV;
    } else {
      if (!env.LISTINGS) throw new Error('KV binding LISTINGS is missing');
      if (!String(env.HOSPITABLE_PAT || '').trim()) throw new Unavailable('HOSPITABLE_PAT is not set', 'missing');
      this.kv = env.LISTINGS;
    }
    this.budget = Number(env.SUBREQUEST_BUDGET) || options.budget || DEFAULT_BUDGET;
    this.client = createClient({
      token: String(env.HOSPITABLE_PAT || '').trim(),
      fetch: this.mode === 'dummy' ? dummyFetch : options.fetch || fetch,
      budget: this.budget,
    });
    const topics = N.topicList(env.PUBLIC_GUIDE_TOPICS);
    this.topics = topics.length || this.mode === 'live' ? topics : DUMMY_TOPICS;
  }

  // --- Reading for requests -------------------------------------------------

  /** Calls Hospitable for a missing data set, with a short back-off after a failure. */
  async onDemand(fn) {
    if (Date.now() < failUntil) throw new Unavailable('Hospitable failed a moment ago; retrying shortly');
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HospitableError || err instanceof BudgetError) {
        failUntil = Date.now() + FAIL_BACKOFF;
        const token = err instanceof HospitableError ? err.token : 'unknown';
        await this.recordFailure(err, token);
        throw new Unavailable(err.message, token);
      }
      throw err;
    }
  }

  async recordFailure(err, token) {
    console.error(`[hospitable-pages] ${err.message}`);
    try {
      const status = (await read(this.kv, 'status')) || {};
      if (status.token !== token || status.error !== err.message) {
        await write(this.kv, 'status', { ...status, token, error: err.message, failed_at: new Date().toISOString() });
      }
    } catch {
      /* status is best effort */
    }
  }

  /** The list of listed properties. `widget` marks that a page shows prices. */
  async list({ widget = false } = {}) {
    let list = await read(this.kv, 'list');
    if (!list) {
      list = await this.onDemand(async () => {
        const raw = await this.client.properties();
        return this.storeProperties(raw);
      });
    }
    if (this.mode === 'dummy' && list.properties.some((p) => p.price_from == null)) {
      // No cron in dummy mode: work prices out from the sample calendars right away.
      const properties = [];
      for (const p of list.properties) {
        const cal = await this.dataset(`cal:${p.id}`, async () => N.calendar(await this.client.calendar(p.id, today()), p.currency));
        properties.push({ ...p, price_from: N.priceFrom(cal.calendar, today()) });
      }
      list = { ...list, properties };
      await write(this.kv, 'list', { properties });
    }
    if (widget && this.mode === 'live') {
      // A Property list widget needs prices, so the cron starts fetching calendars.
      if ((await read(this.kv, 'want:prices')) == null) await write(this.kv, 'want:prices', { since: today() });
    }
    return list;
  }

  async known(id) {
    const list = await this.list();
    if (!list.properties.some((p) => p.id === id)) throw new NotFound(`Unknown or unlisted property ${id}`);
  }

  async property(id) {
    await this.known(id);
    let base = await read(this.kv, `prop:${id}`);
    if (!base) {
      base = await this.onDemand(async () => {
        const raw = await this.client.property(id);
        if (!raw || raw.listed === false) throw new NotFound(`Unknown or unlisted property ${id}`);
        const data = { ...N.property(raw), cover: N.httpsUrl(raw.picture) };
        delete data.photos;
        await write(this.kv, `prop:${id}`, data);
        return data;
      });
    }
    let images = await read(this.kv, `img:${id}`);
    if (!images) {
      images = await this.onDemand(async () => {
        const data = { photos: N.photos(await this.client.images(id), base.cover) };
        await write(this.kv, `img:${id}`, data);
        return data;
      });
    }
    const { cover, ...publicBase } = base;
    return { ...publicBase, photos: images.photos, updated_at: older(base.updated_at, images.updated_at) };
  }

  async calendar(id) {
    await this.known(id);
    return this.dataset(`cal:${id}`, async () => N.calendar(await this.client.calendar(id, today()), await this.currencyOf(id)));
  }

  async reviews(id) {
    await this.known(id);
    return this.dataset(`rev:${id}`, async () => {
      const { list, total } = await this.client.reviews(id);
      return N.reviews(list, total);
    });
  }

  async guide(id) {
    await this.known(id);
    // With no public topics there is nothing to show and nothing to fetch.
    if (!this.topics.length) return { guide: [] };
    return this.dataset(`guide:${id}`, async () => N.guide(await this.client.knowledgeHub(id), this.topics));
  }

  async host() {
    return this.dataset('host', async () => N.host(await this.client.user()));
  }

  async status() {
    return (await read(this.kv, 'status')) || null;
  }

  async dataset(key, load) {
    const stored = await read(this.kv, key);
    if (stored) return stored;
    return this.onDemand(async () => {
      const data = await load();
      await write(this.kv, key, data);
      return { ...data, updated_at: new Date().toISOString() };
    });
  }

  async currencyOf(id) {
    const list = await read(this.kv, 'list');
    return list?.properties.find((p) => p.id === id)?.currency || 'USD';
  }

  /** Stores the list and each property's base data from one /properties response. */
  async storeProperties(raw, hashes = new Map(), prices = {}) {
    const listed = raw.filter((p) => p && p.id && p.listed !== false);
    const properties = listed.map((p) => ({ ...N.summary(p), price_from: prices[String(p.id)] ?? null }));
    for (const p of listed) {
      // `cover` is internal: the photo fallback when Hospitable returns no Direct photos.
      const data = { ...N.property(p), cover: N.httpsUrl(p.picture) };
      delete data.photos;
      await write(this.kv, `prop:${p.id}`, data, hashes.get(`prop:${p.id}`));
    }
    const list = { properties };
    await write(this.kv, 'list', list, hashes.get('list'));
    return { ...list, updated_at: new Date().toISOString() };
  }

  // --- Hourly refresh -------------------------------------------------------

  /**
   * Refreshes every stored data set. Properties are handled in a rotating
   * order, so when the subrequest budget runs out the next run carries on
   * where this one stopped.
   */
  async refresh() {
    if (this.mode === 'dummy') return { skipped: 'dummy mode' };
    const started = new Date().toISOString();
    const hashes = await listKeys(this.kv);
    const previous = (await read(this.kv, 'status')) || {};
    const report = { started, properties: 0, refreshed: 0, written: 0, partial: false, errors: [] };

    let raw;
    try {
      raw = await this.client.properties();
    } catch (err) {
      const token = err instanceof HospitableError ? err.token : 'unknown';
      console.error(`[hospitable-pages] refresh failed: ${err.message}`);
      await write(this.kv, 'status', { ...previous, last_run: started, token, error: err.message, failed_at: started });
      return { ...report, errors: [err.message] };
    }

    const listed = raw.filter((p) => p && p.id && p.listed !== false);
    const ids = listed.map((p) => String(p.id));
    report.properties = ids.length;

    const prevList = await read(this.kv, 'list');
    const prices = Object.fromEntries((prevList?.properties || []).map((p) => [p.id, p.price_from]));
    const wantPrices = hashes.has('want:prices');
    const wantHost = hashes.has('host');
    const day = today();

    let cursor = Number(previous.cursor) || 0;
    if (cursor >= ids.length) cursor = 0;
    let next = 0;
    let aborted = false;

    for (let i = 0; i < ids.length && !aborted; i++) {
      const index = (cursor + i) % ids.length;
      const id = ids[index];
      const p = listed[index];
      const tasks = [];
      if (hashes.has(`img:${id}`)) tasks.push('img');
      if (hashes.has(`cal:${id}`) || wantPrices) tasks.push('cal');
      if (hashes.has(`rev:${id}`)) tasks.push('rev');
      if (hashes.has(`guide:${id}`) && this.topics.length) tasks.push('guide');
      if (this.client.left - (wantHost ? 1 : 0) < tasks.length) {
        report.partial = true;
        next = index;
        break;
      }
      for (const task of tasks) {
        try {
          if (task === 'img') {
            report.written += +(await write(this.kv, `img:${id}`, { photos: N.photos(await this.client.images(id), p.picture) }, hashes.get(`img:${id}`)));
          } else if (task === 'cal') {
            const cal = N.calendar(await this.client.calendar(id, day), p.currency);
            prices[id] = N.priceFrom(cal.calendar, day);
            report.written += +(await write(this.kv, `cal:${id}`, cal, hashes.get(`cal:${id}`)));
          } else if (task === 'rev') {
            const { list, total } = await this.client.reviews(id);
            report.written += +(await write(this.kv, `rev:${id}`, N.reviews(list, total), hashes.get(`rev:${id}`)));
          } else if (task === 'guide') {
            report.written += +(await write(this.kv, `guide:${id}`, N.guide(await this.client.knowledgeHub(id), this.topics), hashes.get(`guide:${id}`)));
          }
          report.refreshed++;
        } catch (err) {
          report.errors.push(`${task} ${id}: ${err.message}`);
          console.error(`[hospitable-pages] ${task} ${id}: ${err.message}`);
          // A rejected token fails every call; stop instead of burning the budget.
          if (err instanceof HospitableError && (err.status === 401 || err.status === 403)) aborted = true;
        }
      }
    }

    if (wantHost && !aborted) {
      try {
        report.written += +(await write(this.kv, 'host', N.host(await this.client.user()), hashes.get('host')));
      } catch (err) {
        report.errors.push(`host: ${err.message}`);
      }
    }

    // Base data and the list come from the /properties call above.
    for (const id of ids) if (!(id in prices)) prices[id] = null;
    await this.storeProperties(raw, hashes, prices);

    // Data for properties that were removed or unlisted goes away.
    const keep = new Set(ids);
    for (const name of hashes.keys()) {
      const m = /^(prop|img|cal|rev|guide):(.+)$/.exec(name);
      if (m && !keep.has(m[2])) {
        await this.kv.delete(name);
        report.written++;
      }
    }

    await write(this.kv, 'status', {
      last_run: started,
      last_success: report.errors.length ? previous.last_success || null : started,
      token: aborted ? 'rejected' : 'ok',
      error: report.errors[0] || null,
      properties: ids.length,
      partial: report.partial,
      cursor: report.partial ? next : 0,
    });
    return report;
  }
}

function older(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
