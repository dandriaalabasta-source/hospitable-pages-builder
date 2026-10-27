import { describe, expect, it } from 'vitest';
import { amenities, amenityLabel } from '../src/amenities.js';

describe('amenities', () => {
  it('makes API codes readable', () => {
    expect(amenityLabel('shower')).toBe('Shower');
    expect(amenityLabel('hot_water_kettle')).toBe('Hot water kettle');
    expect(amenityLabel('wifi')).toBe('Wi-Fi');
    expect(amenityLabel('smart_tv')).toBe('Smart TV');
    expect(amenityLabel('ev_charger')).toBe('EV charger');
  });

  it('shows anything that is not a code exactly as it is', () => {
    expect(amenityLabel('Rooftop Bar')).toBe('Rooftop Bar');
    expect(amenityLabel('Nespresso® machine')).toBe('Nespresso® machine');
    expect(amenityLabel('kayaks (2)')).toBe('kayaks (2)');
  });

  it("keeps Hospitable's order as one flat list", () => {
    expect(amenities(['oven', 'shower', 'Rooftop Bar', 'oven', '', null])).toEqual(['Oven', 'Shower', 'Rooftop Bar']);
  });
});
