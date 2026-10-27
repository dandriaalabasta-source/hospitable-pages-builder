// Checks a site the builder publishes, before it is stored.
//
// The Worker doesn't know block types: blocks are drawn in the visitor's
// browser by the runtime, which comes from the builder's host, so new blocks
// reach every site without a Worker update. The checks here are therefore
// generic. Pages keep only the fields the Worker itself uses; a block's props
// (`p`) are kept whole but must be plain JSON of bounded size, and no string
// in them may be a script URL, whichever block or prop it sits in.

export const MAX_BYTES = 512 * 1024;
export const MAX_PAGES = 50;
export const MAX_BLOCKS = 100;
export const MAX_DEPTH = 6;
export const MAX_STRING = 5000;
export const MAX_VALUES = 2000;

/** Paths the Worker answers itself, so no page may use them as its slug. */
export const RESERVED_SLUGS = new Set(['api', 'assets', 'runtime', '_preview', 'sitemap.xml', 'robots.txt', 'favicon.ico']);

const SLUG = /^([a-z0-9]+(-[a-z0-9]+)*)?$/;
const TYPE = /^[a-z][a-z0-9]{0,31}$/;
const THEME_VALUE = /^[A-Za-z]{1,24}$/;
const SCHEMES = ['javascript:', 'data:', 'vbscript:'];

/** A message for the host, naming the page or block that needs fixing. */
export class SiteError extends Error {}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isText(v, max, { empty = true } = {}) {
  return typeof v === 'string' && v.length <= max && (empty || v.trim() !== '');
}

/**
 * The scheme a browser would see if the string were used as a link. Browsers
 * ignore spaces and control characters around and inside "javascript:", so
 * they are removed before comparing.
 */
export function unsafeScheme(value) {
  const squeezed = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, '').toLowerCase();
  return SCHEMES.find((s) => squeezed.startsWith(s)) || null;
}

function quote(s) {
  return `“${String(s).length > 40 ? String(s).slice(0, 39) + '…' : s}”`;
}

function propPath(path, key) {
  return typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Walks a block's props: plain JSON, at most MAX_DEPTH levels and MAX_VALUES values. */
function checkProps(p, where) {
  let count = 0;
  const walk = (value, path, depth) => {
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new SiteError(`${where}: ${path} is not a valid number`);
      return;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_STRING) throw new SiteError(`${where}: ${path} is longer than ${MAX_STRING} characters`);
      const scheme = unsafeScheme(value);
      if (scheme) throw new SiteError(`${where}: ${path} starts with "${scheme}", which isn't allowed`);
      return;
    }
    const isArray = Array.isArray(value);
    if (!isArray && !isPlainObject(value)) throw new SiteError(`${where}: ${path} is not plain JSON`);
    if (depth > MAX_DEPTH) throw new SiteError(`${where}: ${path} is nested more than ${MAX_DEPTH} levels deep`);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    for (const [key, child] of entries) {
      if (++count > MAX_VALUES) throw new SiteError(`${where}: has more than ${MAX_VALUES} values`);
      if (typeof key === 'string') {
        // The runtime may copy props into other objects; this name would change their prototype.
        if (key === '__proto__') throw new SiteError(`${where}: ${path} has a field named "__proto__", which isn't allowed`);
        if (key.length > MAX_STRING) throw new SiteError(`${where}: ${path} has a field name longer than ${MAX_STRING} characters`);
      }
      walk(child, propPath(path, key), depth + 1);
    }
  };
  walk(p, 'p', 1);
}

function checkBlock(block, where) {
  if (!isPlainObject(block)) throw new SiteError(`${where}: must be an object`);
  if (typeof block.type !== 'string' || !TYPE.test(block.type)) {
    throw new SiteError(`${where}: type ${JSON.stringify(block.type ?? null)} must be a lowercase word of letters and digits, at most 32 long`);
  }
  where = `${where} (${block.type})`;
  if (!isText(block.id, 40, { empty: false })) throw new SiteError(`${where}: id must be text of 1 to 40 characters`);
  const p = block.p ?? {};
  if (!isPlainObject(p)) throw new SiteError(`${where}: p must be an object`);
  checkProps(p, where);
  return { id: block.id, type: block.type, p };
}

function checkPage(page, index) {
  let where = `Page ${index + 1}`;
  if (!isPlainObject(page)) throw new SiteError(`${where}: must be an object`);
  if (!isText(page.name, 80, { empty: false })) throw new SiteError(`${where}: the name must be text of 1 to 80 characters`);
  where = `Page ${quote(page.name)}`;
  if (!isText(page.id, 40, { empty: false })) throw new SiteError(`${where}: id must be text of 1 to 40 characters`);
  if (typeof page.slug !== 'string') throw new SiteError(`${where}: slug must be text ("" for the home page)`);
  if (page.slug.length > 80) throw new SiteError(`${where}: slug is longer than 80 characters`);
  if (!SLUG.test(page.slug)) {
    throw new SiteError(`${where}: slug ${JSON.stringify(page.slug)} may only use lowercase letters, digits and single dashes between them`);
  }
  if (RESERVED_SLUGS.has(page.slug)) throw new SiteError(`${where}: slug ${JSON.stringify(page.slug)} is reserved`);
  if (page.nav != null && typeof page.nav !== 'boolean') throw new SiteError(`${where}: nav must be true or false`);
  if (page.seoTitle != null && !isText(page.seoTitle, 200)) throw new SiteError(`${where}: the SEO title must be text of at most 200 characters`);
  if (page.seoDesc != null && !isText(page.seoDesc, 500)) throw new SiteError(`${where}: the SEO description must be text of at most 500 characters`);
  const blocks = page.blocks ?? [];
  if (!Array.isArray(blocks)) throw new SiteError(`${where}: blocks must be a list`);
  if (blocks.length > MAX_BLOCKS) throw new SiteError(`${where}: has ${blocks.length} blocks, at most ${MAX_BLOCKS} are allowed`);
  return {
    id: page.id,
    name: page.name,
    slug: page.slug,
    nav: page.nav ?? false,
    seoTitle: page.seoTitle ?? '',
    seoDesc: page.seoDesc ?? '',
    blocks: blocks.map((b, i) => checkBlock(b, `${where}, block ${i + 1}`)),
  };
}

/**
 * Checks a parsed site and returns the copy to store: known fields only,
 * optional ones filled in.
 * @param {unknown} input
 * @returns {{ runtime: number, name: string, theme: { acc?: string, hf?: string }, pages: object[] }}
 * @throws {SiteError}
 */
export function validateSite(input) {
  if (!isPlainObject(input)) throw new SiteError('The site must be a JSON object');
  if (!Number.isInteger(input.runtime) || input.runtime < 1 || input.runtime > 99) {
    throw new SiteError('"runtime" must be a whole number from 1 to 99');
  }
  if (input.name != null && !isText(input.name, 80)) throw new SiteError('The site name must be text of at most 80 characters');
  const theme = {};
  if (input.theme != null) {
    if (!isPlainObject(input.theme)) throw new SiteError('"theme" must be an object');
    for (const key of ['acc', 'hf']) {
      const v = input.theme[key];
      if (v == null) continue;
      if (typeof v !== 'string' || !THEME_VALUE.test(v)) throw new SiteError(`theme.${key} must be 1 to 24 letters`);
      theme[key] = v;
    }
  }
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_PAGES) {
    throw new SiteError(`A site needs 1 to ${MAX_PAGES} pages`);
  }

  const pages = input.pages.map(checkPage);

  const bySlug = new Map();
  for (const page of pages) {
    const other = bySlug.get(page.slug);
    if (other && page.slug === '') throw new SiteError(`Only one page can be the home page (empty slug): ${quote(other.name)} and ${quote(page.name)} both are`);
    if (other) throw new SiteError(`Page ${quote(page.name)}: slug ${JSON.stringify(page.slug)} is already used by page ${quote(other.name)}`);
    bySlug.set(page.slug, page);
  }
  if (!bySlug.has('')) throw new SiteError('One page must be the home page, with an empty slug');

  return { runtime: input.runtime, name: input.name ?? '', theme, pages };
}
