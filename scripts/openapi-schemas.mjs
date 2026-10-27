// Copies the response schemas of the Hospitable endpoints this kit calls
// out of Hospitable's published OpenAPI spec, with every $ref resolved, into
// test/fixtures/hospitable-openapi.json. The tests check the dummy data
// against them, so sample data can never drift from the real API.
//   node scripts/openapi-schemas.mjs [spec URL or file]

import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://api.stoplight.io/projects/cHJqOjI1MDgxOA/branches/main/export/V2/public.json';
const ENDPOINTS = {
  // path: the query the Worker sends, which decides which optional parts appear
  '/properties': 'include=details,bookings,listings',
  '/properties/{uuid}': 'include=details,bookings,listings',
  '/properties/{uuid}/images': '',
  '/properties/{uuid}/calendar': 'start_date, end_date',
  '/properties/{uuid}/reviews': 'include=guest',
  '/properties/{uuid}/knowledge-hub': '',
  '/user': '',
};

const from = process.argv[2] || SOURCE;
const spec = JSON.parse(/^https?:/.test(from) ? await (await fetch(from)).text() : readFileSync(from, 'utf8'));

function resolve(node, stack = []) {
  if (Array.isArray(node)) return node.map((n) => resolve(n, stack));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    if (stack.includes(node.$ref)) return {}; // recursion: stop here
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return resolve(target, [...stack, node.$ref]);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    // Examples and prose are not part of the contract.
    if (['examples', 'example', 'x-examples', 'description', 'x-stoplight', 'title'].includes(k)) continue;
    // Under "properties" the keys are field names (one is called "description").
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([f, s]) => [f, resolve(s, stack)])) : resolve(v, stack);
  }
  return out;
}

const schemas = {};
for (const path of Object.keys(ENDPOINTS)) {
  schemas[path] = resolve(spec.paths[path].get.responses['200'].content['application/json'].schema);
}
writeFileSync(
  new URL('../test/fixtures/hospitable-openapi.json', import.meta.url),
  JSON.stringify({ source: SOURCE, version: spec.info?.version, copied: new Date().toISOString().slice(0, 10), queries: ENDPOINTS, schemas }, null, 1) + '\n',
);
console.log(`Copied ${Object.keys(schemas).length} response schemas from ${from} (spec ${spec.info?.version})`);
