import { describe, expect, it } from 'vitest';
import { mediaGrants } from './media-grants.js';
import type { Caller } from './callers.js';
const caller: Caller = {
  accountId: '20000000-0000-4000-8000-000000000001',
  universeId: '20000000-0000-4000-8000-000000000002',
  privacyEpoch: 1,
  sessionId: 'session-fixture',
  credential: 'cookie',
};
const exposure = '20000000-0000-4000-8000-000000000003';
describe('short-lived playback grants', () => {
  it('binds audience, session, account, universe, epoch, expiry and exact signed bytes', () => {
    let now = 100000;
    const grants = mediaGrants('world:ci', () => now);
    const grant = grants.mint(caller, exposure, 'a'.repeat(64));
    expect(grants.verify(grant.token, caller)?.exposure).toBe(exposure);
    for (const changed of [
      { sessionId: 'another' },
      { privacyEpoch: 2 },
      { accountId: exposure },
      { universeId: exposure },
    ])
      expect(grants.verify(grant.token, { ...caller, ...changed })).toBeUndefined();
    expect(mediaGrants('world:stage', () => now).verify(grant.token, caller)).toBeUndefined();
    expect(grants.verify(`${grant.token}x`, caller)).toBeUndefined();
    expect(grants.verify('credential-canary.bad', caller)).toBeUndefined();
    now += 60000;
    expect(grants.verify(grant.token, caller)).toBeUndefined();
  });
});
