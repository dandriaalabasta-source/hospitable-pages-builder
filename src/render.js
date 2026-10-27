// HTML for site pages. The Worker writes only the page's frame: its title,
// the tags search engines and link previews read, the page's data as JSON,
// and a plain-HTML copy of its text for crawlers that don't run JavaScript.
// The blocks themselves are drawn in the visitor's browser by the runtime
// (site.js and site.css), which comes from the builder's host.

export const DEFAULT_BUILDER = 'https://hospitable-page-builder.adhityoagam.com/';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML content and attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * JSON that is safe inside <script type="application/json">: no "</script>",
 * "<!--" or line separators can end the element early or confuse a parser.
 */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** https, or http on this machine for development. */
function safeBase(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.has(url.hostname))) return url.origin + url.pathname;
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Where the runtime lives, without a trailing slash: RUNTIME_URL if it is a
 * safe address, otherwise "runtime/" next to the builder.
 */
export function runtimeUrl(env) {
  const own = String(env.RUNTIME_URL || '').trim();
  if (own) {
    const base = safeBase(own);
    if (base) return base.replace(/\/+$/, '');
    console.error('[hospitable-pages] RUNTIME_URL must be an https address; using the builder\'s runtime instead');
  }
  let fromBuilder = null;
  try {
    fromBuilder = safeBase(new URL('runtime/', String(env.BUILDER_URL || '').trim() || DEFAULT_BUILDER).toString());
  } catch {
    /* BUILDER_URL is not a URL */
  }
  return (fromBuilder || DEFAULT_BUILDER + 'runtime').replace(/\/+$/, '');
}

/** The page's own scripts may only come from the runtime's host; nothing else is restricted, so new blocks can load images or maps without a Worker update. */
export function contentSecurityPolicy(runtime) {
  return `script-src ${new URL(runtime).origin}; object-src 'none'; base-uri 'none'`;
}

export function pageTitle(site, page) {
  return page.seoTitle || (site.name ? `${page.name} · ${site.name}` : page.name);
}

/** Links a crawler may follow: on this site, on the page, https, mail and phone. */
function safeHref(h) {
  if (typeof h !== 'string') return null;
  const s = h.trim();
  if ((s.startsWith('/') && !s.startsWith('//')) || s.startsWith('#') || /^(https:\/\/|mailto:|tel:)/i.test(s)) return s;
  return null;
}

function isLink(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof v.t === 'string' && typeof v.h === 'string';
}

function link(v) {
  const href = safeHref(v.h);
  return href && v.t.trim() ? `<a href="${esc(href)}">${esc(v.t)}</a>` : '';
}

const HEADINGS = ['title', 'heading'];
const TEXTS = ['eyebrow', 'title', 'heading', 'sub', 'tagline', 'body'];

/** A plain copy of the page's words and links, for crawlers that don't run JavaScript. */
export function fallback(site, page, base) {
  const out = [];
  const nav = site.pages.filter((p) => p.nav).map((p) => `<a href="${esc(base + p.slug)}">${esc(p.name)}</a>`);
  if (nav.length) out.push(`<nav>${nav.join(' ')}</nav>`);
  out.push(`<h1>${esc(page.name)}</h1>`);
  for (const block of page.blocks) {
    const p = block.p || {};
    for (const key of TEXTS) {
      if (typeof p[key] !== 'string' || !p[key].trim()) continue;
      const tag = HEADINGS.includes(key) ? 'h2' : 'p';
      out.push(`<${tag}>${esc(p[key])}</${tag}>`);
    }
    for (const value of Object.values(p)) {
      const links = isLink(value) ? [value] : Array.isArray(value) ? value.filter(isLink) : [];
      for (const l of links) {
        const a = link(l);
        if (a) out.push(`<p>${a}</p>`);
      }
    }
  }
  return out.join('\n');
}

/** The first photo of the first property on the page, else of the first listed property. */
function shareImage(data) {
  for (const detail of Object.values(data.details || {})) {
    const url = detail?.photos?.[0]?.url;
    if (url) return url;
  }
  return data.properties?.[0]?.photo || null;
}

/**
 * The whole page.
 * @param {{ doc: object, page: object, origin: string, base: string, preview: boolean, data: object, runtime: string }} options
 */
export function renderPage({ doc, page, origin, base, preview, data, runtime }) {
  const site = doc.site;
  const title = pageTitle(site, page);
  const url = `${origin}/${page.slug}`;
  const image = shareImage(data);
  const asset = `${runtime}/v${site.runtime}`;
  const payload = {
    runtime: site.runtime,
    base,
    slug: page.slug,
    version: doc.id,
    site: {
      name: site.name,
      theme: site.theme,
      // Every page for navigation; only this page carries its blocks.
      pages: site.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug, nav: p.nav, seoTitle: p.seoTitle, seoDesc: p.seoDesc, blocks: p === page ? p.blocks : [] })),
    },
    data,
  };
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    page.seoDesc && `<meta name="description" content="${esc(page.seoDesc)}">`,
    preview && '<meta name="robots" content="noindex">',
    !preview && `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(title)}">`,
    page.seoDesc && `<meta property="og:description" content="${esc(page.seoDesc)}">`,
    !preview && `<meta property="og:url" content="${esc(url)}">`,
    site.name && `<meta property="og:site_name" content="${esc(site.name)}">`,
    image && `<meta property="og:image" content="${esc(image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<link rel="stylesheet" href="${esc(asset)}/site.css">`,
    `<script defer src="${esc(asset)}/site.js"></script>`,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en">
<head>
${head.join('\n')}
</head>
<body>
<div id="site"></div>
<noscript>
${fallback(site, page, base)}
</noscript>
<script id="site-data" type="application/json">${scriptJson(payload)}</script>
</body>
</html>
`;
}

/** A small page for addresses the site doesn't have. */
export function renderNotFound({ name, home }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found${name ? ' · ' + esc(name) : ''}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}a{color:inherit}</style>
</head>
<body>
<h1>Page not found</h1>
<p>This page doesn't exist, or it has moved.</p>
<p><a href="${esc(home)}">Go to the home page</a></p>
</body>
</html>
`;
}

export function renderSitemap(doc, origin) {
  const urls = doc.site.pages.map((p) => `<url><loc>${esc(`${origin}/${p.slug}`)}</loc><lastmod>${esc(doc.published_at)}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export function renderRobots(origin) {
  return `User-agent: *
Disallow: /api/
Disallow: /_preview/

Sitemap: ${origin}/sitemap.xml
`;
}
