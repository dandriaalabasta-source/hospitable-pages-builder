// The public site: pages, previews, sitemap.xml and robots.txt.
//
// Each page arrives with the listing data its blocks name inlined, so a
// visitor's browser needs no second request to the Worker before it can draw
// the page. Data that can't be loaded is left out and the page still renders:
// blocks that don't need listing data never depend on Hospitable.

import { propertyWith } from './api.js';
import { Listings, isDummy } from './listings.js';
import { renderNotFound, renderPage, renderRobots, renderSitemap, runtimeUrl, contentSecurityPolicy } from './render.js';
import { MissingStorage, SiteStore } from './site.js';

// The same data sets as GET /api/properties/:id?include=calendar,reviews,host.
const DETAIL_SETS = ['calendar', 'reviews', 'host'];

const PAGE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const PREVIEW = /^\/_preview\/([0-9a-z]+)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

function html(request, body, status, extra = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra,
  };
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
}

function text(request, body, status, type, extra = {}) {
  const headers = { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extra };
  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
}

function notFound(request, name, home, extra) {
  return html(request, renderNotFound({ name, home }), 404, extra);
}

/**
 * Listing data for one page: every listed property, and the full data of
 * each property a block names in `p.prop`.
 */
export async function pageData(env, page) {
  const data = { mode: isDummy(env) ? 'dummy' : 'live', properties: [], details: {}, error: null };
  let listings;
  try {
    listings = new Listings(env);
    // A site page shows prices, so the hourly refresh keeps them current.
    data.properties = (await listings.list({ widget: true })).properties;
  } catch (err) {
    console.error('[hospitable-pages] listing data unavailable for a page', err?.message || err);
    data.error = 'unavailable';
    return data;
  }
  const listed = new Set(data.properties.map((p) => p.id));
  const first = data.properties[0]?.id;
  const ids = [];
  for (const block of page.blocks) {
    if (typeof block.p?.prop !== 'string') continue;
    // The builder's sample ids ("p1") and properties that are no longer listed fall back to the first one.
    const id = listed.has(block.p.prop) ? block.p.prop : first;
    if (id && !ids.includes(id)) ids.push(id);
  }
  const settled = await Promise.allSettled(ids.map((id) => propertyWith(listings, id, DETAIL_SETS)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') data.details[ids[i]] = { mode: data.mode, ...r.value.merged };
    else console.error(`[hospitable-pages] could not load ${ids[i]} for a page`, r.reason?.message || r.reason);
  });
  return data;
}

async function renderVersion(request, env, url, doc, slug, preview) {
  const base = preview ? `/_preview/${doc.id}/` : '/';
  const page = doc.site.pages.find((p) => p.slug === slug);
  const robots = preview ? { 'X-Robots-Tag': 'noindex' } : {};
  if (!page) return notFound(request, doc.site.name, base, robots);
  const runtime = runtimeUrl(env);
  const data = await pageData(env, page);
  const body = renderPage({ doc, page, origin: url.origin, base, preview, data, runtime });
  return html(request, body, 200, { 'Content-Security-Policy': contentSecurityPolicy(runtime), ...robots });
}

/**
 * Answers every path outside /api/.
 * @param {Request} request
 * @param {URL} url
 * @param {string} path the pathname without trailing slashes
 * @param {any} env
 */
export async function handlePages(request, url, path, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text(request, 'Method not allowed\n', 405, 'text/plain', { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (path === '/robots.txt') return text(request, renderRobots(url.origin), 200, 'text/plain');
  // Browsers ask for it on every first visit; one answer a day is enough.
  if (path === '/favicon.ico') return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } });

  let store;
  try {
    store = new SiteStore(env);
  } catch (err) {
    if (!(err instanceof MissingStorage)) throw err;
    console.error(`[hospitable-pages] ${err.message}`);
    return text(request, 'This site is not set up completely: its SITE storage is missing.\n', 500, 'text/plain');
  }

  const preview = PREVIEW.exec(path);
  if (preview) {
    const doc = await store.version(preview[1]);
    if (!doc) return notFound(request, '', '/', { 'X-Robots-Tag': 'noindex' });
    return renderVersion(request, env, url, doc, preview[2] || '', true);
  }

  const doc = await store.live();

  if (path === '/sitemap.xml') {
    if (!doc) return text(request, 'No site is published yet.\n', 404, 'text/plain');
    return text(request, renderSitemap(doc, url.origin), 200, 'application/xml');
  }

  if (!doc) {
    // Nothing published yet: the home page takes the host to the builder, connected to this Worker.
    if (path !== '/') return notFound(request, '', '/');
    const builder = String(env.BUILDER_URL || '').trim();
    if (!builder) return text(request, 'Hospitable Pages Worker is running.\n', 200, 'text/plain');
    const target = new URL(builder);
    target.searchParams.set('worker', url.origin);
    return Response.redirect(target.toString(), 302);
  }

  const m = PAGE.exec(path);
  if (!m) return notFound(request, doc.site.name, '/');
  return renderVersion(request, env, url, doc, m[1] || '', false);
}
