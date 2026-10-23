import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { LINK_LIMITS, OPERATOR_WORLDS, admitLink, operatorAddressMatcher, signInLinkFor } from './policy.js';

const limit = { max: 3, windowSeconds: 900 };

describe('admitLink', () => {
  it('admits until the budget is full inside the window', () => {
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

  test.prop([fc.array(fc.double({ min: 0, max: 899.9, noNaN: true }), { minLength: 3, maxLength: 12 })])(
    'deciding from the newest max ages only gives the same answer as from all of them',
    (ages) => {
      const newest = [...ages].sort((a, b) => a - b).slice(0, limit.max);
      expect(admitLink(newest, limit)).toEqual(admitLink(ages, limit));
    },
  );

  it('uses the published budgets: 3 per address, 60 per domain, 300 world-wide per 15 minutes', () => {
    expect(LINK_LIMITS).toEqual({
      address: { max: 3, windowSeconds: 900 },
      domain: { max: 60, windowSeconds: 900 },
      world: { max: 300, windowSeconds: 900 },
    });
  });
});

describe('operator sign-in policy (review m2, m3)', () => {
  it('allows only dev, stage, ci and local', () => {
    expect(OPERATOR_WORLDS).toEqual(['dev', 'stage', 'ci', 'local']);
  });

  it('matches addresses against the disposable pattern, with a literal domain', () => {
    const testDomain = operatorAddressMatcher('*@test.knowscroll.space');
    expect(testDomain?.('s13-a@test.knowscroll.space')).toBe(true);
    expect(testDomain?.('someone@knowscroll.space')).toBe(false);
    expect(testDomain?.('a@test.knowscroll.space.evil.test')).toBe(false);
    expect(testDomain?.('a@xtest.knowscroll.space')).toBe(false);
    const tagged = operatorAddressMatcher('knowscroll+*@agentmail.to');
    expect(tagged?.('knowscroll+s13a@agentmail.to')).toBe(true);
    expect(tagged?.('knowscroll@agentmail.to')).toBe(false);
    expect(tagged?.('other+x@agentmail.to')).toBe(false);
    expect(tagged?.('xknowscroll+x@agentmail.to')).toBe(false);
  });

  it('refuses patterns that are not a single literal-domain address', () => {
    for (const pattern of [
      '',
      '*',
      '*@*',
      '*@*.test',
      'a@b',
      '*@Test.example.com',
      '**@x.test',
      'a*b*@x.test',
      '*@x.test@y.test',
      'a@',
    ])
      expect(operatorAddressMatcher(pattern), pattern).toBeUndefined();
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
