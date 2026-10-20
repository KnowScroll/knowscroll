import { describe, expect, it } from 'vitest';
import { redactProviderText, redactRecorded, sha256Hex } from './recording.js';

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

  it('hashes request bytes as lowercase hex SHA-256', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
