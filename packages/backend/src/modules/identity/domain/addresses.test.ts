import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { MAX_ADDRESS_LENGTH, normaliseAddress } from './addresses.js';

describe('normaliseAddress', () => {
  it('trims, lower-cases and NFC-normalises one address however it was typed', () => {
    expect(normaliseAddress('  Asha@Example.COM ')).toBe('asha@example.com');
    expect(normaliseAddress('café@example.com')).toBe('café@example.com');
  });

  it('refuses what is not an address', () => {
    for (const input of [
      '',
      'a',
      '@example.com',
      'asha@',
      'asha@example',
      'a b@example.com',
      'a@b@example.com',
      'asha@.com',
    ])
      expect(normaliseAddress(input), input).toBeUndefined();
    expect(normaliseAddress(`${'a'.repeat(MAX_ADDRESS_LENGTH)}@example.com`)).toBeUndefined();
  });

  test.prop([fc.emailAddress()])('is idempotent and its result matches the database check', (email) => {
    const once = normaliseAddress(email);
    if (once === undefined) return;
    expect(normaliseAddress(once)).toBe(once);
    expect(once).toBe(once.toLowerCase());
    expect(once.length).toBeLessThanOrEqual(MAX_ADDRESS_LENGTH);
    expect(once).toMatch(/^[^@\s]+@[^@\s]+$/);
  });
});
