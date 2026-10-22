import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import {
  friendTokenFromLink,
  friendInviteLink,
  discardInitialNativeFriendLink,
  takeBrowserFriendToken,
} from './friend-invite-link';

jest.mock('expo-linking', () => ({
  createURL: () => 'knowscroll://friends/invite',
  getInitialURL: jest.fn(() => Promise.resolve(null)),
}));
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

it('claims native launch once before the asynchronous OS result, never resets or exposes a capability', async () => {
  let release!: (value: string | null) => void;
  jest.mocked(Linking.getInitialURL).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  expect(discardInitialNativeFriendLink()).toBeUndefined();
  expect(discardInitialNativeFriendLink()).toBeUndefined();
  expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
  release(`knowscroll://friends/invite#invite=${token}`);
  await Promise.resolve();
  expect(discardInitialNativeFriendLink()).toBeUndefined();
  expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
});
it('takes and scrubs valid and invalid current browser fragments without retaining either in history', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousOS = Object.getOwnPropertyDescriptor(Platform, 'OS');
  const location = { hash: `#invite=${token}`, pathname: '/friends/invite' };
  const replaceState = jest.fn(() => {
    location.hash = '';
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, history: { replaceState } } });
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    expect(takeBrowserFriendToken()).toBe(token);
    expect(location.hash).toBe('');
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/friends/invite');
    location.hash = '#invite=invalid';
    expect(takeBrowserFriendToken()).toBeUndefined();
    expect(location.hash).toBe('');
    expect(replaceState).toHaveBeenCalledTimes(2);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousOS) Object.defineProperty(Platform, 'OS', previousOS);
  }
});
