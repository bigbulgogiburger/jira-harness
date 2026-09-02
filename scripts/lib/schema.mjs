// schema.mjs — 외부 의존성 없는 최소 JSON Schema 검증기 + 플러그인 스키마 로더.
// 지원 부분집합: type(문자열|배열) · properties · required · additionalProperties(boolean|schema) · items · enum · pattern · minimum · maximum · $ref(#/$defs/…)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = join(HERE, '..', '..', 'schemas');

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`지원하지 않는 $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => (o == null ? undefined : o[k]), root);
}

/** @returns {string[]} 오류 목록(빈 배열 = 유효) */
export function validate(value, schema, root = schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.$ref) return validate(value, resolveRef(schema.$ref, root), root, path);

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.some(t => typeMatches(t, actual))) {
      errors.push(`${path}: 타입 ${actual} — 허용 ${allowed.join('|')}`);
      return errors;
    }
  }
  if (value === null) return errors;

  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 값 ${JSON.stringify(value)} — 허용 ${schema.enum.join('|')}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 패턴 불일치 /${schema.pattern}/`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: ${value} < 최소 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: ${value} > 최대 ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: 필수 키 누락 "${key}"`);
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (key in props) errors.push(...validate(v, props[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: 허용되지 않는 키 "${key}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(v, schema.additionalProperties, root, `${path}.${key}`));
    }
  }
  return errors;
}

export function assertValid(value, schemaName, label = schemaName) {
  const errors = validate(value, loadSchema(schemaName));
  if (errors.length) {
    const err = new Error(`${label} 스키마 위반 ${errors.length}건:\n  - ${errors.join('\n  - ')}`);
    err.errors = errors;
    throw err;
  }
  return value;
}
