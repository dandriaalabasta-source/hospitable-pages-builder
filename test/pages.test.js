import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryKV, clearMemory } from '../src/store.js';
import { Listings, Unavailable, resetState } from '../src/listings.js';
import { resetSite } from '../src/site.js';
import { runtimeUrl, scriptJson } from '../src/render.js';
import { BUILDER, LOFT, ORIGIN, VILLA, call, publish, sampleSite, siteData, siteEnv } from './helpers/site.js';

// Words that only appear in private fields of the sample data.
const PRIVATE = ['SECRET', 'john.doe@', 'PEACHTREE', 'Atlanta', '30301', '-8.8291', '52.5302', 'webcal', 'Hidden Cabin'];
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

beforeEach(() => {
  clearMemory();
  resetState();
  resetSite();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A public request: no key. */
async function page(env, path, method = 'GET') {
  const res = await call(env, method, path, { key: null });
  return { res, html: await res.text() };
}

async function published(site = sampleSite(), extra = {}) {
  const env = siteEnv(extra);
  const { body } = await publish(env, site);
  return { env, version: body.version };
}

describe('before the first publish', () => {
  it('sends the home page to the builder, connected to this Worker', async () => {
    const res = await call(siteEnv(), 'GET', '/', { key: null });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BUILDER}/?worker=${encodeURIComponent(ORIGIN)}`);
  });

  it('has no other pages and no sitemap', async () => {
    const { res, html } = await page(siteEnv(), '/villa-kayu');
    expect(res.status).toBe(404);
    expect(html).toContain('<a href="/">');
    expect((await page(siteEnv(), '/sitemap.xml')).res.status).toBe(404);
  });
});

describe('site pages', () => {
  it('renders the home page for the runtime', async () => {
    const { env, version } = await published();
    const { res, html } = await page(env, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy')).toBe(`script-src ${BUILDER}; object-src 'none'; base-uri 'none'`);
    expect(res.headers.get('X-Robots-Tag')).toBeNull();

    expect(html).toMatch(/^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n/);
    expect(html).toContain('<title>Home · Serambi Villas</title>');
    expect(html).toContain('<meta name="description" content="Two quiet villas on the cliffs of Uluwatu.">');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<meta property="og:title" content="Home · Serambi Villas">');
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/">`);
    expect(html).toContain('<meta property="og:site_name" content="Serambi Villas">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<link rel="stylesheet" href="${BUILDER}/runtime/v1/site.css">`);
    expect(html).toContain(`<script defer src="${BUILDER}/runtime/v1/site.js"></script>`);
    expect(html).toContain('<body>\n<div id="site"></div>\n<noscript>');
    expect(html).not.toContain('noindex');

    const data = siteData(html);
    expect(data).toMatchObject({ runtime: 1, base: '/', slug: '', version });
    expect(data.site.name).toBe('Serambi Villas');
    expect(data.site.theme).toEqual({ acc: 'Terracotta', hf: 'Serif' });
    // Every page for navigation, but only this page's blocks.
    expect(data.site.pages.map((p) => [p.slug, p.blocks.length])).toEqual([['', 2], ['villa-kayu', 0], ['contact', 0]]);
    expect(Object.keys(data.site.pages[1])).toEqual(['id', 'name', 'slug', 'nav', 'seoTitle', 'seoDesc', 'blocks']);
  });

  it('inlines listing data, with the sample id "p1" falling back to the first property', async () => {
    const { env } = await published();
    const { data } = siteData((await page(env, '/')).html);
    expect(data.mode).toBe('dummy');
    expect(data.error).toBeNull();
    expect(data.properties.map((p) => p.id)).toEqual([VILLA, LOFT]);
    expect(Object.keys(data.details)).toEqual([VILLA]);
    // The same object as the API's ?include=calendar,reviews,host.
    const api = await (await call(env, 'GET', `/api/properties/${VILLA}?include=calendar,reviews,host`, { key: null })).json();
    const { updated_at: a, ...detail } = data.details[VILLA];
    const { updated_at: b, ...fromApi } = api;
    expect(detail).toEqual(fromApi);
    expect(detail).toMatchObject({ mode: 'dummy', property_name: 'Relaxing Villa near the sea', review_count: 7, host_name: 'Johny Doe & Co' });
    expect(detail.calendar.length).toBeGreaterThanOrEqual(365);
  });

  it('loads each property a page names once, in block order', async () => {
    const { env } = await published();
    const { res, html } = await page(env, '/villa-kayu');
    expect(res.status).toBe(200);
    expect(html).toContain('<title>Villa Kayu, a cliff-top villa in Uluwatu</title>');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/villa-kayu">`);
    const data = siteData(html);
    expect(data.slug).toBe('villa-kayu');
    expect(data.site.pages.map((p) => p.blocks.length)).toEqual([0, 3, 0]);
    expect(Object.keys(data.data.details)).toEqual([VILLA, LOFT]);
    // The link preview shows the first photo of the first property on the page.
    expect(html).toContain(`<meta property="og:image" content="${data.data.details[VILLA].photos[0].url.replaceAll('&', '&amp;')}">`);
  });

  it('uses the first listed photo for pages without property blocks, and the page name as title without a site name', async () => {
    const site = sampleSite();
    site.name = '';
    const { env } = await published(site);
    const { html } = await page(env, '/contact');
    const { data } = siteData(html);
    expect(data.details).toEqual({});
    expect(html).toContain(`<meta property="og:image" content="${data.properties[0].photo.replaceAll('&', '&amp;')}">`);
    expect(html).toContain('<title>Contact</title>');
    expect(html).not.toContain('og:site_name');
    expect(html).not.toContain('name="description"');
  });

  it('tolerates a trailing slash and answers HEAD', async () => {
    const { env } = await published();
    expect(siteData((await page(env, '/villa-kayu/')).html).slug).toBe('villa-kayu');
    const head = await page(env, '/villa-kayu', 'HEAD');
    expect(head.res.status).toBe(200);
    expect(head.html).toBe('');
    expect(head.res.headers.get('Content-Security-Policy')).toContain('script-src');
  });

  it('answers unknown pages with a 404 page that links home', async () => {
    const { env } = await published();
    for (const path of ['/nothing', '/Villa-Kayu', '/villa-kayu/photos', '/assets', '/runtime', '/index.html']) {
      const { res, html } = await page(env, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(html).toContain('<a href="/">Go to the home page</a>');
      expect(html).toContain('Serambi Villas');
    }
  });

  it('refuses writes to pages', async () => {
    const { env } = await published();
    expect((await call(env, 'POST', '/', { key: null, body: '{}' })).status).toBe(405);
  });

  it('escapes the host\'s text in titles and tags', async () => {
    const site = sampleSite();
    site.name = 'Bed & <Breakfast> "Inn"';
    site.pages[0].seoDesc = '"><script>alert(1)</script>';
    site.pages[0].name = "Home's <b>";
    const { env } = await published(site);
    const { html } = await page(env, '/');
    expect(html).toContain('<title>Home&#39;s &lt;b&gt; · Bed &amp; &lt;Breakfast&gt; &quot;Inn&quot;</title>');
    expect(html).toContain('<meta name="description" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(html).toContain('<meta property="og:site_name" content="Bed &amp; &lt;Breakfast&gt; &quot;Inn&quot;">');
    expect(html).toContain('<h1>Home&#39;s &lt;b&gt;</h1>');
    expect(html).not.toContain('<script>alert(1)');
    expect(siteData(html).site.name).toBe('Bed & <Breakfast> "Inn"');
  });

  it('keeps "</script>" in a block\'s text inside the page data', async () => {
    const site = sampleSite();
    const nasty = `</script><script>alert(1)</script><!-- & ${LS}${PS} end`;
    site.pages[0].blocks.push({ id: 'b9', type: 'text', p: { body: nasty, items: [{ q: '</SCRIPT >' }] } });
    const { env } = await published(site);
    const { html } = await page(env, '/');
    // Only the runtime's script tag and the data's own closing tag.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain('<!--');
    // Line separators are harmless in HTML text, but not inside the JSON.
    expect(/id="site-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]).not.toContain(LS);
    const block = siteData(html).site.pages[0].blocks.at(-1);
    expect(block.p).toEqual({ body: nasty, items: [{ q: '</SCRIPT >' }] });
    expect(scriptJson({ s: `<>&${LS}${PS}` })).toBe('{"s":"\\u003c\\u003e\\u0026\\u2028\\u2029"}');
  });

  it('writes a plain copy of the page for crawlers that run no JavaScript', async () => {
    const site = sampleSite();
    site.pages[0].blocks.push({
      id: 'b9', type: 'links',
      p: { heading: 'Find us', body: 'Open every day', links: [{ t: 'Mail', h: 'mailto:hi@serambi.example' }, { t: 'Elsewhere', h: '//evil.example.com' }, { t: 'Odd', h: 'ftp://x' }], map: { t: 'Map', h: 'https://maps.example.com/?q=a&b' } },
    });
    const { env } = await published(site);
    const { html } = await page(env, '/');
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)[1];
    expect(noscript).toContain('<nav><a href="/">Home</a> <a href="/villa-kayu">Villa Kayu</a></nav>');
    expect(noscript).not.toContain('/contact'); // not in the navigation
    expect(noscript).toContain('<h1>Home</h1>');
    expect(noscript).toContain('<p><a href="/villa-kayu">Book</a></p>');
    expect(noscript).toContain('<p>Bali</p>\n<h2>Slow days by the sea</h2>\n<p>Two villas, one view</p>');
    expect(noscript).toContain('<h2>Find us</h2>\n<p>Open every day</p>');
    expect(noscript).toContain('<a href="mailto:hi@serambi.example">Mail</a>');
    expect(noscript).toContain('<a href="https://maps.example.com/?q=a&amp;b">Map</a>');
    expect(noscript).not.toContain('evil.example.com');
    expect(noscript).not.toContain('ftp:');
  });

  it('never puts private listing details in a page', async () => {
    const { env } = await published();
    for (const path of ['/', '/villa-kayu']) {
      const { html } = await page(env, path);
      for (const word of PRIVATE) expect(html, `${path} leaks "${word}"`).not.toContain(word);
    }
  });

  it('loads the runtime version the site asks for', async () => {
    const site = sampleSite();
    site.runtime = 2;
    const { env } = await published(site);
    const { html } = await page(env, '/');
    expect(html).toContain(`${BUILDER}/runtime/v2/site.js`);
    expect(siteData(html).runtime).toBe(2);
  });

  it('takes the runtime from RUNTIME_URL when it is a safe address', async () => {
    expect(runtimeUrl({ BUILDER_URL: 'https://builder.example.com/app/' })).toBe('https://builder.example.com/app/runtime');
    expect(runtimeUrl({ BUILDER_URL: 'http://127.0.0.1:5174/' })).toBe('http://127.0.0.1:5174/runtime');
    expect(runtimeUrl({ BUILDER_URL: BUILDER, RUNTIME_URL: 'https://cdn.example.net/pages/runtime/' })).toBe('https://cdn.example.net/pages/runtime');
    expect(runtimeUrl({ BUILDER_URL: BUILDER, RUNTIME_URL: 'http://localhost:4000/rt?x=1' })).toBe('http://localhost:4000/rt');
    for (const bad of ['http://cdn.example.net/runtime', 'javascript:alert(1)', 'not a url']) {
      expect(runtimeUrl({ BUILDER_URL: BUILDER, RUNTIME_URL: bad })).toBe(`${BUILDER}/runtime`);
    }
    expect(runtimeUrl({})).toBe('https://hospitable-page-builder.adhityoagam.com/runtime');

    const { env } = await published(sampleSite(), { RUNTIME_URL: 'https://cdn.example.net/pages/runtime/' });
    const { res, html } = await page(env, '/');
    expect(html).toContain('<script defer src="https://cdn.example.net/pages/runtime/v1/site.js"></script>');
    expect(res.headers.get('Content-Security-Policy')).toBe("script-src https://cdn.example.net; object-src 'none'; base-uri 'none'");
    expect((await (await call(env, 'GET', '/api/site')).json()).worker.runtime_url).toBe('https://cdn.example.net/pages/runtime');
  });
});

describe('when listing data is unavailable', () => {
  it('still renders the page, with an error the runtime can show', async () => {
    const env = siteEnv({ HOSPITABLE_PAT: 'pat_live_token', LISTINGS: new MemoryKV() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await publish(env);
    const { res, html } = await page(env, '/villa-kayu');
    expect(res.status).toBe(200);
    expect(siteData(html).data).toEqual({ mode: 'live', properties: [], details: {}, error: 'unavailable' });
    expect(html).not.toContain('og:image');
  });

  it('still renders the page without a token', async () => {
    const env = siteEnv({ HOSPITABLE_PAT: '' });
    await publish(env);
    const { res, html } = await page(env, '/');
    expect(res.status).toBe(200);
    expect(siteData(html).data).toMatchObject({ mode: 'live', error: 'unavailable', properties: [] });
  });

  it('leaves out a property it cannot load and keeps the rest', async () => {
    const { env } = await published();
    vi.spyOn(Listings.prototype, 'property').mockImplementation(async (id) => {
      if (id === LOFT) throw new Unavailable('down');
      return { id, property_name: 'Villa', photos: [] };
    });
    const { res, html } = await page(env, '/villa-kayu');
    expect(res.status).toBe(200);
    const { data } = siteData(html);
    expect(Object.keys(data.details)).toEqual([VILLA]);
    expect(data.error).toBeNull();
  });
});

describe('previews', () => {
  it('renders a stored version under /_preview/, kept out of search engines', async () => {
    const env = siteEnv();
    await publish(env);
    const site = sampleSite();
    site.pages[1].name = 'Villa Kayu (draft)';
    const { body } = await publish(env, site, '/api/site?preview=1');
    for (const path of [`/_preview/${body.version}/`, `/_preview/${body.version}`, `/_preview/${body.version}/villa-kayu`]) {
      const { res, html } = await page(env, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain('og:url');
      const data = siteData(html);
      expect(data.base).toBe(`/_preview/${body.version}/`);
      expect(data.version).toBe(body.version);
      expect(data.site.pages[1].name).toBe('Villa Kayu (draft)');
    }
    // Navigation in the fallback stays inside the preview.
    expect((await page(env, `/_preview/${body.version}/`)).html).toContain(`<a href="/_preview/${body.version}/villa-kayu">`);
    // The live site is unchanged.
    expect(siteData((await page(env, '/villa-kayu')).html).site.pages[1].name).toBe('Villa Kayu');
  });

  it('answers unknown previews and pages with a 404', async () => {
    const env = siteEnv();
    const { body } = await publish(env);
    expect((await page(env, '/_preview/mvzzzzzz0000000000/')).res.status).toBe(404);
    expect((await page(env, '/_preview/not-an-id!/')).res.status).toBe(404);
    const missing = await page(env, `/_preview/${body.version}/nothing`);
    expect(missing.res.status).toBe(404);
    expect(missing.res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(missing.html).toContain(`<a href="/_preview/${body.version}/">`);
  });
});

describe('sitemap.xml and robots.txt', () => {
  it('lists every page of the live site with the time it was published', async () => {
    const { env } = await published();
    const published_at = (await (await call(env, 'GET', '/api/site')).json()).published_at;
    const { res, html: xml } = await page(env, '/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    for (const slug of ['', 'villa-kayu', 'contact']) {
      expect(xml).toContain(`<url><loc>${ORIGIN}/${slug}</loc><lastmod>${published_at}</lastmod></url>`);
    }
    expect(xml.match(/<url>/g)).toHaveLength(3);
  });

  it('keeps crawlers out of the API and previews and points them to the sitemap', async () => {
    const { res, html } = await page(siteEnv(), '/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(html).toBe(`User-agent: *\nDisallow: /api/\nDisallow: /_preview/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  });
});

describe('storage', () => {
  it('explains a missing SITE namespace in live mode', async () => {
    const { res } = await page(siteEnv({ SITE: undefined, HOSPITABLE_PAT: 'pat_live_token' }), '/');
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('KV binding SITE is missing'));
  });
});
