// Shared pieces for the site tests: a Worker env, a request helper and a
// small site like the builder publishes.
import worker from '../../src/index.js';
import { MemoryKV } from '../../src/store.js';

export const ORIGIN = 'https://rina-pages.example.workers.dev';
export const BUILDER = 'https://builder.example.com';
export const KEY = 'hp_6Jq2vX9mTz4LwR8cYb3NdK5s';

// Property IDs in the sample data.
export const VILLA = '550e8400-e29b-41d4-a716-446655440000';
export const LOFT = '6f1c2b9a-4d3e-4c8b-9a1e-2b7d5c0e8f41';

export function siteEnv(extra = {}) {
  return { HOSPITABLE_PAT: 'dummy', SITE_KEY: KEY, SITE: new MemoryKV(), BUILDER_URL: BUILDER + '/', ...extra };
}

/**
 * @param {any} env
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, key?: string|null, headers?: Record<string, string> }} [options]
 */
export function call(env, method, path, { body, key = KEY, headers = {} } = {}) {
  const h = new Headers(headers);
  if (key) h.set('Authorization', `Bearer ${key}`);
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {} });
}

export async function publish(env, site = sampleSite(), path = '/api/site', headers = {}) {
  const res = await call(env, 'PUT', path, { body: site, headers });
  return { res, body: await res.json() };
}

/** The JSON a page hands the runtime. */
export function siteData(html) {
  const m = /<script id="site-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no #site-data in the page');
  return JSON.parse(m[1]);
}

export function sampleSite() {
  return {
    runtime: 1,
    name: 'Serambi Villas',
    theme: { acc: 'Terracotta', hf: 'Serif' },
    pages: [
      {
        id: 'home',
        name: 'Home',
        slug: '',
        nav: true,
        seoTitle: '',
        seoDesc: 'Two quiet villas on the cliffs of Uluwatu.',
        blocks: [
          { id: 'b1', type: 'header', p: { logo: 'Serambi', cta: { t: 'Book', h: '/villa-kayu' } } },
          // "p1" is one of the builder's sample ids: it falls back to the first listed property.
          { id: 'b2', type: 'hero', p: { eyebrow: 'Bali', title: 'Slow days by the sea', sub: 'Two villas, one view', prop: 'p1' } },
        ],
      },
      {
        id: 'villa',
        name: 'Villa Kayu',
        slug: 'villa-kayu',
        nav: true,
        seoTitle: 'Villa Kayu, a cliff-top villa in Uluwatu',
        seoDesc: 'Three bedrooms and an infinity pool.',
        blocks: [
          { id: 'b3', type: 'gallery', p: { prop: VILLA } },
          { id: 'b4', type: 'reviews', p: { prop: LOFT, limit: 6 } },
          { id: 'b5', type: 'facts', p: { prop: VILLA } },
        ],
      },
      { id: 'contact', name: 'Contact', slug: 'contact', nav: false, seoTitle: '', seoDesc: '', blocks: [] },
    ],
  };
}
