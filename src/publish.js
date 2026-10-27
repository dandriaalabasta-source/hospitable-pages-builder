// /api/site: where the builder publishes the site, lists its versions and
// rolls back. Every request needs the publish key (SITE_KEY), and only the
// builder's own website may call these routes from a browser.
//
// The key can only change the site's pages. It can't read or change
// anything in Hospitable, and it can't change this Worker's code or settings.

import { isDummy } from './listings.js';
import { runtimeUrl } from './render.js';
import { MissingStorage, SiteStore, VERSION_ID } from './site.js';
import { MAX_BYTES, SiteError, validateSite } from './validate.js';

export const VERSION = '1.0.0';

const MIN_KEY_LENGTH = 24;

function builderOrigin(env) {
  try {
    return new URL(String(env.BUILDER_URL || '').trim()).origin;
  } catch {
    return null;
  }
}

/** CORS for the builder's origin only; other websites get no access. */
function cors(request, env) {
  const headers = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  if (origin && origin === builderOrigin(env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, If-Match';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function respond(request, env, body, status, extra = {}) {
  const headers = {
    ...cors(request, env),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Hosp-Mode': isDummy(env) ? 'dummy' : 'live',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Compares two keys in constant time. Hashing first gives both sides the same
 * length, so not even the key's length leaks through timing.
 */
export async function sameKey(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  // Workers has a built-in constant-time compare; Node (the tests) doesn't.
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** @returns {Promise<Response|null>} an error response, or null when the key is right */
async function authorize(request, env) {
  const key = String(env.SITE_KEY || '').trim();
  if (!key) {
    return respond(request, env, { error: 'no_site_key', message: 'This Worker has no publish key yet. In Cloudflare, open Workers & Pages → hospitable-pages → Settings → Variables and Secrets, add SITE_KEY as a secret and paste the key from the builder.' }, 503);
  }
  if (key.length < MIN_KEY_LENGTH) {
    return respond(request, env, { error: 'weak_site_key', message: `SITE_KEY in Cloudflare is shorter than ${MIN_KEY_LENGTH} characters. Replace it with the full key from the builder.` }, 503);
  }
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || !(await sameKey(m[1].trim(), key))) {
    return respond(request, env, { error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  return null;
}

/** Reads at most `limit` bytes; null when the body is larger. */
async function readBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** If-Match: "id", id, W/"id", or several of them separated by commas. */
function ifMatch(request) {
  const raw = request.headers.get('If-Match');
  if (raw == null || raw.trim() === '' || raw.trim() === '*') return null;
  return raw.split(',').map((s) => s.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
}

async function readJson(request, env) {
  const body = await readBody(request, MAX_BYTES);
  if (body == null) {
    return { error: respond(request, env, { error: 'too_large', message: `The site is larger than ${MAX_BYTES / 1024} KB. Remove some pages or blocks, or shorten long texts.` }, 413) };
  }
  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: respond(request, env, { error: 'invalid_site', message: "The request body isn't valid JSON" }, 400) };
  }
}

async function getSite(request, env, url, store) {
  const doc = await store.live();
  return respond(request, env, {
    version: doc?.id ?? null,
    published_at: doc?.published_at ?? null,
    site: doc?.site ?? null,
    mode: isDummy(env) ? 'dummy' : 'live',
    worker: { version: VERSION, runtime_url: runtimeUrl(env) },
  }, 200);
}

async function putSite(request, env, url, store) {
  const preview = ['1', 'true'].includes(url.searchParams.get('preview') || '');
  const { value, error } = await readJson(request, env);
  if (error) return error;
  let site;
  try {
    site = validateSite(value);
  } catch (err) {
    if (err instanceof SiteError) return respond(request, env, { error: 'invalid_site', message: err.message }, 400);
    throw err;
  }
  // A preview never replaces anything, so only a real publish checks If-Match.
  const expected = preview ? null : ifMatch(request);
  if (expected) {
    const live = await store.liveId();
    if (!expected.includes(live)) return respond(request, env, { error: 'conflict', version: live }, 409);
  }
  const doc = await store.publish(site, { preview });
  if (preview) return respond(request, env, { version: doc.id, published_at: doc.published_at, url: `${url.origin}/_preview/${doc.id}/` }, 200);
  return respond(request, env, { version: doc.id, published_at: doc.published_at, url: `${url.origin}/` }, 200);
}

async function rollback(request, env, url, store) {
  const { value, error } = await readJson(request, env);
  if (error) return error;
  const id = value?.version;
  if (typeof id !== 'string' || !VERSION_ID.test(id)) {
    return respond(request, env, { error: 'invalid_request', message: 'Send { "version": "<id>" } with the id of a stored version' }, 400);
  }
  const doc = await store.rollback(id);
  if (!doc) return respond(request, env, { error: 'not_found', message: `Version ${id} isn't stored any more` }, 404);
  return respond(request, env, { version: doc.id, published_at: doc.published_at, url: `${url.origin}/` }, 200);
}

const ROUTES = {
  '/api/site': { GET: getSite, PUT: putSite },
  '/api/site/versions': {
    GET: async (request, env, url, store) => respond(request, env, { live: await store.liveId(), versions: await store.versions() }, 200),
  },
  '/api/site/rollback': { POST: rollback },
};

/**
 * Answers /api/site and the paths below it.
 * @param {Request} request
 * @param {URL} url
 * @param {string} path the pathname without trailing slashes
 * @param {any} env
 */
export async function handlePublish(request, url, path, env) {
  const route = ROUTES[path];
  if (!route) return respond(request, env, { error: 'not_found' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
  const handler = route[request.method];
  if (!handler) {
    return respond(request, env, { error: 'method_not_allowed' }, 405, { Allow: [...Object.keys(route), 'OPTIONS'].join(', ') });
  }

  const denied = await authorize(request, env);
  if (denied) return denied;

  try {
    return await handler(request, env, url, new SiteStore(env));
  } catch (err) {
    if (err instanceof MissingStorage) {
      console.error(`[hospitable-pages] ${err.message}`);
      return respond(request, env, { error: 'no_storage', message: "This Worker's SITE storage is missing. Update or redeploy the Worker from its GitHub copy, so Cloudflare creates it." }, 500);
    }
    console.error('[hospitable-pages] unexpected error', err);
    return respond(request, env, { error: 'internal' }, 500);
  }
}
