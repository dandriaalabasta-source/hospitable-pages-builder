// Public listing data, as JSON any website can read: the same routes as
// hospitable-widgets, so blocks and widgets can share code. Only reads, and
// only public listing data.

import { Listings, NotFound, Unavailable, isDummy } from './listings.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function respond(body, status, env, extra = {}) {
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Hosp-Mode': isDummy(env) ? 'dummy' : 'live',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/** CACHE_MINUTES: how long a visitor's browser may keep data. 240 (4 hours) by default, 0 for not at all, a day at most. */
export function cacheMinutes(env) {
  const raw = String(env.CACHE_MINUTES ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : 240;
}

function data(body, env, fresh) {
  const minutes = cacheMinutes(env);
  return respond({ mode: isDummy(env) ? 'dummy' : 'live', ...body }, 200, env, {
    'Cache-Control': fresh || minutes === 0 ? 'no-store' : `public, max-age=${minutes * 60}`,
  });
}

function publicStatus(status) {
  if (!status) return null;
  return {
    token: status.token || 'unknown',
    last_run: status.last_run || null,
    last_success: status.last_success || null,
    error: status.error || null,
    partial: !!status.partial,
  };
}

export const INCLUDES = new Set(['calendar', 'reviews', 'guide', 'host']);

/**
 * One property merged with the data sets named in `include`, as
 * GET /api/properties/:id?include=… hands it out. Site pages inline the same
 * object, so a block reads the same fields whichever way its data arrived.
 * @param {Listings} listings
 * @param {string} id
 * @param {string[]} include
 * @returns {Promise<{ merged: object, missing: string[] }>}
 */
export async function propertyWith(listings, id, include) {
  const [property, settled] = await Promise.all([
    listings.property(id),
    Promise.allSettled(include.map((set) => (set === 'host' ? listings.host() : listings[set](id)))),
  ]);
  // A set that fails doesn't take the others down with it.
  const parts = [property];
  const missing = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') parts.push(r.value);
    else {
      missing.push(include[i]);
      console.error(`[hospitable-pages] could not load ${include[i]} for ${id}`, r.reason);
    }
  });
  const merged = Object.assign({}, ...parts);
  merged.updated_at = parts.map((p) => p.updated_at).filter(Boolean).sort()[0] || null;
  if (missing.length) merged.missing = missing;
  return { merged, missing };
}

const ROUTES = [
  [/^\/api\/properties$/, 'list'],
  [/^\/api\/properties\/([^/]+)$/, 'property'],
  [/^\/api\/properties\/([^/]+)\/calendar$/, 'calendar'],
  [/^\/api\/properties\/([^/]+)\/reviews$/, 'reviews'],
  [/^\/api\/properties\/([^/]+)\/guide$/, 'guide'],
  [/^\/api\/host$/, 'host'],
];

async function api(route, id, url, env, listings) {
  const fresh = url.searchParams.get('for') === 'builder';
  switch (route) {
    case 'list': {
      const list = await listings.list({ widget: !fresh });
      const status = fresh && listings.mode === 'live' ? publicStatus(await listings.status()) : undefined;
      // The builder shows hosts how long visitors' browsers keep the data.
      const cache_minutes = fresh ? cacheMinutes(env) : undefined;
      return data({ updated_at: list.updated_at, status, cache_minutes, properties: list.properties }, env, fresh);
    }
    case 'property': {
      // ?include=calendar,reviews,guide,host folds the other data sets into this
      // response: one request per page view, one copy in the browser's cache.
      const include = (url.searchParams.get('include') || '').split(',').map((s) => s.trim()).filter((s) => INCLUDES.has(s));
      const { merged, missing } = await propertyWith(listings, id, include);
      // An incomplete answer must not sit in browsers' caches for an hour.
      return data(merged, env, fresh || missing.length > 0);
    }
    case 'calendar':
      return data(await listings.calendar(id), env, fresh);
    case 'reviews':
      return data(await listings.reviews(id), env, fresh);
    case 'guide':
      return data(await listings.guide(id), env, fresh);
    case 'host':
      return data(await listings.host(), env, fresh);
  }
}

/**
 * Answers /api/… paths other than /api/site.
 * @param {Request} request
 * @param {URL} url
 * @param {string} path the pathname without trailing slashes
 * @param {any} env
 */
export async function handleData(request, url, path, env) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respond({ error: 'method_not_allowed' }, 405, env, { Allow: 'GET, HEAD, OPTIONS' });
  }

  for (const [pattern, route] of ROUTES) {
    const m = pattern.exec(path);
    if (!m) continue;
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    try {
      return await api(route, id, url, env, new Listings(env));
    } catch (err) {
      if (err instanceof NotFound) return respond({ error: 'not_found' }, 404, env, { 'Cache-Control': 'public, max-age=60' });
      if (err instanceof Unavailable) {
        return respond({ error: 'unavailable', token: err.token, message: err.message }, 503, env, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
      }
      console.error('[hospitable-pages] unexpected error', err);
      return respond({ error: 'internal' }, 500, env, { 'Cache-Control': 'no-store' });
    }
  }

  return respond({ error: 'not_found' }, 404, env);
}
