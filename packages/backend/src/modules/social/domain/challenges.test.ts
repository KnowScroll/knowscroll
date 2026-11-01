import { describe, expect, it } from 'vitest';
import { viewChallenge } from './challenges.js';

const me = 'account-me';
const friend = 'account-friend';

describe('a challenge as one person may see it', () => {
  it('is open until the reader has locked, whatever the friend did', () => {
    expect(viewChallenge(me, [])).toEqual({ stage: 'open' });
    expect(viewChallenge(me, [{ accountId: friend, option: 2 }])).toEqual({ stage: 'open' });
  });

  it('shows the reader only their own pick until the friend has locked', () => {
    expect(viewChallenge(me, [{ accountId: me, option: 1 }])).toEqual({ stage: 'locked', option: 1 });
  });

  it('reveals both picks once both have locked, from either side', () => {
    const picks = [
      { accountId: me, option: 0 },
      { accountId: friend, option: 2 },
    ];
    expect(viewChallenge(me, picks)).toEqual({ stage: 'revealed', option: 0, theirs: 2 });
    expect(viewChallenge(friend, picks)).toEqual({ stage: 'revealed', option: 2, theirs: 0 });
  });

  it('carries no pick of the friend while the reader is open or locked', () => {
    const friendOnly = viewChallenge(me, [{ accountId: friend, option: 1 }]);
    expect(JSON.stringify(friendOnly)).not.toContain('theirs');
    const ownOnly = viewChallenge(me, [{ accountId: me, option: 1 }]);
    expect(JSON.stringify(ownOnly)).not.toContain('theirs');
  });
});
