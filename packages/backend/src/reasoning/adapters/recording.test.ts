import { describe, expect, it } from 'vitest';
import { MAX_REDACTION_DEPTH, REDACTED_TOO_DEEP, redactProviderText, redactRecorded, sha256Hex } from './recording.js';

/** Every credential below is a fixture. */
const presigned =
  'https://bucket.oss-cn.aliyuncs.com/sub/word.json?OSSAccessKeyId=LTAI&Expires=1700000000&Signature=canary-sig-Qw3';

describe('the recording boundary for provider-returned values', () => {
  it('drops a presigned URL’s query string and keeps its host and path', () => {
    expect(redactProviderText(`subtitles at ${presigned} ready`)).toBe(
      'subtitles at https://bucket.oss-cn.aliyuncs.com/sub/word.json ready',
    );
  });

  it('keeps ordinary URLs and prose unchanged', () => {
    const text = 'See https://en.wikipedia.org/wiki/Lantern?lang=en for more about lanterns.';
    expect(redactProviderText(text)).toBe(text);
  });

  it('masks key- and token-shaped values', () => {
    const text =
      'key sk-cp-canaryKEY0123456789abcdef jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2ln Bearer canary.token.value';
    const redacted = redactProviderText(text);
    expect(redacted).not.toContain('canaryKEY');
    expect(redacted).not.toContain('eyJzdWIi');
    expect(redacted).not.toContain('canary.token.value');
  });

  it('cleans every string in a nested object, keys included, without touching other values', () => {
    const value = {
      ok: true,
      count: 3,
      links: [presigned, { nested: `token sk-cp-canaryKEY0123456789abcdef` }],
      [`${presigned}`]: null,
    };
    const redacted = redactRecorded(value);
    expect(JSON.stringify(redacted)).not.toContain('canary');
    expect(redacted).toMatchObject({ ok: true, count: 3 });
  });

  it('keeps a JSON `__proto__` key as data, never as a prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": true}') as Record<string, unknown>;
    const redacted = redactRecorded(parsed);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(redacted)).toEqual(['__proto__', 'ok']);
  });

  it('cleans other URL schemes and scheme-less references, not only http(s)', () => {
    const signed = 'Expires=1700000000&Signature=canary-sig-Qw3';
    for (const url of [
      `s3://bucket/key.json?${signed}`,
      `oss://bucket/key.json?${signed}`,
      `gs://bucket/key.json?${signed}`,
      `//cdn.example.com/key.json?${signed}`,
    ]) {
      const cleaned = redactProviderText(`fetch ${url} now`);
      expect(cleaned).not.toContain('canary-sig');
      expect(cleaned).toMatch(/^fetch (?:s3:|oss:|gs:)?\/\/(?:bucket|cdn\.example\.com)\/key\.json now$/);
    }
    // Prose with a double slash is not a URL.
    expect(redactProviderText('either/or and a//b')).toBe('either/or and a//b');
  });

  it('hashes request bytes as lowercase hex SHA-256', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

/** A fake presigned URL and a fake key: fixtures only. */
const deepSignature = 'canary-deep-signature-Zq81';
const deepKey = 'sk-cp-DEEPcanaryKEYdeepcanaryKEY0000';
const deepLeaf = `see https://oss.example/f.json?Expires=1&Signature=${deepSignature} and ${deepKey}`;
/** `levels` containers around a leaf container, built iteratively (a hostile depth must not need recursion). */
function around(levels: number, shape: 'object' | 'array'): Record<string, unknown> {
  let inner: unknown =
    shape === 'object' ? { leaf: deepLeaf, [`https://oss.example/k?Signature=${deepSignature}`]: 1 } : [deepLeaf];
  for (let level = 0; level < levels; level += 1) inner = shape === 'object' ? { n: inner } : [inner];
  return { ok: true, extra: inner };
}
/** Whether any string, key or value, appears anywhere in `value` (iterative). */
function contains(value: unknown, needle: string): boolean {
  const stack: unknown[] = [value];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === 'string') {
      if (item.includes(needle)) return true;
    } else if (typeof item === 'object' && item !== null) {
      if (!Array.isArray(item) && Object.keys(item).some((key) => key.includes(needle))) return true;
      const children: unknown[] = Array.isArray(item) ? item : Object.values(item);
      for (const child of children) stack.push(child);
    }
  }
  return false;
}

describe('the recording boundary at every depth (review B1)', () => {
  it.each([5, 29, 30, 31, 32, 33, 40, 62])(
    'cleans a URL, a key and a URL-shaped key %i levels deep (objects and arrays)',
    (levels) => {
      for (const shape of ['object', 'array'] as const) {
        const redacted = redactRecorded(around(levels, shape));
        expect(contains(redacted, deepSignature), `${shape} ${levels}`).toBe(false);
        expect(contains(redacted, 'DEEPcanaryKEY'), `${shape} ${levels}`).toBe(false);
        expect(contains(redacted, 'https://oss.example/f.json'), `${shape} ${levels}`).toBe(true);
      }
    },
  );

  it.each([MAX_REDACTION_DEPTH + 5, 1_000, 20_000])(
    'replaces everything nested %i levels deep instead of passing it through',
    (levels) => {
      for (const shape of ['object', 'array'] as const) {
        const redacted = redactRecorded(around(levels, shape));
        expect(contains(redacted, deepSignature), `${shape} ${levels}`).toBe(false);
        expect(contains(redacted, 'DEEPcanaryKEY'), `${shape} ${levels}`).toBe(false);
        expect(contains(redacted, REDACTED_TOO_DEEP), `${shape} ${levels}`).toBe(true);
      }
    },
  );

  it('keeps ordinary values at depth', () => {
    expect(redactRecorded({ a: { b: [1, true, null, 'plain'] } })).toEqual({ a: { b: [1, true, null, 'plain'] } });
  });
});
