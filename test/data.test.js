import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { MemoryKV, clearMemory } from '../src/store.js';
import { resetState, today } from '../src/listings.js';
import { resetSite } from '../src/site.js';
import { dummyFetch } from '../src/dummy.js';

const ORIGIN = 'https://rina-pages.example.workers.dev';

// Property IDs in the sample data: UUIDs, as in Hospitable's API.
const VILLA = '550e8400-e29b-41d4-a716-446655440000'; // the spec's own example property
const LOFT = '6f1c2b9a-4d3e-4c8b-9a1e-2b7d5c0e8f41';
const HIDDEN = '9d3e7f10-2a4b-4c6d-8e9f-0a1b2c3d4e5f'; // not listed
const PAT = 'pat_live_TOKEN_must_never_leak';

// Words that only appear in private fields of the sample data.
const PRIVATE = ['SECRET', 'john.doe@', 'PEACHTREE', 'Atlanta', '30301', '-8.8291', '52.5302', 'webcal', 'ical', 'Senefelderplatz – unit', 'Hidden Cabin', 'Vacation Rental Calendar'];

function get(path, env) {
  return worker.fetch(new Request(ORIGIN + path), env, { waitUntil() {} });
}

async function json(path, env) {
  const res = await get(path, env);
  return { res, body: await res.json() };
}

/** Hospitable stand-in for live mode: the sample data behind a real-looking token. */
function hospitable({ fail = null } = {}) {
  const calls = [];
  const state = { fail };
  const fn = vi.fn(async (url, init) => {
    calls.push(new URL(url).pathname.replace('/v2', ''));
    if (state.fail === 'network') throw new TypeError('fetch failed');
    if (typeof state.fail === 'number') return new Response(`{"reason_phrase":"echo ${PAT}"}`, { status: state.fail });
    const auth = new Headers(init.headers).get('Authorization');
    expect(auth).toBe(`Bearer ${PAT}`);
    return dummyFetch(url, { headers: { Authorization: 'Bearer dummy' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, state, fn };
}

function liveEnv(extra = {}) {
  return { HOSPITABLE_PAT: PAT, LISTINGS: new MemoryKV(), BUILDER_URL: 'https://builder.example.com/builder/', PUBLIC_GUIDE_TOPICS: 'Local attractions', ...extra };
}

const dummyEnv = { HOSPITABLE_PAT: 'dummy', BUILDER_URL: 'https://builder.example.com/builder/' };

beforeEach(() => {
  clearMemory();
  resetState();
  resetSite();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('data routes', () => {
  it('redirects the home page to the builder while no site is published', async () => {
    const res = await get('/', dummyEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://builder.example.com/builder/?worker=' + encodeURIComponent(ORIGIN));
  });

  it('answers CORS preflights and refuses writes', async () => {
    expect((await worker.fetch(new Request(ORIGIN + '/api/host', { method: 'OPTIONS' }), dummyEnv)).status).toBe(204);
    const res = await worker.fetch(new Request(ORIGIN + '/api/host', { method: 'POST' }), dummyEnv);
    expect(res.status).toBe(405);
  });

  it('serves public, cacheable JSON any website can read', async () => {
    const { res } = await json('/api/properties', dummyEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=14400');
    expect(res.headers.get('X-Hosp-Mode')).toBe('dummy');
  });

  it('lets CACHE_MINUTES set how long browsers keep data', async () => {
    const cache = async (value) => (await get(`/api/properties/${VILLA}`, { ...dummyEnv, CACHE_MINUTES: value })).headers.get('Cache-Control');
    expect(await cache('15')).toBe('public, max-age=900');
    expect(await cache(' 90 ')).toBe('public, max-age=5400');
    expect(await cache('0')).toBe('no-store');
    expect(await cache('99999')).toBe('public, max-age=86400');
    for (const value of ['', '  ', 'soon', undefined]) expect(await cache(value)).toBe('public, max-age=14400');
    const { body } = await json('/api/properties?for=builder', { ...dummyEnv, CACHE_MINUTES: '15' });
    expect(body.cache_minutes).toBe(15);
    expect((await json('/api/properties', dummyEnv)).body.cache_minutes).toBeUndefined();
  });

  it('returns 404 for unknown and unlisted properties', async () => {
    expect((await get('/api/properties/nope', dummyEnv)).status).toBe(404);
    expect((await get(`/api/properties/${HIDDEN}`, dummyEnv)).status).toBe(404);
    expect((await get(`/api/properties/${HIDDEN}/calendar`, dummyEnv)).status).toBe(404);
    expect((await get('/api/nothing', dummyEnv)).status).toBe(404);
  });
});

describe('dummy mode', () => {
  it('lists the two sample properties', async () => {
    const { body } = await json('/api/properties', dummyEnv);
    expect(body.mode).toBe('dummy');
    expect(body.properties.map((p) => p.id)).toEqual([VILLA, LOFT]);
    expect(body.properties[0]).toMatchObject({ property_name: 'Relaxing Villa near the sea', city: 'Uluwatu', max_guests: 6, currency: 'USD' });
    // The public name, never the host's internal one.
    expect(body.properties[1]).toMatchObject({ property_name: 'Bright loft at Senefelderplatz', city: 'Berlin', country: 'Germany', max_guests: 2, currency: 'EUR' });
  });

  it('serves full property data', async () => {
    const { body } = await json(`/api/properties/${VILLA}`, dummyEnv);
    expect(body).toMatchObject({
      property_name: 'Relaxing Villa near the sea',
      max_guests: 6,
      bedrooms: 3,
      bathrooms: 3.5,
      check_in: '15:00',
      check_out: '11:00',
      pets_allowed: false,
      // The spec's example money: { amount: 12345, formatted: "$123.45" }
      security_deposit: 123.45,
      extra_guest_fee: 123.45,
      extra_guest_after: 4,
      cleaning_fee: 123.45,
      payment_terms: '20% due at booking\n30% due 45 days before check-in\n50% due 10 days before check-in',
    });
    // In Hospitable's order; codes made readable, anything else shown as it is.
    expect(body.amenities.slice(0, 4)).toEqual(['Shower', 'Oven', 'Wi-Fi', 'Pool']);
    expect(body.amenities.at(-1)).toBe('Private chef on request');
    expect(body).not.toHaveProperty('amenity_groups'); // the API sends one flat list, so the widget does too
    expect(body.photos).toHaveLength(9);
    expect(body.photos[0]).toEqual({ url: expect.stringMatching(/^https:\/\//), thumbnail_url: expect.stringMatching(/^https:\/\//), caption: 'Infinity pool at sunset' });
    expect(body.rooms.map((r) => r.name)).toEqual(['Bedroom 1', 'Bedroom 2', 'Bedroom 3']);
    expect(body.rooms[0].beds).toEqual([{ type: 'king_size', label: 'King bed', quantity: 1 }]);
    expect(body.rooms[2].beds).toEqual([{ type: 'single_bed', label: 'Single bed', quantity: 2 }]);
    expect(body.fees).toEqual([{ name: 'Cleaning fee', amount: 123.45, type: 'fixed' }, { name: 'Management fee', amount: 10, type: 'percent' }]);
    expect(body.channels).toEqual([
      { platform: 'airbnb', name: 'Airbnb', url: 'https://www.airbnb.com/rooms/48151623' },
      { platform: 'vrbo', name: 'Vrbo', url: 'https://www.vrbo.com/2718281' },
      { platform: 'direct', name: 'Book direct', url: 'https://yoursite.hospitable.rentals/property/your-property' },
    ]);
    expect(body.cancellation_policy).toBe('100% refund 24 hours after booking accepted, if booking is requested at least 24 hours before check-in');
  });

  it('folds other data sets into one response with ?include=', async () => {
    const { res, body } = await json(`/api/properties/${VILLA}?include=reviews,calendar,host,bogus`, dummyEnv);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ property_name: 'Relaxing Villa near the sea', review_count: 7, currency: 'USD', host_name: 'Johny Doe & Co' });
    expect(body.calendar.length).toBeGreaterThanOrEqual(365);
    expect(body.reviews).toHaveLength(7);
    expect((await get('/api/properties/nope?include=reviews', dummyEnv)).status).toBe(404);
  });

  it('serves a year of calendar starting today, in major currency units', async () => {
    const { body } = await json(`/api/properties/${LOFT}/calendar`, dummyEnv);
    expect(body.currency).toBe('EUR');
    expect(body.calendar[0].date).toBe(today());
    expect(body.calendar.length).toBeGreaterThanOrEqual(365);
    const open = body.calendar.filter((d) => d.available);
    const booked = body.calendar.filter((d) => !d.available);
    expect(open.length).toBeGreaterThan(50);
    expect(booked.length).toBeGreaterThan(50);
    expect(open[0].price).toBeGreaterThan(100);
    expect(open[0].price).toBeLessThan(250);
    expect(booked.every((d) => d.price === null)).toBe(true);
    expect(Object.keys(body.calendar[0]).sort()).toEqual(['available', 'date', 'min_stay', 'price']);
  });

  it('serves public reviews with an average and a count', async () => {
    const { body } = await json(`/api/properties/${VILLA}/reviews`, dummyEnv);
    expect(body.review_count).toBe(7);
    expect(body.rating_average).toBe(4.57); // (5+5+4+5+3+5+5) / 7
    expect(body.reviews[0]).toEqual({
      id: '7a1f0c22-5b6e-4f3a-9c8d-1e2f3a4b5c01', rating: 5, guest_name: 'Sophie', date: '2026-09-28', platform: 'airbnb',
      text: expect.stringContaining('best villa'), host_response: expect.stringContaining('another sunset'),
    });
    // The spec's own example review, last because it is the oldest.
    expect(body.reviews.at(-1)).toMatchObject({ text: 'Great place we will be back!', host_response: 'So happy you enjoyed it so much!', guest_name: 'Jane' });
    // An empty response from the API means "no response".
    expect(body.reviews[1].host_response).toBeNull();
  });

  it('serves only the public guide topics', async () => {
    const { body } = await json(`/api/properties/${VILLA}/guide`, dummyEnv);
    expect(body.guide.map((t) => t.title)).toEqual(['Local attractions', 'Where to eat']);
    expect(body.guide[1].items).toHaveLength(2); // the item still being processed is left out
    expect(body.guide[0].items[0]).toEqual({ title: 'Uluwatu Temple', body: expect.stringMatching(/^A sea temple/) });
  });

  it('serves the host name and picture', async () => {
    const { body } = await json('/api/host', dummyEnv);
    // The spec's example user is a business, so the company name shows.
    expect(body).toMatchObject({ host_name: 'Johny Doe & Co', host_picture: expect.stringMatching(/^https:\/\//) });
  });

  it('never exposes private fields, whatever the endpoint', async () => {
    const paths = ['/api/properties', '/api/host'];
    for (const id of [VILLA, LOFT]) {
      paths.push(`/api/properties/${id}`, `/api/properties/${id}/calendar`, `/api/properties/${id}/reviews`, `/api/properties/${id}/guide`);
    }
    for (const path of paths) {
      const text = await (await get(path, dummyEnv)).text();
      for (const word of PRIVATE) expect(text, `${path} leaks "${word}"`).not.toContain(word);
      expect(text).not.toMatch(/"(address|wifi_\w+|house_manual|guest_access|email|last_name|feedback|note|latitude|tags|public_name|platform_email)"\s*:/);
    }
  });

  it('never calls Hospitable and skips the cron', async () => {
    const real = vi.fn();
    vi.stubGlobal('fetch', real);
    await get(`/api/properties/${VILLA}`, dummyEnv);
    await worker.scheduled({}, dummyEnv, {});
    expect(real).not.toHaveBeenCalled();
  });
});

describe('live mode', () => {
  it('fetches once on a cold start, stores, then answers from memory and KV', async () => {
    const { calls } = hospitable();
    const env = liveEnv();
    const first = await json(`/api/properties/${VILLA}`, env);
    expect(first.res.status).toBe(200);
    expect(first.body.mode).toBe('live');
    expect(calls).toEqual(['/properties', `/properties/${VILLA}/images`]);
    expect(env.LISTINGS.data.has('list')).toBe(true);
    expect(env.LISTINGS.data.has(`prop:${VILLA}`)).toBe(true);

    await get(`/api/properties/${VILLA}`, env);
    clearMemory(); // a new isolate: memory is gone, KV is not
    const again = await json(`/api/properties/${VILLA}`, env);
    expect(again.body.property_name).toBe('Relaxing Villa near the sea');
    expect(calls).toHaveLength(2);
  });

  it('answers with the data sets it has when one of them fails, and keeps that answer out of caches', async () => {
    const h = hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}`, env);
    h.state.fail = 'network';
    const { res, body } = await json(`/api/properties/${VILLA}?include=calendar,guide,host,reviews`, env);
    expect(res.status).toBe(200);
    expect(body.property_name).toBe('Relaxing Villa near the sea');
    expect(body.missing).toEqual(['calendar', 'guide', 'host', 'reviews']);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(body)).not.toContain(PAT);
  });

  it('shows "Untitled listing", never the internal name, for a property without a public name', async () => {
    const { property } = await import('../src/normalize.js');
    expect(property({ id: 'p', name: 'Villa 3 - owner Budi - code 4471', public_name: '' }).property_name).toBe('Untitled listing');
    expect(property({ id: 'p', name: 'Internal', public_name: 'Sea view villa' }).property_name).toBe('Sea view villa');
  });

  it('reads the property list from KV once for all the data sets of a request', async () => {
    hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}?include=calendar,guide,host,reviews`, env);
    clearMemory(); // a cold isolate: everything is in KV now
    env.LISTINGS.reads = 0;
    const { res } = await json(`/api/properties/${VILLA}?include=calendar,guide,host,reviews`, env);
    expect(res.status).toBe(200);
    // list, property, photos, calendar, reviews, guide, host
    expect(env.LISTINGS.reads).toBe(7);
  });

  it('does not call Hospitable for property IDs it does not know', async () => {
    const { calls } = hospitable();
    const env = liveEnv();
    await get('/api/properties', env);
    const before = calls.length;
    expect((await get('/api/properties/made-up-id/calendar', env)).status).toBe(404);
    expect(calls.length).toBe(before);
  });

  it('reports a rejected token to the builder when there is no data yet', async () => {
    hospitable({ fail: 401 });
    const env = liveEnv();
    const { res, body } = await json('/api/properties?for=builder', env);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ error: 'unavailable', token: 'rejected' });
    expect(JSON.stringify(body)).not.toContain(PAT);
  });

  it('keeps serving the last good data when Hospitable is down', async () => {
    const h = hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}/reviews`, env);
    h.state.fail = 'network';
    await worker.scheduled({}, env, {});
    clearMemory();
    const { res, body } = await json(`/api/properties/${VILLA}/reviews`, env);
    expect(res.status).toBe(200);
    expect(body.review_count).toBe(7);
    const status = await json('/api/properties?for=builder', env);
    expect(status.body.status).toMatchObject({ token: 'unknown', error: expect.stringContaining('Could not reach Hospitable') });
  });

  it('tells the builder when a token expires, while still serving data', async () => {
    const h = hospitable();
    const env = liveEnv();
    await get('/api/properties', env);
    h.state.fail = 401;
    await worker.scheduled({}, env, {});
    clearMemory();
    const { res, body } = await json('/api/properties?for=builder', env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body.properties).toHaveLength(2);
    expect(body.status.token).toBe('rejected');
    expect(JSON.stringify(body)).not.toContain(PAT);
  });

  it('only exposes public fields', async () => {
    hospitable();
    const env = liveEnv();
    for (const path of ['/api/properties', '/api/host', `/api/properties/${VILLA}`, `/api/properties/${VILLA}/calendar`, `/api/properties/${VILLA}/reviews`, `/api/properties/${VILLA}/guide`]) {
      const text = await (await get(path, env)).text();
      for (const word of PRIVATE) expect(text, `${path} leaks "${word}"`).not.toContain(word);
    }
    // Nothing private reaches KV either.
    const stored = [...env.LISTINGS.data.values()].map((v) => v.value).join('\n');
    for (const word of PRIVATE) expect(stored, `KV holds "${word}"`).not.toContain(word);
  });

  it.each([[''], ['   '], [undefined]])('serves no guide content while PUBLIC_GUIDE_TOPICS is %j', async (topics) => {
    const { calls } = hospitable();
    const env = liveEnv({ PUBLIC_GUIDE_TOPICS: topics });
    const { body } = await json(`/api/properties/${VILLA}/guide`, env);
    expect(body.guide).toEqual([]);
    expect(calls).not.toContain(`/properties/${VILLA}/knowledge-hub`);
  });
});

describe('hourly refresh', () => {
  it('refreshes only the data sets widgets asked for', async () => {
    const { calls } = hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}/reviews`, env);
    calls.length = 0;
    await worker.scheduled({}, env, {});
    expect(calls).toEqual(['/properties', `/properties/${VILLA}/reviews`]);
  });

  it('does not rewrite data that has not changed', async () => {
    hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}`, env);
    await get(`/api/properties/${VILLA}/reviews`, env);
    await worker.scheduled({}, env, {});
    const before = env.LISTINGS.writes;
    await worker.scheduled({}, env, {});
    // At most the run status changes from one hour to the next.
    expect(env.LISTINGS.writes - before).toBeLessThanOrEqual(1);
  });

  it('fills in prices once a Property list widget is on a page', async () => {
    const { calls } = hospitable();
    const env = liveEnv();
    const first = await json('/api/properties', env);
    expect(first.body.properties[0].price_from).toBeNull();
    await worker.scheduled({}, env, {});
    expect(calls).toContain(`/properties/${VILLA}/calendar`);
    expect(calls).toContain(`/properties/${LOFT}/calendar`);
    clearMemory();
    const { body } = await json('/api/properties', env);
    expect(body.properties[0].price_from).toBeGreaterThan(100);
  });

  it('rotates through properties when the subrequest budget runs out', async () => {
    const { calls } = hospitable();
    const env = liveEnv({ SUBREQUEST_BUDGET: '3' });
    for (const id of [VILLA, LOFT]) {
      await get(`/api/properties/${id}/reviews`, env);
      await get(`/api/properties/${id}/calendar`, env);
    }
    calls.length = 0;
    await worker.scheduled({}, env, {});
    expect(calls).toEqual(['/properties', `/properties/${VILLA}/calendar`, `/properties/${VILLA}/reviews`]);
    calls.length = 0;
    await worker.scheduled({}, env, {});
    expect(calls).toEqual(['/properties', `/properties/${LOFT}/calendar`, `/properties/${LOFT}/reviews`]);
  });

  it('drops data for properties that are no longer listed', async () => {
    hospitable();
    const env = liveEnv();
    await get(`/api/properties/${LOFT}/reviews`, env);
    env.LISTINGS.data.set('rev:gone-property', { value: '{}', metadata: {} });
    await worker.scheduled({}, env, {});
    expect(env.LISTINGS.data.has('rev:gone-property')).toBe(false);
    expect(env.LISTINGS.data.has(`rev:${LOFT}`)).toBe(true);
  });

  it('stops early when the token is rejected', async () => {
    const h = hospitable();
    const env = liveEnv();
    await get(`/api/properties/${VILLA}/reviews`, env);
    h.state.fail = 401;
    h.calls.length = 0;
    await worker.scheduled({}, env, {});
    expect(h.calls).toEqual(['/properties']);
  });
});
