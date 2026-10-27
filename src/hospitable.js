// Read-only client for the Hospitable Public API v2.
// Every call counts against a subrequest budget so one cron run or request
// never goes over Cloudflare's limit.

export const API_BASE = 'https://public.api.hospitable.com/v2';

export class HospitableError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 when Hospitable could not be reached
   */
  constructor(message, status) {
    super(message);
    this.name = 'HospitableError';
    this.status = status;
  }

  /** How the builder should describe the problem to the host. */
  get token() {
    if (this.status === 401) return 'rejected';
    if (this.status === 403) return 'forbidden';
    return 'unknown';
  }
}

export class BudgetError extends Error {
  constructor() {
    super('Subrequest budget used up');
    this.name = 'BudgetError';
  }
}

/**
 * @param {{ token: string, fetch?: typeof fetch, budget?: number }} options
 */
export function createClient({ token, fetch: fetchImpl = fetch, budget = 45 }) {
  let used = 0;

  async function get(path, params = {}) {
    if (used >= budget) throw new BudgetError();
    used++;
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      throw new HospitableError(`Could not reach Hospitable (${path})`, 0);
    }
    if (!res.ok) {
      // The body is never passed on: it can echo request details.
      throw new HospitableError(`Hospitable answered ${res.status} for ${path.replace(/[0-9a-f-]{36}/gi, ':id')}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new HospitableError(`Hospitable sent invalid JSON for ${path}`, res.status);
    }
  }

  return {
    get used() {
      return used;
    },
    get left() {
      return budget - used;
    },

    /** All properties, every page, with the includes the widgets need. */
    async properties() {
      const all = [];
      for (let page = 1; page <= 50; page++) {
        const body = await get('/properties', { include: 'details,bookings,listings', per_page: 100, page });
        all.push(...(Array.isArray(body?.data) ? body.data : []));
        const meta = body?.meta || {};
        if (!meta.last_page || page >= meta.last_page) break;
      }
      return all;
    },

    async property(id) {
      const body = await get(`/properties/${encodeURIComponent(id)}`, { include: 'details,bookings,listings' });
      // The spec shows this response without the "data" wrapper the other endpoints use; accept both.
      if (body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
      return body?.id ? body : null;
    },

    async images(id) {
      const body = await get(`/properties/${encodeURIComponent(id)}/images`);
      return Array.isArray(body?.data) ? body.data : [];
    },

    /** Twelve months from today, in one call. */
    async calendar(id, today) {
      const start = new Date(today + 'T00:00:00Z');
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 365);
      const body = await get(`/properties/${encodeURIComponent(id)}/calendar`, {
        start_date: today,
        end_date: end.toISOString().slice(0, 10),
      });
      return body?.data || {};
    },

    /** The newest 50 reviews (one page) and the total count. */
    async reviews(id) {
      const body = await get(`/properties/${encodeURIComponent(id)}/reviews`, { include: 'guest', per_page: 50, page: 1 });
      return { list: Array.isArray(body?.data) ? body.data : [], total: body?.meta?.total ?? null };
    },

    async knowledgeHub(id) {
      const body = await get(`/properties/${encodeURIComponent(id)}/knowledge-hub`);
      return body?.data || {};
    },

    async user() {
      const body = await get('/user');
      return body?.data || {};
    },
  };
}
