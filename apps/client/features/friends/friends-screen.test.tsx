import type * as React from 'react';
import { StrictMode } from 'react';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { FriendsScreen, SignedInFriends } from './friends-screen';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
const mockNativeRemoved = jest.fn();
jest.mock('expo-linking', () => ({
  createURL: () => 'knowscroll://friends/invite',
  getInitialURL: jest.fn(() => Promise.resolve(null)),
  addEventListener: jest.fn(() => ({
    remove: () => {
      mockNativeRemoved();
    },
  })),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
let mockAccountState: AccountScopeState = { status: 'signed_out', reason: 'none' };
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: mockAccountState, manager: { refresh: jest.fn() } }),
  useAccountInitial: () => undefined,
}));
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
// The availability reads have their own tests; here they must not add requests to the call sequences below.
const mockAvailability = jest.fn<'online' | 'recently_active' | undefined, [string]>(() => undefined);
jest.mock('./use-availability', () => ({ useAvailability: () => (personId: string) => mockAvailability(personId) }));

jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const own = { kind: 'person', personId: id(3), handle: 'fixture.own', displayName: 'Own fixture' };
const peer = { kind: 'person', personId: id(4), handle: 'fixture.peer', displayName: 'Peer fixture' };
const token = `ksfi_${'A'.repeat(43)}`;
const secondToken = `ksfi_${'B'.repeat(43)}`;
const thirdPeer = { ...peer, personId: id(9), handle: 'fixture.third', displayName: 'Third fixture' };
const fourthPeer = { ...peer, personId: id(13), handle: 'fixture.fourth', displayName: 'Fourth fixture' };
const fifthPeer = { ...peer, personId: id(14), handle: 'fixture.fifth', displayName: 'Fifth fixture' };
const blockedLater = { state: 'blocked', peer: fourthPeer, pairRevision: 4 };
const sentLater = { state: 'outgoing', peer: fifthPeer, pairRevision: 1, requestId: id(15) };
const secondPeer = { ...peer, personId: id(8), handle: 'fixture.second', displayName: 'Second fixture' };
function fixture(
  options: {
    emptyScan?: boolean;
    /** A request sent, a person blocked, and an invite link that was turned off. */
    waiting?: boolean;
    /** Sent and Blocked each run to a second page. */
    long?: boolean;
    unknownAccept?: boolean;
    invite?: boolean;
    delay?: boolean;
    resolveDelay?: boolean;
    account?: number;
    epoch?: number;
  } = {},
) {
  const wireScope = { accountId: id(options.account ?? 1), privacyEpoch: options.epoch ?? 1 };
  const envelope = { version: 'sharing.v1', scope: wireScope };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let failures = options.unknownAccept ? 1 : 0;
  let linked = false;
  let activeLink = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = createAccountScope({
    account: { ...wireScope, universeId: id((options.account ?? 1) + 1), email: 'fixture@example.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'GET' ? {} : ((await request.json()) as Record<string, unknown>);
      calls.push({ path, body });
      let data: unknown;
      if (path.endsWith('/profile')) data = { ...envelope, status: 'claimed', profileRevision: 1, person: own };
      else if (path.endsWith('/invites'))
        data = {
          ...envelope,
          invite: activeLink
            ? { status: 'active', inviteRevision: 1, linkId: id(7) }
            : options.waiting
              ? { status: 'revoked', inviteRevision: 2, linkId: id(7) }
              : { status: 'none', inviteRevision: 0 },
        };
      else if (path.endsWith('/page')) {
        if (options.delay) await gate;
        data = {
          version: 'friend-pages.v2',
          requestId: body.requestId,
          scope: wireScope,
          filter: body.filter,
          snapshotRevision: 1,
          items:
            options.long && body.filter === 'outgoing'
              ? [body.cursor ? sentLater : { state: 'outgoing', peer: secondPeer, pairRevision: 1, requestId: id(6) }]
              : options.long && body.filter === 'blocked'
                ? [body.cursor ? blockedLater : { state: 'blocked', peer: thirdPeer, pairRevision: 4 }]
                : options.waiting && body.filter === 'outgoing'
                  ? [{ state: 'outgoing', peer: secondPeer, pairRevision: 1, requestId: id(6) }]
                  : options.waiting && body.filter === 'blocked'
                    ? [{ state: 'blocked', peer: thirdPeer, pairRevision: 4 }]
                    : body.filter === 'incoming' && !linked && !options.emptyScan
                      ? [{ state: 'incoming', peer, pairRevision: 1, requestId: id(5) }]
                      : body.cursor
                        ? [{ state: 'friends', peer, pairRevision: 2, availability: { state: 'unknown' } }]
                        : [],
          ...((options.emptyScan && !body.cursor && body.filter === 'friends') ||
          (options.long && !body.cursor && (body.filter === 'outgoing' || body.filter === 'blocked'))
            ? { next: { scope: wireScope, filter: body.filter, snapshotRevision: 1, token: 'fixture_cursor' } }
            : {}),
        };
      } else if (path.endsWith('/unblock')) {
        data = {
          ...envelope,
          commandId: body.commandId,
          recordedAt: '2026-10-23T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'friend.unblock',
          peerPersonId: body.peerPersonId,
          basePairRevision: 4,
          acceptedPairRevision: 5,
        };
      } else if (path.endsWith('/accept')) {
        linked = true;
        if (failures-- > 0) throw new Error('Authored unknown response');
        data = {
          ...envelope,
          commandId: body.commandId,
          recordedAt: '2026-10-23T00:00:00.000Z',
          replayed: true,
          outcome: 'accepted',
          operation: 'friend.accept',
          peerPersonId: body.peerPersonId,
          basePairRevision: 1,
          acceptedPairRevision: 2,
        };
      } else if (path.endsWith('/people/lookup')) {
        data = {
          ...envelope,
          status: 'available',
          person: { ...peer, personId: peer.personId.toUpperCase() },
          pairRevision: 0,
        };
      } else if (path.endsWith('/pairs/read')) {
        data = { ...envelope, status: 'available', pair: { state: 'none', peer, pairRevision: 0 } };
      } else if (path.endsWith('/invites/create')) {
        activeLink = true;
        data = {
          acceptance: {
            ...envelope,
            commandId: body.commandId,
            recordedAt: '2026-10-23T00:00:00.000Z',
            replayed: false,
            outcome: 'accepted',
            operation: 'invite.create',
            linkId: id(7),
            baseInviteRevision: 0,
            acceptedInviteRevision: 1,
          },
          delivery: { status: 'available', token },
        };
      } else if (path.endsWith('/invites/resolve')) {
        if (options.resolveDelay) await gate;
        data = {
          ...envelope,
          status: 'available',
          issuer: body.token === secondToken ? secondPeer : peer,
          pairRevision: 0,
        };
      } else throw new Error('Unexpected fixture route');
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    },
  });
  const tree = (
    <QueryClientProvider client={scope.queryClient}>
      <DisplayProvider value={{ width: 320, textScale: 2, reducedMotion: true }}>
        <SignedInFriends scope={scope} invite={options.invite} />
      </DisplayProvider>
    </QueryClientProvider>
  );
  const entry = (
    <QueryClientProvider client={scope.queryClient}>
      <DisplayProvider value={{ width: 320, textScale: 2, reducedMotion: true }}>
        <FriendsScreen invite />
      </DisplayProvider>
    </QueryClientProvider>
  );
  return { scope, calls, tree, entry, release };
}

/** Native Jest exercising the web branch with an authored same-document location/event port.
 * This is not an actual browser/platform acceptance fixture. */
function browserFixture(initialHash = '') {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousOS = Object.getOwnPropertyDescriptor(Platform, 'OS');
  const listeners = new Set<() => void>();
  const location = { hash: initialHash, pathname: '/friends/invite', origin: 'https://fixture.test' };
  const replaceState = jest.fn((_data: unknown, _title: string, _url: string) => {
    location.hash = '';
  });
  const browser = {
    location,
    history: { replaceState },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.delete(listener);
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  return {
    location,
    replaceState,
    listeners,
    change(hash: string) {
      location.hash = hash;
      for (const listener of [...listeners]) listener();
    },
    restore() {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (previousOS) Object.defineProperty(Platform, 'OS', previousOS);
    },
  };
}

/** What opening Friends reads: the profile, the invite link, then each list's first page. */
const readsOfEveryList = () => [
  '/v1/social/profile',
  '/v1/social/invites',
  '/v1/social/friends/page',
  '/v1/social/requests/page',
  '/v1/social/requests/page',
  '/v1/social/friends/page',
];

/** The Add a friend panel has no roster to wait for: its buttons are enabled once every read has finished. */
const settled = () => waitFor(() => expect(screen.getByRole('button', { name: 'Check invitation' })).toBeEnabled());

// This first native mount owns the process launch fence. No test-only reset/export is introduced.
it('discards native launch once while signed out and never replays it across account/epoch/session/StrictMode mounts', async () => {
  let finishLaunch!: (value: string | null) => void;
  jest.mocked(Linking.getInitialURL).mockReturnValueOnce(
    new Promise((resolve) => {
      finishLaunch = resolve;
    }),
  );
  const a = fixture({ invite: true });
  mockAccountState = { status: 'signed_out', reason: 'none' };
  let view = await render(a.entry);
  await screen.findByText('Sign in to manage friends');
  expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
  await view.unmount();
  mockAccountState = { status: 'signed_in', scope: a.scope };
  view = await render(a.tree);
  await settled();
  await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
  expect(a.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
  let late = jest.mocked(Linking.addEventListener).mock.calls.at(-1)![1];
  await view.unmount();
  a.scope.end();
  for (const [index, epoch] of [
    [20, 1],
    [20, 2],
    [20, 2],
  ] as const) {
    const h = fixture({ invite: true, account: index, epoch });
    mockAccountState = { status: 'signed_in', scope: h.scope };
    view = await render(<StrictMode>{h.tree}</StrictMode>);
    let beforeCleanup: number;
    try {
      await settled();
      await act(async () => {
        finishLaunch(`knowscroll://friends/invite#invite=${token}`);
        late({ url: `knowscroll://friends/invite#invite=${token}` });
        await Promise.resolve();
      });
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
      expect(screen.queryByRole('button', { name: 'Send invite to Peer fixture' })).toBeNull();
      expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
      const current = jest.mocked(Linking.addEventListener).mock.calls.at(-1)![1];
      await act(() => current({ url: `knowscroll://friends/invite#invite=${secondToken}` }));
      expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      await screen.findByRole('button', { name: 'Send invite to Second fixture' });
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve')).map((c) => c.body.token)).toEqual([
        secondToken,
      ]);
      expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
      late = current;
      await act(() => h.scope.end());
      await act(() => current({ url: `knowscroll://friends/invite#invite=${token}` }));
      await screen.findByText('Friends session ended');
      expect(screen.queryByText('Peer fixture')).toBeNull();
    } finally {
      beforeCleanup = mockNativeRemoved.mock.calls.length;
      await view.unmount();
      h.scope.end();
    }
    expect(mockNativeRemoved).toHaveBeenCalledTimes(beforeCleanup + 1);
  }
});

// Real controller + authored HTTP fixtures, never live people or real-service evidence.
it('advances an empty scan only after explicit Next and does not invent presence', async () => {
  const h = fixture({ emptyScan: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No visible people in this part of the list. Show the next page.');
    // Every list is read once, one after another, ending on Friends: Blocked, Sent, Incoming, Friends.
    expect(h.calls.map((c) => c.path)).toEqual(readsOfEveryList());
    expect(h.calls.filter((c) => c.body.filter === 'friends')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Peer fixture');
    // No word at all: hidden, expired and unknown are one answer, and the row does not claim to know which.
    expect(screen.queryByText(/Online|Recently active|availability/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it.each([
  ['online', 'Friends · Online'],
  ['recently_active', 'Friends · Recently active'],
] as const)('shows a friend who is %s with that word beside the friendship', async (word, shown) => {
  mockAvailability.mockImplementation(() => word);
  const h = fixture({ emptyScan: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No visible people in this part of the list. Show the next page.');
    await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(shown);
  } finally {
    mockAvailability.mockImplementation(() => undefined);
    await view.unmount();
    h.scope.end();
  }
});
it('opens a friend’s universe by their public handle, and says nothing about what they share', async () => {
  const h = fixture({ emptyScan: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No visible people in this part of the list. Show the next page.');
    await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Options for Peer fixture' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Visit Peer fixture’s universe' }));
    expect(mockPush).toHaveBeenCalledWith('/visit/fixture.peer');
    // The menu sheet closes before the visit opens, so it is never left over the other screen.
    expect(screen.queryByRole('button', { name: 'Visit Peer fixture’s universe' })).toBeNull();
    expect(h.calls.every((call) => !call.path.includes('/visits/'))).toBe(true);
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it('retains the exact unknown accept retry and refreshes instead of treating the receipt as current friendship', async () => {
  const h = fixture({ unknownAccept: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No friends yet. Add one by their handle, or share your invite link.');
    // The request is waiting in the one list; nothing needs choosing to see it.
    await screen.findByText('Peer fixture');
    await fireEvent.press(screen.getByRole('button', { name: 'Accept Peer fixture' }));
    await screen.findByRole('button', { name: 'Retry the same request' });
    expect(screen.getByRole('button', { name: 'Accept Peer fixture' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry the same request' }));
    await screen.findByText('No friends yet. Add one by their handle, or share your invite link.');
    const commands = h.calls.filter((c) => c.path.endsWith('/accept'));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.body).toEqual(commands[0]!.body);
    expect(screen.queryByRole('button', { name: 'Remove Peer fixture' })).toBeNull();
    expect(h.calls.slice(-6).map((c) => c.path)).toEqual(readsOfEveryList());
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it('resolves an invite without a mutation, purges pasted secret, and fences scope-ended data', async () => {
  const h = fixture({ invite: true });
  const view = await render(h.tree);
  try {
    await settled();
    await fireEvent.changeText(
      screen.getByLabelText('Friend invite link'),
      `https://fixture.test/friends/invite#invite=${token}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Send invite to Peer fixture' });
    expect(screen.getByLabelText('Friend invite link').props.value).toBe('');
    expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
    expect(h.scope.storage.get('friends')).toBeUndefined();
    await act(() => {
      h.scope.end();
    });
    await screen.findByText('Friends session ended');
    expect(screen.queryByText('Peer fixture')).toBeNull();
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it('disposes a pending roster read on unmount, so its late reply cannot mount a person', async () => {
  const h = fixture({ delay: true });
  const view = await render(h.tree);
  await waitFor(() => expect(h.calls.some((c) => c.path.endsWith('/page'))).toBe(true));
  await view.unmount();
  await act(async () => {
    h.release();
    await Promise.resolve();
  });
  expect(h.calls.filter((c) => c.path.endsWith('/page'))).toHaveLength(1);
  h.scope.end();
});

it('consumes first invite delivery only on deliberate Copy and never renders the secret', async () => {
  const h = fixture({ invite: true });
  const view = await render(h.tree);
  try {
    await settled();
    await fireEvent.press(screen.getByRole('button', { name: 'Create invite link' }));
    const copy = await screen.findByRole('button', { name: 'Copy link' });
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    await fireEvent.press(copy);
    await screen.findByText('Invite link copied. Share it only with people you choose.');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`knowscroll://friends/invite#invite=${token}`);
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.queryByText(token)).toBeNull();
    expect(h.calls.filter((c) => c.path.endsWith('/invites/create'))).toHaveLength(1);
  } finally {
    await view.unmount();
    h.scope.end();
  }
});

it('reads the current pair after exact handle lookup and compares semantic UUIDs without case-dependent refusal', async () => {
  const h = fixture();
  const view = await render(h.tree);
  try {
    await screen.findByText('No friends yet. Add one by their handle, or share your invite link.');
    await fireEvent.press(screen.getByRole('button', { name: 'Add a friend' }));
    await fireEvent.changeText(screen.getByLabelText('Their handle'), 'fixture.peer');
    await fireEvent.press(screen.getByRole('button', { name: 'Find handle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invite to Peer fixture' })).toBeEnabled());
    expect(h.calls.slice(-2).map((c) => c.path)).toEqual(['/v1/social/people/lookup', '/v1/social/pairs/read']);
    expect(h.calls.some((c) => c.path.endsWith('/friends/request'))).toBe(false);
  } finally {
    await view.unmount();
    h.scope.end();
  }
});

it('takes and scrubs mounted second/invalid web fragments and clears earlier checked choices without auto resolving', async () => {
  const browser = browserFixture(`#invite=${token}`),
    h = fixture({ invite: true });
  const view = await render(h.tree);
  try {
    await settled();
    expect(browser.location.hash).toBe('');
    expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Send invite to Peer fixture' });
    await fireEvent.changeText(screen.getByLabelText('Their handle'), 'fixture.peer');
    await act(() => browser.change(`#invite=${secondToken}`));
    expect(browser.location.hash).toBe('');
    expect(browser.replaceState).toHaveBeenLastCalledWith(null, '', '/friends/invite');
    expect(screen.getByLabelText('Their handle').props.value).toBe('');
    expect(screen.getByLabelText('Friend invite link').props.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Send invite to Peer fixture' })).toBeNull();
    expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Send invite to Second fixture' });
    await act(() => browser.change('#invite=invalid&extra=authored-fixture'));
    expect(browser.location.hash).toBe('');
    expect(screen.queryByRole('button', { name: 'Send invite to Second fixture' })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Friend invite link'), `#invite=${token}`);
    await act(() => browser.change('#still-invalid'));
    expect(browser.location.hash).toBe('');
    expect(screen.getByLabelText('Friend invite link').props.value).toBe('');
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(2);
    expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
    const late = [...browser.listeners][0]!;
    await view.unmount();
    expect(browser.listeners.size).toBe(0);
    browser.location.hash = `#invite=${token}`;
    const scrubs = browser.replaceState.mock.calls.length;
    await act(() => late());
    expect(browser.replaceState).toHaveBeenCalledTimes(scrubs);
  } finally {
    await view.unmount();
    h.scope.end();
    browser.restore();
  }
});

it.each([false, true])(
  'does not restore a prior issuer after a mounted replacement fragment (valid=%s)',
  async (valid) => {
    const browser = browserFixture(`#invite=${token}`),
      h = fixture({ invite: true, resolveDelay: true });
    const view = await render(h.tree);
    try {
      await settled();
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      await waitFor(() => expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1));
      await act(() => browser.change(valid ? `#invite=${secondToken}` : '#invite=invalid'));
      expect(browser.location.hash).toBe('');
      await act(async () => {
        h.release();
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check invitation' })).toBeEnabled());
      expect(screen.queryByText('Peer fixture')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send invite to Peer fixture' })).toBeNull();
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
      if (!valid) await act(() => browser.change(`#invite=${secondToken}`));
      expect(browser.location.hash).toBe('');
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      await screen.findByRole('button', { name: 'Send invite to Second fixture' });
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve')).map((c) => c.body.token)).toEqual([
        token,
        secondToken,
      ]);
      expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
    } finally {
      h.release();
      await view.unmount();
      h.scope.end();
      browser.restore();
    }
  },
);

it('scrubs and discards initial and same-route web fragments while signed out, before a new signed-in mount', async () => {
  const browser = browserFixture(`#invite=${token}`),
    h = fixture({ invite: true });
  mockAccountState = { status: 'signed_out', reason: 'none' };
  let view = await render(h.entry);
  try {
    await screen.findByText('Sign in to manage friends');
    expect(browser.location.hash).toBe('');
    await act(() => browser.change(`#invite=${secondToken}`));
    expect(browser.location.hash).toBe('');
    await act(() => browser.change('#invite=invalid'));
    expect(browser.location.hash).toBe('');
    expect(browser.replaceState).toHaveBeenCalledTimes(3);
    expect(h.calls).toEqual([]);
    await view.unmount();
    expect(browser.listeners.size).toBe(0);
    mockAccountState = { status: 'signed_in', scope: h.scope };
    view = await render(h.tree);
    await settled();
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
    expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
  } finally {
    await view.unmount();
    h.scope.end();
    browser.restore();
  }
});

it('draws one list: friends, then people waiting, with Blocked folded until it is opened', async () => {
  const h = fixture({ waiting: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('Peer fixture');
    expect(screen.getByRole('button', { name: 'Accept Peer fixture' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Decline Peer fixture' })).toBeOnTheScreen();
    expect(screen.getByText('Second fixture')).toBeOnTheScreen();
    expect(screen.getByText('Pending')).toBeOnTheScreen();
    expect(screen.getByText('@fixture.second · invite sent')).toBeOnTheScreen();
    // The one primary is Add a friend; there are no filter tabs, refresh or paging buttons on a short list.
    expect(screen.getAllByRole('button', { name: 'Add a friend' })).toHaveLength(1);
    expect(screen.queryByRole('togglebutton')).toBeNull();
    expect(screen.queryByText('Third fixture')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Blocked' }));
    expect(screen.getByText('@fixture.third · Can’t message, invite or visit you')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Unblock Third fixture' })).toBeOnTheScreen();
  } finally {
    await view.unmount();
    h.scope.end();
  }
});

it('answers a request that waits in the list from a row in another list than the one paged', async () => {
  const h = fixture({ waiting: true });
  const view = await render(h.tree);
  try {
    await fireEvent.press(await screen.findByRole('button', { name: 'Accept Peer fixture' }));
    await waitFor(() => expect(h.calls.some((c) => c.path.endsWith('/accept'))).toBe(true));
    expect(h.calls.find((c) => c.path.endsWith('/accept'))!.body).toMatchObject({ peerPersonId: peer.personId });
  } finally {
    await view.unmount();
    h.scope.end();
  }
});

it('offers Add a friend as the drawn panel: handle, the found person with Send invite, and the invite link card', async () => {
  const h = fixture({ waiting: true });
  const view = await render(h.tree);
  try {
    await fireEvent.press(await screen.findByRole('button', { name: 'Add a friend' }));
    await fireEvent.changeText(screen.getByLabelText('Their handle'), 'fixture.peer');
    await fireEvent.press(screen.getByRole('button', { name: 'Find handle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invite to Peer fixture' })).toBeEnabled());
    expect(screen.getByText('This invite link was turned off')).toBeOnTheScreen();
    expect(screen.getByText(/People who open it now see “This link no longer works.”/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeOnTheScreen();
    expect(screen.getByText(/We never upload your contacts/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to friends' }));
    expect(screen.getByRole('button', { name: 'Add a friend' })).toBeOnTheScreen();
  } finally {
    await view.unmount();
    h.scope.end();
  }
});

it('shows more of Waiting and Blocked a page at a time, and a person on a later page can be unblocked', async () => {
  const h = fixture({ long: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('Second fixture');
    expect(screen.queryByText('Fifth fixture')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show more waiting' }));
    await screen.findByText('Fifth fixture');
    expect(screen.queryByRole('button', { name: 'Show more waiting' })).toBeNull();
    // The friends' own page was not touched by either: it was read once.
    expect(h.calls.filter((c) => c.path.endsWith('/friends/page') && c.body.filter === 'friends')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Blocked' }));
    expect(screen.queryByText('Fourth fixture')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show more blocked' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Unblock Fourth fixture' }));
    await waitFor(() => expect(h.calls.some((c) => c.path.endsWith('/unblock'))).toBe(true));
    expect(h.calls.find((c) => c.path.endsWith('/unblock'))!.body).toMatchObject({ peerPersonId: fourthPeer.personId });
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
