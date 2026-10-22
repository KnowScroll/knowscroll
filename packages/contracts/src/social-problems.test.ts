import { describe, expect, it } from 'vitest';
import { SocialProblemSchema } from './social-problems.js';
import { problemDetails } from './problems.js';

describe('closed Social private problem documents', () => {
  it.each([
    'SHARING_UNAVAILABLE',
    'SHARING_REVISION_STALE',
    'COMMAND_KEY_REUSED',
    'UNAUTHENTICATED',
    'SCOPE_MISMATCH',
  ] as const)('accepts fixed catalogue %s with only fixed bounded issue tokens', (code) => {
    const value = problemDetails(code, { issues: [{ path: ['body', 'unknown'], code: 'invalid_type' }] });
    expect(SocialProblemSchema.parse(value)).toEqual(value);
    expect(SocialProblemSchema.safeParse({ ...value, status: 418 }).success).toBe(false);
    expect(SocialProblemSchema.safeParse({ ...value, title: 'A peer secretly blocked you' }).success).toBe(false);
  });
  it('rejects raw bodies, capabilities, dynamic paths, positions, private reasons and transport wrappers', () => {
    const value = problemDetails('SHARING_UNAVAILABLE');
    for (const extra of [
      { detail: 'private message' },
      { instance: '/s/private-token' },
      { token: 'secret' },
      { reason: 'blocked' },
      { sender: 'A friend' },
      { counts: 1 },
      { defined: true },
    ])
      expect(SocialProblemSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    for (const path of [['token', 0], ['private-body-value'], Array(9).fill('body')])
      expect(SocialProblemSchema.safeParse({ ...value, issues: [{ path, code: 'invalid_type' }] }).success).toBe(false);
    expect(
      SocialProblemSchema.safeParse({ ...value, issues: [{ path: ['body'], code: 'private-message-value' }] }).success,
    ).toBe(false);
    expect(
      SocialProblemSchema.safeParse({ ...value, issues: Array(33).fill({ path: [], code: 'custom' }) }).success,
    ).toBe(false);
    expect(SocialProblemSchema.safeParse(problemDetails('ASSET_NOT_FOUND')).success).toBe(false);
  });
});
