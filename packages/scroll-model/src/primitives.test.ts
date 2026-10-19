import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, sha256Hex, utf8ByteLength } from './index.js';
import { mentionsWebAddress, plainText } from './primitives.js';
import { countWords, sentenceRanges, splitsSurrogatePair, truncateText } from './text.js';

/** Strings over any UTF-16 code unit, lone surrogates included. */
const anyUnits = fc.string({
  unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
  maxLength: 300,
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000))).toBe(createHash('sha256').update('a'.repeat(1_000), 'utf8').digest('hex'));
  });

  it('equals Node’s SHA-256 of the UTF-8 encoding for any string, lone surrogates included', () => {
    fc.assert(
      fc.property(fc.oneof(anyUnits, fc.string({ unit: 'grapheme', maxLength: 200 })), (text) => {
        expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
      { numRuns: 300 },
    );
  });
});

describe('utf8ByteLength', () => {
  it('equals Buffer.byteLength for any string', () => {
    fc.assert(
      fc.property(anyUnits, (text) => {
        expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
      }),
    );
  });
});

describe('canonicalJson', () => {
  const json = fc.jsonValue({ maxDepth: 3 });

  it('does not depend on key order and parses back to the same value', () => {
    fc.assert(
      fc.property(json, (value) => {
        const reversed = JSON.parse(JSON.stringify(value), (_key, member: unknown) =>
          member !== null && typeof member === 'object' && !Array.isArray(member)
            ? Object.fromEntries(Object.entries(member).reverse())
            : member,
        ) as unknown;
        expect(canonicalJson(reversed)).toBe(canonicalJson(value));
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
        expect(canonicalSha256(reversed)).toBe(canonicalSha256(value));
      }),
    );
  });

  it('omits undefined members and refuses values that are not JSON', () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [true, null] })).toBe('{"b":1,"c":[true,null]}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });
});

describe('plain text', () => {
  const schema = plainText(1, 200);

  it('accepts trimmed NFC single-line text', () => {
    expect(schema.safeParse('Twice a month the Sun helps.').success).toBe(true);
    expect(schema.safeParse('Café \u{1F30D} “it”').success).toBe(true);
  });

  it('refuses untrimmed, non-NFC, multi-line and control-character text', () => {
    for (const text of [' leading', 'trailing ', 'two\nlines', 'tab\there', 'line separator', 'Café', 'bell\u0007']) {
      expect(schema.safeParse(text).success, text).toBe(false);
    }
  });

  it('refuses web addresses and host names (readers never see sources)', () => {
    for (const text of [
      'see https://example.org',
      'www.example',
      'read science.nasa.gov today',
      'mailto:someone',
      'ftp://host',
    ]) {
      expect(mentionsWebAddress(text), text).toBe(true);
      expect(schema.safeParse(text).success, text).toBe(false);
    }
    for (const text of ['U.S. and U.K.', 'e.g. this', 'Node.js', '1.46 times', 'np.exp is not a host']) {
      expect(mentionsWebAddress(text), text).toBe(false);
    }
  });
});

describe('text helpers', () => {
  it('splits sentences at terminal punctuation followed by space, keeping decimals inside', () => {
    const text = 'About 1.46 times. Twice as big! Why?\nNext line';
    expect(sentenceRanges(text).map(([start, end]) => text.slice(start, end))).toEqual([
      'About 1.46 times.',
      'Twice as big!',
      'Why?',
      'Next line',
    ]);
  });

  it('covers every non-space character of a text with its sentence ranges', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const covered = new Set<number>();
        for (const [start, end] of sentenceRanges(text))
          for (let index = start; index < end; index += 1) covered.add(index);
        for (let index = 0; index < text.length; index += 1) {
          if (!/\s/u.test(text.charAt(index))) expect(covered.has(index)).toBe(true);
        }
      }),
    );
  });

  it('truncates at a word boundary without splitting a surrogate pair', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), fc.integer({ min: 2, max: 200 }), (text, max) => {
        const out = truncateText(text, max);
        if (text.length <= max) expect(out).toBe(text);
        else {
          expect(out.length).toBeLessThanOrEqual(max);
          expect(out.endsWith('…')).toBe(true);
          const kept = out.slice(0, -1);
          expect(text.startsWith(kept)).toBe(true);
          expect(splitsSurrogatePair(text, kept.length)).toBe(false);
        }
      }),
    );
  });

  it('counts whitespace-separated words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  one two\nthree  ')).toBe(3);
  });
});
