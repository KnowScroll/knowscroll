import { friendTokenFromLink, friendInviteLink } from './friend-invite-link';

jest.mock('expo-linking', () => ({ createURL: () => 'knowscroll://friends/invite' }));
const token = `ksfi_${'A'.repeat(43)}`;
// Authored capability strings only. No actual link, person or social activity.
it('accepts the exact fragment and rejects capabilities placed in paths, query strings or another route', () => {
  expect(friendTokenFromLink(`https://fixture.test/friends/invite#invite=${token}`)).toBe(token);
  expect(friendTokenFromLink(`knowscroll://friends/invite#invite=${token}`)).toBe(token);
  expect(friendTokenFromLink(`#invite=${token}`)).toBe(token);
  expect(friendTokenFromLink(`https://fixture.test/friends/invite?invite=${token}`)).toBeUndefined();
  expect(friendTokenFromLink(`https://fixture.test/friends/invite/${token}`)).toBeUndefined();
  expect(friendTokenFromLink(`https://fixture.test/redeem#invite=${token}`)).toBeUndefined();
  expect(friendTokenFromLink(`https://user:pass@fixture.test/friends/invite#invite=${token}`)).toBeUndefined();
  expect(friendTokenFromLink(`#invite=${token}&extra=1`)).toBeUndefined();
  expect(friendTokenFromLink(`#invite=${token}\n`)).toBeUndefined();
});
it('builds a native capability link with no token before the fragment', () => {
  const link = friendInviteLink(token)!;
  expect(link).toBe(`knowscroll://friends/invite#invite=${token}`);
  expect(link.split('#')[0]).not.toContain(token);
  expect(friendInviteLink('invalid')).toBeUndefined();
});
