// A small JSON Schema check, strict where Hospitable's spec is specific: a
// field the spec doesn't list is an error, so sample data can't invent fields.
import { readFileSync } from 'node:fs';

export const openapi = JSON.parse(readFileSync(new URL('../fixtures/hospitable-openapi.json', import.meta.url), 'utf8'));

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeOk(types, v) {
  const t = typeOf(v);
  return [].concat(types).some((want) => want === t || (want === 'number' && t === 'integer'));
}

/** Every field a schema allows, across allOf/anyOf/oneOf branches. */
function allowedFields(schema) {
  const fields = new Set(Object.keys(schema.properties || {}));
  for (const k of ['allOf', 'anyOf', 'oneOf']) for (const s of schema[k] || []) allowedFields(s).forEach((f) => fields.add(f));
  return fields;
}

function isOpenObject(schema) {
  // An object the spec doesn't describe field by field (Money values, co_hosts…) may hold anything.
  return !allowedFields(schema).size;
}

/**
 * Errors for value against schema. Within one object, a field is unknown when
 * no branch of the schema (allOf, anyOf, oneOf) lists it.
 */
export function validate(schema, value, path = '$', errors = [], strict = true) {
  if (!schema || typeof schema !== 'object') return errors;
  for (const s of schema.allOf || []) validate(s, value, path, errors, false);
  for (const k of ['anyOf', 'oneOf']) {
    if (schema[k] && !schema[k].some((s) => validate(s, value, path, [], false).length === 0)) {
      errors.push(`${path}: matches none of the ${k} branches`);
    }
  }
  if (schema.type && !typeOk(schema.type, value) && !(schema.nullable && value === null)) {
    errors.push(`${path}: expected ${[].concat(schema.type).join('|')}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (typeOf(value) === 'object') {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${path}: missing required field "${r}"`);
    if (strict && !isOpenObject(schema)) {
      const allowed = allowedFields(schema);
      for (const k of Object.keys(value)) if (!allowed.has(k)) errors.push(`${path}.${k}: not in the spec`);
    }
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) validate(s, value[k], `${path}.${k}`, errors);
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  return errors;
}
