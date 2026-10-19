import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { ADDRESS_LINK_LIMIT, admitLink, signInLinkFor } from './policy.js';

const limit = { max: 3, windowSeconds: 900 };

describe('admitLink', () => {
  it('admits until the address received the limit inside the window', () => {
    expect(admitLink([], limit)).toEqual({ kind: 'admit' });
    expect(admitLink([10, 400], limit)).toEqual({ kind: 'admit' });
    expect(admitLink([10, 400, 800], limit)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 100 });
    // Links outside the window do not count.
    expect(admitLink([10, 400, 950], limit)).toEqual({ kind: 'admit' });
  });

  test.prop([fc.array(fc.double({ min: 0, max: 899.9, noNaN: true }), { maxLength: 8 })])(
    'waiting the answered time is always enough for one more link',
    (ages) => {
      const admission = admitLink(ages, limit);
      if (admission.kind === 'admit') {
        expect(ages.length).toBeLessThan(limit.max);
        return;
      }
      expect(admission.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(admission.retryAfterSeconds).toBeLessThanOrEqual(limit.windowSeconds);
      const later = ages.map((age) => age + admission.retryAfterSeconds);
      expect(admitLink(later, limit)).toEqual({ kind: 'admit' });
    },
  );

  it('uses the published limit of three links per fifteen minutes', () => {
    expect(ADDRESS_LINK_LIMIT).toEqual({ max: 3, windowSeconds: 900 });
  });
});

describe('signInLinkFor', () => {
  it('puts the token in the fragment of the redeem page, never in the path or query', () => {
    const link = new URL(signInLinkFor('https://app.dev.knowscroll.space', 'ksl_token'));
    expect(link.origin).toBe('https://app.dev.knowscroll.space');
    expect(link.pathname).toBe('/redeem');
    expect(link.search).toBe('');
    expect(link.hash).toBe('#token=ksl_token');
  });
});
