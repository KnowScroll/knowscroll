import { describe, expect, it } from 'vitest';
import { savedCursors, SAVED_CURSOR_TTL_MS } from './saved-cursors.js';
const id = '0199a000-0000-7000-8000-000000000001',
  other = '0199a000-0000-7000-8000-000000000002';
const binding = { accountId: id, universeId: other, privacyEpoch: 3, filter: 'all' as const, limit: 20 };
const after = { assetId: id, savedAt: '2026-10-22T10:00:00.123456Z' };
describe('private per-instance Saved AEAD cursors (synthetic claims)', () => {
  it('round-trips exact microseconds confidentially with fresh randomized authenticated bytes', () => {
    const codec = savedCursors('ci:fixture', () => 1000),
      first = codec.mint(binding, after),
      second = codec.mint(binding, after);
    expect(first).not.toBe(second);
    expect(codec.read(binding, first)).toEqual(after);
    const bytes = Buffer.from(first.slice(5), 'base64url').toString('utf8');
    for (const secret of [id, other, after.savedAt, 'saved-page.v1', 'accountId']) expect(bytes).not.toContain(secret);
    expect(codec.read({ ...binding, accountId: id.toUpperCase() }, first)).toEqual(after);
  });
  it('rejects every scope/filter/limit binding and another instance/world without disclosing why', () => {
    const codec = savedCursors('ci', () => 1000),
      token = codec.mint(binding, after);
    for (const change of [
      { accountId: other },
      { universeId: id },
      { privacyEpoch: 4 },
      { filter: 'reel' as const },
      { limit: 21 },
    ])
      expect(codec.read({ ...binding, ...change }, token)).toBeUndefined();
    expect(savedCursors('ci', () => 1000).read(binding, token)).toBeUndefined();
    expect(savedCursors('stage', () => 1000).read(binding, token)).toBeUndefined();
  });
  it('expires at the real boundary and refuses a future issued claim after clock rollback', () => {
    let time = 1000;
    const codec = savedCursors('ci', () => time),
      token = codec.mint(binding, after);
    time += SAVED_CURSOR_TTL_MS - 1;
    expect(codec.read(binding, token)).toEqual(after);
    time++;
    expect(codec.read(binding, token)).toBeUndefined();
    time = 999;
    expect(codec.read(binding, token)).toBeUndefined();
  });
  it('authenticates IV, ciphertext and tag and uniformly refuses bounded malformed encodings', () => {
    const codec = savedCursors('ci', () => 1000),
      token = codec.mint(binding, after),
      bytes = Buffer.from(token.slice(5), 'base64url');
    for (const offset of [0, 12, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const bad = Buffer.from(bytes);
      bad[offset] = bad[offset]! ^ 1;
      expect(codec.read(binding, `ksp1_${bad.toString('base64url')}`)).toBeUndefined();
    }
    for (const bad of ['', token + '=', 'ksfi_' + token.slice(5), `ksp1_${'a'.repeat(1025)}`, `ksp1_${'a'.repeat(43)}`])
      expect(codec.read(binding, bad)).toBeUndefined();
  });
});
