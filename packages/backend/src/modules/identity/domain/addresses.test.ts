import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { MAX_ADDRESS_LENGTH, maskAddress, normaliseAddress, parseAddress } from './addresses.js';

describe('the accepted email address (RFC 5321 subset, review m4)', () => {
  it('trims and lower-cases one address however it was typed, and splits its domain', () => {
    expect(parseAddress('  Asha.Rao+ks@Example.COM ')).toEqual({
      address: 'asha.rao+ks@example.com',
      local: 'asha.rao+ks',
      domain: 'example.com',
    });
    expect(normaliseAddress("o'brien@xn--bcher-kva.example")).toBe("o'brien@xn--bcher-kva.example");
  });

  it('refuses display names, quoting, separators, whitespace, control, format and non-ASCII characters', () => {
    const refused = [
      '',
      'a',
      '@example.com',
      'asha@',
      'asha@example',
      'a@b@example.com',
      'asha@.com',
      'asha@example..com',
      'asha@-example.com',
      'asha@example.123',
      '.asha@example.com',
      'asha.@example.com',
      'as..ha@example.com',
      'x<attacker@evil.test>',
      'Asha <asha@example.com>',
      'a,b@evil.test',
      '"a";b@evil.test',
      'a b@example.com',
      'a(comment)@example.com',
      'a[1]@example.com',
      'a\\b@example.com',
      'a:b@example.com',
      'nul\u0000@example.com',
      'crlf\r\n@example.com',
      'tab\t@example.com',
      'nel\u0085@example.com',
      'zw​@example.com',
      'bom﻿@example.com',
      'kelvinK@example.com',
      'İstanbul@example.com',
      'café@example.com',
      'asha@exämple.com',
    ];
    for (const input of refused) expect(parseAddress(input), JSON.stringify(input)).toBeUndefined();
  });

  it('enforces the lengths: local part 64, domain labels 63, whole address 254', () => {
    expect(normaliseAddress(`${'a'.repeat(64)}@example.com`)).toBeDefined();
    expect(normaliseAddress(`${'a'.repeat(65)}@example.com`)).toBeUndefined();
    expect(normaliseAddress(`a@${'b'.repeat(63)}.com`)).toBeDefined();
    expect(normaliseAddress(`a@${'b'.repeat(64)}.com`)).toBeUndefined();
    const long = `${'a'.repeat(60)}@${Array.from({ length: 4 }, () => 'b'.repeat(60)).join('.')}.com`;
    expect(long.length).toBeGreaterThan(MAX_ADDRESS_LENGTH);
    expect(normaliseAddress(long)).toBeUndefined();
  });

  test.prop([fc.emailAddress()])('is idempotent, and what it accepts passes the database check', (email) => {
    const once = normaliseAddress(email);
    if (once === undefined) return;
    expect(normaliseAddress(once)).toBe(once);
    expect(once).toBe(once.toLowerCase());
    expect(once.length).toBeLessThanOrEqual(MAX_ADDRESS_LENGTH);
    // migrations/0007: address ~ '^[!-?A-~]+@[a-z0-9.-]+$'
    expect(once).toMatch(/^[!-?A-~]+@[a-z0-9.-]+$/);
  });

  test.prop([fc.string({ maxLength: 80 })])('never accepts anything outside printable ASCII', (input) => {
    const parsed = parseAddress(input);
    if (parsed !== undefined) expect(parsed.address).toMatch(/^[!-~]+$/);
  });
});

describe('maskAddress', () => {
  it('shows the first character and the whole domain', () => {
    expect(maskAddress('meera@example.com')).toBe('m•••@example.com');
    expect(maskAddress('x@test.knowscroll.space')).toBe('x•••@test.knowscroll.space');
  });
});
