import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { canonicalJson, requestHash, type CanonicalJson } from './canonical.js';

const json: fc.Arbitrary<CanonicalJson> = fc.letrec<{ value: CanonicalJson }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 6 }), tie('value'), { maxKeys: 5 }),
  ),
})).value;

/** The same object with its keys inserted in reverse order, at every level. */
function reverseKeys(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) return (value as readonly CanonicalJson[]).map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, CanonicalJson>).reverse();
    return Object.fromEntries(entries.map(([key, inner]) => [key, reverseKeys(inner)]));
  }
  return value;
}

describe('canonical request hashing', () => {
  test.prop([json])('property order never changes the canonical form or the hash', (value) => {
    expect(canonicalJson(reverseKeys(value))).toBe(canonicalJson(value));
    expect(requestHash('experience.apply-action', reverseKeys(value))).toBe(
      requestHash('experience.apply-action', value),
    );
  });

  test.prop([json])('canonical form is valid JSON that parses back to an equal value', (value) => {
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  test.prop([json, json])('different values hash differently', (a, b) => {
    fc.pre(canonicalJson(a) !== canonicalJson(b));
    expect(requestHash('op.x', a)).not.toBe(requestHash('op.x', b));
  });

  test.prop([json])('the operation is part of the hash', (value) => {
    expect(requestHash('experience.apply-action', value)).not.toBe(requestHash('experience.other', value));
  });
});
