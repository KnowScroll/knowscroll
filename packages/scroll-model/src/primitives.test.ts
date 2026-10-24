import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, sha256Hex, utf8ByteLength } from './index.js';
import { codeText, mentionsWebAddress, plainText, spanText } from './primitives.js';
import { fastestMs } from './test-support/timing.js';
import { FIELD_LIMITS } from './limits.js';
import { z } from './zod.js';
import {
  Span,
  richText,
  copiedRuns,
  countWords,
  isGraphemeBoundary,
  isUnitExponent,
  numericTokens,
  sentenceRanges,
  splitsSurrogatePair,
  truncateText,
} from './text.js';

/** Strings over any UTF-16 code unit, lone surrogates included. */
const anyUnits = fc.string({
  unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
  maxLength: 300,
});

describe('RichText fixed refinement metadata', () => {
  it('identifies combined-length overflow without changing the limit or original issue message', () => {
    const schema = richText(10);
    const exact = [{ text: 'abcde' }, { text: 'fghij' }];
    expect(schema.parse(exact)).toEqual(exact);
    const result = schema.safeParse([{ text: 'abcde' }, { text: 'fghijk' }]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected authored over-limit fixture to be refused');
    expect(result.error.issues).toEqual([
      { code: 'custom', path: [], message: 'text_too_long', params: { safeCode: 'rich_text_too_long' } },
    ]);
  });

  it.each([' leading', 'trailing ', ' '])('identifies whole-text trimming for %j without normalizing it', (text) => {
    const result = richText(20).safeParse([{ text }]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected authored untrimmed fixture to be refused');
    expect(result.error.issues).toEqual([
      { code: 'custom', path: [], message: 'text_not_plain', params: { safeCode: 'rich_text_not_trimmed' } },
    ]);
  });

  it('preserves golden accepted values, including meaningful spaces between differently marked spans', () => {
    for (const spans of [
      [{ text: 'Exact text.' }],
      [{ text: 'A ' }, { text: 'marked', marks: ['strong'] }, { text: ' phrase.' }],
      [{ text: 'Café 🌍' }],
    ])
      expect(richText(40).parse(spans)).toEqual(spans);
  });

  it('keeps malformed shapes and existing span-level refusals outside the new aggregate codes', () => {
    for (const value of [
      null,
      'text',
      { text: 'text' },
      [{ text: 'two\nlines' }],
      [{ text: 'Cafe\u0301' }],
      [{ text: 'https://fixture.invalid' }],
    ]) {
      const result = richText(100).safeParse(value);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected authored invalid fixture to be refused');
      expect(result.error.issues).not.toEqual([]);
      for (const issue of result.error.issues) expect(issue).not.toHaveProperty('params.safeCode');
    }
  });

  it('leaves the advisory input schema identical to the existing structural array shape', () => {
    // Native schema conversion omits semantic refinements; fixed diagnostic params add no wire vocabulary.
    const options = {
      target: 'draft-07' as const,
      io: 'input' as const,
      unrepresentable: 'throw' as const,
      cycles: 'throw' as const,
      reused: 'ref' as const,
    };
    const current = z.toJSONSchema(z.strictObject({ spans: richText(10) }), options);
    const structural = z.toJSONSchema(
      z.strictObject({ spans: z.array(Span).min(1).max(FIELD_LIMITS.spansPerText) }),
      options,
    );
    expect(current).toEqual(structural);
    expect(JSON.stringify(current)).not.toContain('safeCode');
    expect(JSON.stringify(current)).not.toContain('rich_text_');
  });
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

  it('refuses untrimmed, non-NFC, multi-line and control-character text, and lone surrogates', () => {
    for (const text of [
      ' leading',
      'trailing ',
      'two\nlines',
      'tab\there',
      'line\u2028separator',
      'Cafe\u0301',
      'bell\u0007',
      'lone \ud800 high',
      'lone \udc00 low',
      'reversed \udc00\ud800 pair',
    ]) {
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

describe('web address detection is linear (re-review of #254, MA-1)', () => {
  it('finds the same addresses as before, and the host names with an underscore too', () => {
    for (const text of [
      'http://x',
      'HTTPS://EXAMPLE.ORG',
      'a+b.c-d://e',
      'Visit WWW.example now',
      'MAILTO:someone',
      'a.com',
      'x-y.example.NET',
      'science.nasa.gov',
      'see 1.2.in the text',
      'sub.domain.co.uk/page',
      'my_site.com',
      'wwwx.com is not www.',
    ]) {
      expect(mentionsWebAddress(text), text).toBe(true);
    }
    for (const text of [
      'plain words, and a. b. c.',
      'a..com',
      '.com',
      '-.com',
      'version 1.2.3',
      'the community',
      'ratio 3:4 or 12://',
      'np.linalg.norm',
      'com.example.package',
    ]) {
      expect(mentionsWebAddress(text), text).toBe(false);
    }
  });

  it('scans in time linear in the text: a long dotted or hyphenated string costs milliseconds', () => {
    for (const unit of ['a.', 'a-b-', 'abc.def.', '1.2.', 'A.b-C.', 'np.linalg.norm.']) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      expect(
        fastestMs(() => mentionsWebAddress(text), 3),
        unit,
      ).toBeLessThan(50);
    }
  });

  it('runs no scan on text over its length cap: the cap is the only refusal', () => {
    // Text that would also fail every other check: a web address, a control character, not NFC.
    const hostile = `${'a.com\u0007 Cafe\u0301 '.repeat(100)}end`;
    for (const [schema, name] of [
      [plainText(1, 50), 'plainText'],
      [spanText(50), 'spanText'],
      [codeText(50), 'codeText'],
    ] as const) {
      const result = schema.safeParse(hostile);
      expect(result.success, name).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.code),
        name,
      ).toEqual(['too_big']);
      // Within the cap the same text is refused for what it is.
      const within = schema.safeParse(hostile.slice(0, 30)).error?.issues.map((issue) => issue.code);
      expect(within, name).toContain('custom');
      expect(within, name).not.toContain('too_big');
    }
  });

  it('costs milliseconds on a long over-limit field of every text kind', () => {
    const long = 'a.'.repeat(60_000);
    for (const [schema, name] of [
      [plainText(1, 90), 'plainText'],
      [spanText(1_200), 'spanText'],
      [codeText(4_000), 'codeText'],
    ] as const) {
      expect(
        fastestMs(() => schema.safeParse(long), 3),
        name,
      ).toBeLessThan(50);
    }
  });
});

describe('sentence breaks (re-review of #254, MA-2)', () => {
  const sentences = (text: string) => sentenceRanges(text).map(([start, end]) => text.slice(start, end));

  it('ends a sentence at a terminator followed by closing quotes and brackets', () => {
    expect(sentences('Venus spins once in 243 days (a very slow turn.) Mercury needs 59 days.')).toEqual([
      'Venus spins once in 243 days (a very slow turn.)',
      'Mercury needs 59 days.',
    ]);
    expect(sentences('He said "it is slow." Mercury needs 59 days.')).toEqual([
      'He said "it is slow."',
      'Mercury needs 59 days.',
    ]);
    expect(sentences('She said “it is slow.” Mercury needs 59 days.')).toEqual([
      'She said “it is slow.”',
      'Mercury needs 59 days.',
    ]);
    expect(sentences('Really?! Yes. [See below.] «Done.» Next')).toEqual([
      'Really?!',
      'Yes.',
      '[See below.]',
      '«Done.»',
      'Next',
    ]);
  });

  it('ends a sentence at an ellipsis and at full-width and CJK terminators', () => {
    expect(sentences('Venus spins once in 243 days… Mercury needs 59 days.')).toEqual([
      'Venus spins once in 243 days…',
      'Mercury needs 59 days.',
    ]);
    expect(sentences('金星は243日で自転する。水星は59日です。')).toEqual([
      '金星は243日で自転する。',
      '水星は59日です。',
    ]);
    expect(sentences('本当ですか？はい！次です')).toEqual(['本当ですか？', 'はい！', '次です']);
  });

  it('ends a sentence at a period directly followed by a capital letter or a digit', () => {
    expect(sentences('Venus spins once in 243 days.Mercury needs 59 days.')).toEqual([
      'Venus spins once in 243 days.',
      'Mercury needs 59 days.',
    ]);
    expect(sentences('Venus spins once in 243 days.59 more follow.')).toEqual([
      'Venus spins once in 243 days.',
      '59 more follow.',
    ]);
    expect(sentences('It ended."Then it began.')).toEqual(['It ended."', 'Then it began.']);
  });

  it('keeps decimals, versions, names and abbreviations inside a sentence', () => {
    for (const text of [
      'About 1.46 times as heavy',
      'Version 2.0.1 shipped',
      'It computes np.exp of the score',
      'Use Node.js for this',
      'Pi is 3.14159 or so... and then more',
    ]) {
      const parts = sentences(text);
      // Only the ellipsis "... and" (a space after it) may split.
      expect(parts.join(' ').replace(/\s+/gu, ' ')).toBe(text);
      if (!text.includes('...')) expect(parts, text).toEqual([text]);
    }
  });

  it('splits an abbreviation written with capitals, which only ever asks for another anchor', () => {
    expect(sentences('Ask at the U.S. embassy')).toEqual(['Ask at the U.', 'S.', 'embassy']);
  });

  it('finds the same ranges however the text is chunked: ranges are ordered, disjoint and inside the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        let previousEnd = 0;
        for (const [start, end] of sentenceRanges(text)) {
          expect(start).toBeGreaterThanOrEqual(previousEnd);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(text.length);
          previousEnd = end;
        }
      }),
    );
  });
});

describe('a unit exponent is notation (re-review of #254, minor 7)', () => {
  it('is a superscript attached to the symbol before it, and nothing else', () => {
    const exponent = (text: string) => numericTokens(text).map((token) => isUnitExponent(text, token));
    expect(exponent('m/s²')).toEqual([true]);
    expect(exponent('km²')).toEqual([true]);
    expect(exponent('kg/m³')).toEqual([true]);
    expect(exponent('s⁻¹')).toEqual([true]);
    expect(exponent('10²')).toEqual([false]);
    expect(exponent('m 3')).toEqual([false]);
    expect(exponent('² alone')).toEqual([false]);
    expect(exponent('m ²')).toEqual([false]);
    expect(exponent('⅜ of m²')).toEqual([false, true]);
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

describe('copied runs', () => {
  const source = 'Each lunar month contains two sets of spring tides and two sets of neap tides, as the Moon circles.';

  it('returns the whole stretch that the copy check refuses, in the sources’ own lower-case words', () => {
    const text = 'Notice that each month has Two sets of spring tides, and two sets of neap tides! Then it ends.';
    expect(copiedRuns(text, [source], 9)).toEqual(['two sets of spring tides and two sets of neap tides']);
  });

  it('returns nothing for a run shorter than the limit, and each distinct run once', () => {
    expect(copiedRuns('Two sets of spring tides and two sets', [source], 9)).toEqual([]);
    const twice = `${source} A different thought. ${source}`;
    expect(copiedRuns(twice, [source], 9)).toEqual([source.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '')]);
  });

  it('finds runs from any source and separates runs that do not touch', () => {
    const other = 'Sailors count the seconds between flashes to learn which lighthouse they are approaching.';
    const text = `${other.slice(0, 60)} and then something new, then ${source.slice(0, 66)}.`;
    expect(copiedRuns(text, [source, other], 9)).toHaveLength(2);
  });
});

describe('numeric tokens', () => {
  it('finds digits, decimals, grouped numbers and other Unicode number forms', () => {
    const text = 'About 4,096 words, 1.46 times, ⅜ as hard, distance², year MMXX and Ⅻ.';
    expect(numericTokens(text).map(([start, end]) => text.slice(start, end))).toEqual(['4,096', '1.46', '⅜', '²', 'Ⅻ']);
    expect(numericTokens('No numbers here.')).toEqual([]);
  });
});

describe('grapheme boundaries', () => {
  it('never split a base letter from its combining mark, an emoji sequence or a flag', () => {
    const cases: Array<[string, number]> = [
      ['q\u0307x', 1],
      ['\u{1F469}\u200d\u{1F4BB}', 2],
      ['\u{1F469}\u200d\u{1F4BB}', 3],
      ['\u{1F1EC}\u{1F1E7}', 2],
      ['a\u{1F30D}b', 2],
    ];
    for (const [text, offset] of cases) expect(isGraphemeBoundary(text, offset), `${text}@${offset}`).toBe(false);
    expect(isGraphemeBoundary('q\u0307x', 2)).toBe(true);
    expect(isGraphemeBoundary('abc', 0)).toBe(true);
    expect(isGraphemeBoundary('abc', 3)).toBe(true);
    expect(isGraphemeBoundary('abc', 4)).toBe(false);
  });
});
