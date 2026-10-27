// Display labels for Hospitable amenities.
//
// Hospitable's API sends amenities as one flat list of codes ("shower",
// "oven"). The widgets keep that list as it is: same order, no categories.
// A value that looks like a code is made readable ("hot_water_kettle" ->
// "Hot water kettle"); anything else, such as a custom amenity, passes
// through untouched.

const CODE = /^[a-z0-9]+(_[a-z0-9]+)*$/;

// Words that read wrong in sentence case.
const WORDS = { wifi: 'Wi-Fi', tv: 'TV', bbq: 'BBQ', ev: 'EV', ac: 'AC' };

export function amenityLabel(value) {
  const v = String(value).trim();
  if (!CODE.test(v)) return v;
  const words = v.split('_').map((w) => WORDS[w] || w);
  const first = words[0];
  words[0] = WORDS[v.split('_')[0]] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

/** Readable labels, in Hospitable's order, without duplicates. */
export function amenities(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const label = amenityLabel(value);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
