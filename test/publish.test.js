import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { clearMemory } from '../src/store.js';
import { resetState } from '../src/listings.js';
import { KEEP_VERSIONS, VERSION_ID, newVersionId, resetSite } from '../src/site.js';
import { VERSION, sameKey } from '../src/publish.js';
import { BUILDER, KEY, ORIGIN, call, publish, sampleSite, siteData, siteEnv } from './helpers/site.js';

beforeEach(() => {
  clearMemory();
  resetState();
  resetSite();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function json(res) {
  return { res, body: await res.json() };
}

describe('publish key', () => {
  it('asks the host to add SITE_KEY when there is none', async () => {
    for (const SITE_KEY of [undefined, '', '   ']) {
      const { res, body } = await json(await call(siteEnv({ SITE_KEY }), 'GET', '/api/site'));
      expect(res.status).toBe(503);
      expect(body.error).toBe('no_site_key');
      expect(body.message).toContain('add SITE_KEY');
    }
  });

  it('refuses a key shorter than 24 characters', async () => {
    const env = siteEnv({ SITE_KEY: 'short-key-1234567890123' });
    const { res, body } = await json(await call(env, 'GET', '/api/site', { key: 'short-key-1234567890123' }));
    expect(res.status).toBe(503);
    expect(body.error).toBe('weak_site_key');
  });

  it('refuses a wrong or missing key', async () => {
    const env = siteEnv();
    for (const key of [null, KEY + 'x', KEY.slice(1), 'Basic ' + KEY]) {
      const { res, body } = await json(await call(env, 'GET', '/api/site', { key }));
      expect(res.status).toBe(401);
      expect(body).toEqual({ error: 'unauthorized' });
    }
    const raw = await call(env, 'GET', '/api/site', { key: null, headers: { Authorization: KEY } });
    expect(raw.status).toBe(401);
    expect((await call(env, 'PUT', '/api/site', { key: 'wrong-but-long-enough-0000', body: sampleSite() })).status).toBe(401);
    expect(env.SITE.writes).toBe(0);
  });

  it('accepts the right key, with spaces around it in Cloudflare', async () => {
    const env = siteEnv({ SITE_KEY: `  ${KEY}\n` });
    expect((await call(env, 'GET', '/api/site')).status).toBe(200);
  });

  it('compares keys in constant time, with the Workers built-in when it exists', async () => {
    expect(await sameKey(KEY, KEY)).toBe(true);
    expect(await sameKey(KEY, KEY + '!')).toBe(false);
    const builtIn = vi.fn((a, b) => a.length === b.length && a.every((x, i) => x === b[i]));
    crypto.subtle.timingSafeEqual = builtIn;
    try {
      expect(await sameKey(KEY, KEY)).toBe(true);
      expect(await sameKey('a', 'b')).toBe(false);
      // Both sides arrive as SHA-256 digests of the same length.
      expect(builtIn.mock.calls[0][0]).toHaveLength(32);
      expect(builtIn.mock.calls[0][1]).toHaveLength(32);
    } finally {
      delete crypto.subtle.timingSafeEqual;
    }
  });
});

describe('publishing', () => {
  it('reports an empty site before the first publish', async () => {
    const { res, body } = await json(await call(siteEnv(), 'GET', '/api/site'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({ version: null, published_at: null, site: null, mode: 'dummy', worker: { version: '1.0.0', runtime_url: `${BUILDER}/runtime` } });
  });

  it('stores a site, makes it live and hands it back', async () => {
    const env = siteEnv();
    const { res, body } = await publish(env);
    expect(res.status).toBe(200);
    expect(body).toEqual({ version: expect.stringMatching(VERSION_ID), published_at: expect.any(String), url: `${ORIGIN}/` });
    const got = await json(await call(env, 'GET', '/api/site'));
    expect(got.body.version).toBe(body.version);
    expect(got.body.published_at).toBe(body.published_at);
    expect(got.body.site.name).toBe('Serambi Villas');
    expect(got.body.site.pages.map((p) => p.slug)).toEqual(['', 'villa-kayu', 'contact']);
    expect(JSON.parse(env.SITE.data.get(`site:v:${body.version}`).value)).toMatchObject({ id: body.version, preview: false, site: { name: 'Serambi Villas' } });
    expect(env.SITE.data.get('site:current').value).toBe(body.version);
  });

  it('shows a new publish at once, even from another isolate', async () => {
    const env = siteEnv();
    await publish(env);
    const site = sampleSite();
    site.name = 'Serambi Villas & Spa';
    const second = await publish(env, site);
    clearMemory();
    const { body } = await json(await call(env, 'GET', '/api/site'));
    expect(body.version).toBe(second.body.version);
    expect(siteData(await (await call(env, 'GET', '/', { key: null })).text()).site.name).toBe('Serambi Villas & Spa');
  });

  it('lists versions newest first and rolls back', async () => {
    const env = siteEnv();
    const first = (await publish(env)).body.version;
    const site = sampleSite();
    site.pages.pop();
    const second = (await publish(env, site)).body.version;
    expect(second > first).toBe(true);

    const list = await json(await call(env, 'GET', '/api/site/versions'));
    expect(list.body).toEqual({
      live: second,
      versions: [
        { id: second, published_at: expect.any(String), pages: 2, preview: false },
        { id: first, published_at: expect.any(String), pages: 3, preview: false },
      ],
    });

    const back = await json(await call(env, 'POST', '/api/site/rollback', { body: { version: first } }));
    expect(back.res.status).toBe(200);
    expect(back.body).toEqual({ version: first, published_at: list.body.versions[1].published_at, url: `${ORIGIN}/` });
    expect((await json(await call(env, 'GET', '/api/site/versions'))).body.live).toBe(first);
    expect((await call(env, 'GET', '/contact', { key: null })).status).toBe(200);
  });

  it('refuses to roll back to a version it does not have', async () => {
    const env = siteEnv();
    await publish(env);
    const unknown = await json(await call(env, 'POST', '/api/site/rollback', { body: { version: newVersionId() } }));
    expect(unknown.res.status).toBe(404);
    expect(unknown.body.error).toBe('not_found');
    for (const body of [{}, { version: 7 }, { version: '../site:current' }, 'not json']) {
      expect((await call(env, 'POST', '/api/site/rollback', { body })).status).toBe(400);
    }
  });

  it('refuses a publish over a version it did not start from (If-Match)', async () => {
    const env = siteEnv();
    const first = (await publish(env)).body.version;
    // Bare or quoted, the live version matches.
    const second = await publish(env, sampleSite(), '/api/site', { 'If-Match': `"${first}"` });
    expect(second.res.status).toBe(200);
    const third = await publish(env, sampleSite(), '/api/site', { 'If-Match': second.body.version });
    expect(third.res.status).toBe(200);
    // Another tab still holds the first version.
    const stale = await publish(env, sampleSite(), '/api/site', { 'If-Match': `"${first}"` });
    expect(stale.res.status).toBe(409);
    expect(stale.body).toEqual({ error: 'conflict', version: third.body.version });
    expect((await json(await call(env, 'GET', '/api/site/versions'))).body.versions).toHaveLength(3);
  });

  it('treats If-Match on an empty site as a conflict', async () => {
    const { res, body } = await publish(siteEnv(), sampleSite(), '/api/site', { 'If-Match': newVersionId() });
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'conflict', version: null });
  });

  it('stores a preview without changing the live site', async () => {
    const env = siteEnv();
    const live = (await publish(env)).body.version;
    const site = sampleSite();
    site.name = 'Draft name';
    const { res, body } = await publish(env, site, '/api/site?preview=1', { 'If-Match': 'ignored-for-previews' });
    expect(res.status).toBe(200);
    expect(body.url).toBe(`${ORIGIN}/_preview/${body.version}/`);
    expect((await json(await call(env, 'GET', '/api/site'))).body.version).toBe(live);
    expect(siteData(await (await call(env, 'GET', '/', { key: null })).text()).site.name).toBe('Serambi Villas');

    const versions = (await json(await call(env, 'GET', '/api/site/versions'))).body;
    expect(versions.live).toBe(live);
    expect(versions.versions[0]).toMatchObject({ id: body.version, preview: true });

    // Promoting the preview is a rollback to it.
    expect((await call(env, 'POST', '/api/site/rollback', { body: { version: body.version } })).status).toBe(200);
    const after = (await json(await call(env, 'GET', '/api/site/versions'))).body;
    expect(after.live).toBe(body.version);
    expect(after.versions[0]).toMatchObject({ id: body.version, preview: false });
    expect(siteData(await (await call(env, 'GET', '/', { key: null })).text()).site.name).toBe('Draft name');
  });

  it(`keeps the newest ${KEEP_VERSIONS} versions and deletes the rest`, async () => {
    const env = siteEnv();
    const ids = [];
    for (let i = 0; i < KEEP_VERSIONS + 2; i++) ids.push((await publish(env)).body.version);
    const { body } = await json(await call(env, 'GET', '/api/site/versions'));
    expect(body.versions.map((v) => v.id)).toEqual(ids.slice(2).reverse());
    const stored = [...env.SITE.data.keys()].filter((k) => k.startsWith('site:v:'));
    expect(stored.sort()).toEqual(ids.slice(2).map((id) => `site:v:${id}`).sort());
    expect((await call(env, 'GET', `/_preview/${ids[0]}/`, { key: null })).status).toBe(404);
  });

  it('never deletes the live version, however many previews follow it', async () => {
    const env = siteEnv();
    const live = (await publish(env)).body.version;
    const previews = [];
    for (let i = 0; i < KEEP_VERSIONS + 1; i++) previews.push((await publish(env, sampleSite(), '/api/site?preview=1')).body.version);
    const { body } = await json(await call(env, 'GET', '/api/site/versions'));
    expect(body.versions).toHaveLength(KEEP_VERSIONS);
    expect(body.versions.at(-1).id).toBe(live);
    expect(body.versions.slice(0, -1).map((v) => v.id)).toEqual(previews.slice(-(KEEP_VERSIONS - 1)).reverse());
    expect(env.SITE.data.has(`site:v:${live}`)).toBe(true);
    expect(env.SITE.data.has(`site:v:${previews[0]}`)).toBe(false);
    expect((await call(env, 'GET', '/', { key: null })).status).toBe(200);
  });

  it('turns a site that fails the checks away with a message for the host', async () => {
    const env = siteEnv();
    const site = sampleSite();
    site.pages[2].slug = 'api';
    const { res, body } = await publish(env, site);
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_site', message: 'Page “Contact”: slug "api" is reserved' });
    const broken = await json(await call(env, 'PUT', '/api/site', { body: '{"runtime": 1,' }));
    expect(broken.res.status).toBe(400);
    expect(broken.body.error).toBe('invalid_site');
    expect(env.SITE.writes).toBe(0);
  });

  it('refuses a site larger than 512 KB', async () => {
    const env = siteEnv();
    const site = sampleSite();
    site.pages = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, name: `Page ${i}`, slug: i ? `page-${i}` : '', nav: false,
      blocks: Array.from({ length: 3 }, (_, j) => ({ id: `b${j}`, type: 'text', p: { body: 'x'.repeat(4000) } })),
    }));
    const big = await json(await call(env, 'PUT', '/api/site', { body: site }));
    expect(big.res.status).toBe(413);
    expect(big.body.error).toBe('too_large');
    // A declared length over the limit is refused before the body is read.
    const declared = await call(env, 'PUT', '/api/site', { body: sampleSite(), headers: { 'Content-Length': String(600 * 1024) } });
    expect(declared.status).toBe(413);
    expect(env.SITE.writes).toBe(0);
  });

  it('answers unknown paths and methods', async () => {
    const env = siteEnv();
    expect((await call(env, 'GET', '/api/site/nothing')).status).toBe(404);
    const res = await call(env, 'DELETE', '/api/site');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, PUT, OPTIONS');
    expect((await call(env, 'GET', '/api/site/rollback')).status).toBe(405);
  });

  it('keeps the published site in memory in dummy mode without a SITE namespace', async () => {
    const env = siteEnv({ SITE: undefined });
    const { res, body } = await publish(env);
    expect(res.status).toBe(200);
    expect((await json(await call(env, 'GET', '/api/site'))).body.version).toBe(body.version);
  });

  it('says so when the SITE namespace is missing in live mode', async () => {
    const env = siteEnv({ SITE: undefined, HOSPITABLE_PAT: 'pat_live_token' });
    const { res, body } = await json(await call(env, 'GET', '/api/site'));
    expect(res.status).toBe(500);
    expect(body.error).toBe('no_storage');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('KV binding SITE is missing'));
  });

  it('reports its version, which matches package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
});

describe('CORS', () => {
  const preflight = (env, origin) =>
    worker.fetch(new Request(ORIGIN + '/api/site', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' } }), env, {});

  it('lets the builder publish from its own website', async () => {
    const res = await preflight(siteEnv(), BUILDER);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(BUILDER);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, PUT, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-Match');
    expect(res.headers.get('Vary')).toBe('Origin');
    const get = await call(siteEnv(), 'GET', '/api/site', { headers: { Origin: BUILDER } });
    expect(get.headers.get('Access-Control-Allow-Origin')).toBe(BUILDER);
    // Errors reach the builder too, so it can explain them.
    const denied = await call(siteEnv(), 'GET', '/api/site', { key: null, headers: { Origin: BUILDER } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe(BUILDER);
  });

  it('gives other websites no access', async () => {
    for (const origin of ['https://evil.example.com', 'https://builder.example.com.evil.net', 'http://builder.example.com', 'null']) {
      const res = await preflight(siteEnv(), origin);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(res.headers.get('Vary')).toBe('Origin');
      const get = await call(siteEnv(), 'GET', '/api/site', { headers: { Origin: origin } });
      expect(get.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('follows a local builder for development', async () => {
    const env = siteEnv({ BUILDER_URL: 'http://127.0.0.1:5174/' });
    expect((await preflight(env, 'http://127.0.0.1:5174')).headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5174');
    expect((await preflight(env, BUILDER)).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('keeps listing data open to every website', async () => {
    const res = await worker.fetch(new Request(ORIGIN + '/api/properties', { headers: { Origin: 'https://any.example.com' } }), siteEnv(), {});
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
