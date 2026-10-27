import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, SiteError, unsafeScheme, validateSite } from '../src/validate.js';
import { sampleSite } from './helpers/site.js';

/** The message validateSite throws for a site changed by `edit`. */
function problem(edit) {
  const site = sampleSite();
  edit(site);
  try {
    validateSite(site);
  } catch (err) {
    expect(err).toBeInstanceOf(SiteError);
    return err.message;
  }
  return null;
}

function nested(levels) {
  let v = 'deep';
  for (let i = 0; i < levels; i++) v = { x: v };
  return v;
}

describe('site checks', () => {
  it('accepts the sample site and keeps only the fields it knows', () => {
    const site = sampleSite();
    site.extra = 'dropped';
    site.theme.other = 'dropped';
    site.pages[0].secret = 'dropped';
    site.pages[0].blocks[0].style = 'dropped';
    const out = validateSite(site);
    expect(Object.keys(out)).toEqual(['runtime', 'name', 'theme', 'pages']);
    expect(out.theme).toEqual({ acc: 'Terracotta', hf: 'Serif' });
    expect(Object.keys(out.pages[0])).toEqual(['id', 'name', 'slug', 'nav', 'seoTitle', 'seoDesc', 'blocks']);
    expect(Object.keys(out.pages[0].blocks[0])).toEqual(['id', 'type', 'p']);
    // Props are kept whole: the Worker doesn't know block types.
    expect(out.pages[0].blocks[0].p).toEqual({ logo: 'Serambi', cta: { t: 'Book', h: '/villa-kayu' } });
  });

  it('fills in optional fields', () => {
    const out = validateSite({ runtime: 1, pages: [{ id: 'h', name: 'Home', slug: '', blocks: [{ id: 'a', type: 'text' }] }] });
    expect(out).toEqual({
      runtime: 1,
      name: '',
      theme: {},
      pages: [{ id: 'h', name: 'Home', slug: '', nav: false, seoTitle: '', seoDesc: '', blocks: [{ id: 'a', type: 'text', p: {} }] }],
    });
  });

  it('needs a JSON object', () => {
    for (const bad of [null, [], 'site', 3]) expect(() => validateSite(bad)).toThrow('The site must be a JSON object');
  });

  it('checks runtime, name and theme', () => {
    for (const runtime of [0, 100, 1.5, '1', null]) expect(problem((s) => (s.runtime = runtime))).toBe('"runtime" must be a whole number from 1 to 99');
    expect(problem((s) => (s.runtime = 99))).toBeNull();
    expect(problem((s) => (s.name = 'x'.repeat(81)))).toBe('The site name must be text of at most 80 characters');
    expect(problem((s) => (s.name = 7))).toBe('The site name must be text of at most 80 characters');
    expect(problem((s) => (s.theme = 'dark'))).toBe('"theme" must be an object');
    expect(problem((s) => (s.theme.acc = 'red; color: blue'))).toBe('theme.acc must be 1 to 24 letters');
    expect(problem((s) => (s.theme.hf = 'x'.repeat(25)))).toBe('theme.hf must be 1 to 24 letters');
  });

  it('needs 1 to 50 pages', () => {
    expect(problem((s) => (s.pages = []))).toBe('A site needs 1 to 50 pages');
    expect(problem((s) => (s.pages = { home: {} }))).toBe('A site needs 1 to 50 pages');
    expect(
      problem((s) => {
        for (let i = 0; i < 48; i++) s.pages.push({ id: `p${i}`, name: `P${i}`, slug: `p-${i}`, blocks: [] });
      }),
    ).toBe('A site needs 1 to 50 pages');
  });

  it('checks each page field', () => {
    expect(problem((s) => (s.pages[2] = 'contact'))).toBe('Page 3: must be an object');
    expect(problem((s) => (s.pages[2].name = '  '))).toBe('Page 3: the name must be text of 1 to 80 characters');
    expect(problem((s) => (s.pages[2].name = 'x'.repeat(81)))).toBe('Page 3: the name must be text of 1 to 80 characters');
    expect(problem((s) => (s.pages[2].id = 'x'.repeat(41)))).toBe('Page “Contact”: id must be text of 1 to 40 characters');
    expect(problem((s) => (s.pages[2].id = 3))).toBe('Page “Contact”: id must be text of 1 to 40 characters');
    expect(problem((s) => (s.pages[2].nav = 'yes'))).toBe('Page “Contact”: nav must be true or false');
    expect(problem((s) => (s.pages[2].seoTitle = 'x'.repeat(201)))).toBe('Page “Contact”: the SEO title must be text of at most 200 characters');
    expect(problem((s) => (s.pages[2].seoDesc = 'x'.repeat(501)))).toBe('Page “Contact”: the SEO description must be text of at most 500 characters');
    expect(problem((s) => (s.pages[2].blocks = {}))).toBe('Page “Contact”: blocks must be a list');
    expect(
      problem((s) => {
        s.pages[2].blocks = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, type: 'text', p: {} }));
      }),
    ).toBe('Page “Contact”: has 101 blocks, at most 100 are allowed');
  });

  it('checks slugs: format, length, reserved names, uniqueness and one home page', () => {
    for (const slug of ['Contact', 'contact us', 'contact-', '-contact', 'a--b', 'café', 'a/b']) {
      expect(problem((s) => (s.pages[2].slug = slug))).toBe(`Page “Contact”: slug ${JSON.stringify(slug)} may only use lowercase letters, digits and single dashes between them`);
    }
    expect(problem((s) => (s.pages[2].slug = 'a'.repeat(81)))).toBe('Page “Contact”: slug is longer than 80 characters');
    expect(problem((s) => (s.pages[2].slug = null))).toBe('Page “Contact”: slug must be text ("" for the home page)');
    expect(problem((s) => (s.pages[2].slug = 'api'))).toBe('Page “Contact”: slug "api" is reserved');
    for (const slug of RESERVED_SLUGS) expect(problem((s) => (s.pages[2].slug = slug))).toMatch(/is reserved|may only use/);
    expect(problem((s) => (s.pages[2].slug = 'villa-kayu'))).toBe('Page “Contact”: slug "villa-kayu" is already used by page “Villa Kayu”');
    expect(problem((s) => (s.pages[2].slug = ''))).toBe('Only one page can be the home page (empty slug): “Home” and “Contact” both are');
    expect(problem((s) => (s.pages[0].slug = 'home'))).toBe('One page must be the home page, with an empty slug');
  });

  it('checks each block', () => {
    const block = (b) => problem((s) => (s.pages[1].blocks[1] = b));
    expect(block('gallery')).toBe('Page “Villa Kayu”, block 2: must be an object');
    expect(block({ id: 'b', type: 'Gallery', p: {} })).toBe('Page “Villa Kayu”, block 2: type "Gallery" must be a lowercase word of letters and digits, at most 32 long');
    expect(block({ id: 'b', type: '1st', p: {} })).toMatch(/type "1st" must be/);
    expect(block({ id: 'b', type: 'a'.repeat(33), p: {} })).toMatch(/must be a lowercase word/);
    expect(block({ id: 'b', p: {} })).toBe('Page “Villa Kayu”, block 2: type null must be a lowercase word of letters and digits, at most 32 long');
    expect(block({ id: '', type: 'reviews', p: {} })).toBe('Page “Villa Kayu”, block 2 (reviews): id must be text of 1 to 40 characters');
    expect(block({ id: 'x'.repeat(41), type: 'reviews', p: {} })).toMatch(/id must be text of 1 to 40/);
    expect(block({ id: 'b', type: 'reviews', p: [] })).toBe('Page “Villa Kayu”, block 2 (reviews): p must be an object');
    expect(block({ id: 'b', type: 'reviews', p: 'x' })).toBe('Page “Villa Kayu”, block 2 (reviews): p must be an object');
  });

  it('limits how deep and how large props are', () => {
    const props = (p) => problem((s) => (s.pages[0].blocks[0].p = p));
    // p itself is level 1, so five more levels fit.
    expect(props(nested(6))).toBeNull();
    expect(props(nested(7))).toBe('Page “Home”, block 1 (header): p.x.x.x.x.x.x is nested more than 6 levels deep');
    expect(props({ items: [[[[[['too deep']]]]]] })).toBe('Page “Home”, block 1 (header): p.items[0][0][0][0][0] is nested more than 6 levels deep');
    expect(props({ body: 'x'.repeat(5000) })).toBeNull();
    expect(props({ body: 'x'.repeat(5001) })).toBe('Page “Home”, block 1 (header): p.body is longer than 5000 characters');
    expect(props({ items: [{ t: 'ok' }, { 'long key': 'y'.repeat(5001) }] })).toBe('Page “Home”, block 1 (header): p.items[1]["long key"] is longer than 5000 characters');
    expect(props({ list: Array.from({ length: 2000 }, (_, i) => i) })).toBe('Page “Home”, block 1 (header): has more than 2000 values');
    expect(props({ list: Array.from({ length: 1999 }, (_, i) => i) })).toBeNull();
    expect(props(JSON.parse('{"__proto__": {"polluted": true}}'))).toBe('Page “Home”, block 1 (header): p has a field named "__proto__", which isn\'t allowed');
  });

  it('only takes plain JSON in props', () => {
    const props = (p) => problem((s) => (s.pages[0].blocks[0].p = p));
    expect(props({ n: 1.5, b: false, z: null, s: '', a: [], o: {} })).toBeNull();
    expect(props({ when: new Date() })).toBe('Page “Home”, block 1 (header): p.when is not plain JSON');
    expect(props({ n: Infinity })).toBe('Page “Home”, block 1 (header): p.n is not a valid number');
    expect(props({ f: () => 1 })).toBe('Page “Home”, block 1 (header): p.f is not plain JSON');
  });

  it('refuses script URLs in any string, however they are disguised', () => {
    const props = (p) => problem((s) => (s.pages[0].blocks[0].p = p));
    expect(props({ cta: { t: 'Book', h: 'javascript:alert(1)' } })).toBe('Page “Home”, block 1 (header): p.cta.h starts with "javascript:", which isn\'t allowed');
    for (const s of ['  JavaScript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:x', '\u0001javascript:x', 'VBScript:msgbox', 'data:text/html,<script>', ' DATA:image/svg+xml,x']) {
      expect(unsafeScheme(s), JSON.stringify(s)).not.toBeNull();
      expect(props({ deep: [{ link: s }] })).toMatch(/^Page “Home”, block 1 \(header\): p\.deep\[0\]\.link starts with "(javascript|vbscript|data):", which isn't allowed$/);
    }
    for (const s of ['https://example.com', '/villa-kayu', 'mailto:hi@example.com', 'tel:+62123', 'The javascript: scheme', 'metadata: none']) {
      expect(unsafeScheme(s), JSON.stringify(s)).toBeNull();
    }
  });
});
