import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
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

  it('orders keys by Unicode code point, not UTF-16 code unit', () => {
    // U+1F600 is above U+FFFF, although its first UTF-16 unit (0xD83D) sorts below 0xFFFF.
    expect(canonicalJson({ '\u{1F600}': 1, '\uFFFF': 2 })).toBe('{"\uFFFF":2,"\u{1F600}":1}');
  });

  it('keeps null distinct from an absent or undefined member, and keeps array order', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}));
    expect(requestHash('op.x', [1, 2])).not.toBe(requestHash('op.x', [2, 1]));
    expect(requestHash('op.x', { a: '1' })).not.toBe(requestHash('op.x', { a: 1 }));
  });

  it('refuses values that are not plain JSON data', () => {
    expect(() => canonicalJson({ at: new Date(0) } as unknown as CanonicalJson)).toThrow(TypeError);
    expect(() => canonicalJson(new Map([['a', 1]]) as unknown as CanonicalJson)).toThrow(TypeError);
    class Command {
      readonly kind = 'save';
    }
    expect(() => canonicalJson(new Command() as unknown as CanonicalJson)).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});
