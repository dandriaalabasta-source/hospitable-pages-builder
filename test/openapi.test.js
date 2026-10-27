import { describe, expect, it } from 'vitest';
import { dummyFetch } from '../src/dummy.js';
import { openapi, validate } from './helpers/openapi.js';
import fixture from '../src/fixtures/dummy.json';

const API = 'https://public.api.hospitable.com/v2';

async function call(path) {
  const res = await dummyFetch(API + path, { headers: { Authorization: 'Bearer dummy' } });
  expect(res.status, path).toBe(200);
  return res.json();
}

describe("dummy data matches Hospitable's OpenAPI spec", () => {
  it('copies the schemas from the published spec', () => {
    expect(openapi.source).toMatch(/^https:\/\/api\.stoplight\.io\//);
    expect(Object.keys(openapi.schemas)).toHaveLength(7);
  });

  const ids = fixture.api.properties.map((p) => p.id);

  it.each([
    ['/properties', '/properties?include=details,bookings,listings&per_page=100'],
    ['/user', '/user'],
  ])('%s', async (schema, path) => {
    expect(validate(openapi.schemas[schema], await call(path))).toEqual([]);
  });

  for (const id of ids) {
    it.each([
      ['/properties/{uuid}', `/properties/${id}?include=details,bookings,listings`],
      ['/properties/{uuid}/images', `/properties/${id}/images`],
      ['/properties/{uuid}/calendar', `/properties/${id}/calendar?start_date=2026-01-01&end_date=2026-12-31`],
      ['/properties/{uuid}/reviews', `/properties/${id}/reviews?include=guest&per_page=50`],
      ['/properties/{uuid}/knowledge-hub', `/properties/${id}/knowledge-hub`],
    ])(`%s for ${id.slice(0, 8)}`, async (schema, path) => {
      expect(validate(openapi.schemas[schema], await call(path))).toEqual([]);
    });
  }

  it('the check catches invented fields, wrong types and missing fields', async () => {
    const body = await call('/user');
    expect(validate(openapi.schemas['/user'], { data: { ...body.data, nickname: 'x' } })).toEqual(['$.data.nickname: not in the spec']);
    expect(validate(openapi.schemas['/user'], { data: { ...body.data, business: 'yes' } })).toEqual(['$.data.business: expected boolean, got string']);
    const list = await call('/properties?per_page=100');
    const { amenities, ...noAmenities } = list.data[0];
    expect(validate(openapi.schemas['/properties'], { ...list, data: [noAmenities] })).toContain('$.data[0]: missing required field "amenities"');
  });
});
