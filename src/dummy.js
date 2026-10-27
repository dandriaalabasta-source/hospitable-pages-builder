// Dummy mode: when HOSPITABLE_PAT is "dummy", this stands in for the
// Hospitable API. It answers with the sample data in fixtures/dummy.json in
// the exact shapes of Hospitable's OpenAPI spec (a test checks every
// response against it), so dummy data runs through the same code and privacy
// filter as real data. Calendars are generated from rules, always from today.

import fixture from './fixtures/dummy.json';

const api = fixture.api;
export const DUMMY_TOPICS = fixture.dummy.public_guide_topics.map((t) => t.toLowerCase());

const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Laravel-style paging envelope, as the spec describes it. */
function page(list, url, maxPerPage) {
  const params = url.searchParams;
  const perPage = Math.min(Number(params.get('per_page')) || 10, maxPerPage);
  const current = Math.max(1, Number(params.get('page')) || 1);
  const lastPage = Math.max(1, Math.ceil(list.length / perPage));
  const path = url.origin + url.pathname;
  const at = (n) => `${path}?page=${n}`;
  const data = list.slice((current - 1) * perPage, current * perPage);
  const from = data.length ? (current - 1) * perPage + 1 : 0;
  return {
    data,
    // The spec types prev and next as strings, so a missing page is an empty string.
    links: { first: at(1), last: at(lastPage), prev: current > 1 ? at(current - 1) : '', next: current < lastPage ? at(current + 1) : '' },
    meta: {
      current_page: current,
      from,
      last_page: lastPage,
      links: [{ url: null, label: '&laquo; Previous', active: false }, { url: at(current), label: String(current), active: true }, { url: null, label: 'Next &raquo;', active: false }],
      path,
      per_page: perPage,
      to: from ? from + data.length - 1 : 0,
      total: list.length,
    },
  };
}

function formatted(amount, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
}

// Small seeded random number generator, so the sample calendar is the same on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Booked nights from 2026-01-01 on, as a Set of day numbers since the epoch. */
function bookedNights(rules, untilDay) {
  const rng = mulberry32(rules.seed);
  const booked = new Set();
  let day = 0;
  while (day < untilDay) {
    // Gaps get shorter as occupancy rises.
    day += Math.floor(rng() * 6 * (1 - rules.occupancy) * 2);
    const nights = 2 + Math.floor(rng() * 6);
    for (let i = 0; i < nights; i++) booked.add(day + i);
    day += nights;
  }
  return booked;
}

export function dummyCalendar(id, startDate, endDate) {
  const rules = fixture.dummy.calendar[id];
  const property = api.properties.find((p) => p.id === id);
  if (!rules || !property) return null;
  const start = Date.parse(startDate + 'T00:00:00Z');
  const end = Date.parse(endDate + 'T00:00:00Z');
  const todayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const booked = bookedNights(rules, Math.ceil((end - EPOCH) / DAY) + 1);
  const days = [];
  for (let t = start; t <= end; t += DAY) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const high = rules.high_season_months.includes(d.getUTCMonth() + 1);
    const weekend = dow === 5 || dow === 6;
    const amount = Math.round(((weekend ? rules.weekend : rules.weekday) * (high ? rules.high_season_factor : 1)) / 100) * 100;
    const past = t < todayStart;
    const isBooked = booked.has(Math.round((t - EPOCH) / DAY));
    const available = !past && !isBooked;
    days.push({
      date,
      day: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][dow],
      min_stay: high ? rules.high_season_min_stay : rules.min_stay,
      note: isBooked ? 'SECRET calendar note: guest arriving late' : null,
      status: { reason: available ? 'AVAILABLE' : isBooked ? 'RESERVED' : 'BLOCKED', source_type: isBooked ? 'RESERVATION' : null, source: isBooked ? 'Airbnb' : null, available },
      price: { amount, formatted: formatted(amount, property.currency), currency: property.currency },
      closed_for_checkin: false,
      closed_for_checkout: false,
    });
  }
  return { listing_id: id, provider: 'dummy', start_date: startDate, end_date: endDate, days };
}

/** A fetch() that serves the Hospitable API from the sample data. */
export async function dummyFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const auth = new Headers(init.headers).get('Authorization');
  if (auth !== 'Bearer dummy') return json({ status_code: 401, reason_phrase: 'Unauthenticated' }, 401);

  const path = url.pathname.replace(/^\/v2/, '');
  const params = url.searchParams;

  if (path === '/user') return json({ data: api.user });
  if (path === '/properties') return json(page(api.properties, url, 100));

  const m = /^\/properties\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (!m) return json({ status_code: 404, reason_phrase: 'Not Found' }, 404);
  const id = decodeURIComponent(m[1]);
  const property = api.properties.find((p) => p.id === id);
  if (!property) return json({ status_code: 404, reason_phrase: 'Not Found' }, 404);

  switch (m[2]) {
    case undefined:
      // The spec documents this one without the usual "data" wrapper.
      return json(property);
    case 'images':
      return json({ data: api.images[id] || [] });
    case 'calendar': {
      const start = params.get('start_date') || new Date().toISOString().slice(0, 10);
      const end = params.get('end_date') || new Date(Date.parse(start) + 14 * DAY).toISOString().slice(0, 10);
      return json({ data: dummyCalendar(id, start, end) || { days: [] } });
    }
    case 'reviews':
      return json(page(api.reviews[id] || [], url, 50));
    case 'knowledge-hub':
      return json({ data: api.knowledge_hub[id] || { property: { id: 0, name: property.public_name, picture: null }, sources: [], topics: [] } });
    default:
      return json({ status_code: 404, reason_phrase: 'Not Found' }, 404);
  }
}
