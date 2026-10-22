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

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => false }),
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

jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const own = { kind: 'person', personId: id(3), handle: 'fixture.own', displayName: 'Own fixture' };
const peer = { kind: 'person', personId: id(4), handle: 'fixture.peer', displayName: 'Peer fixture' };
const token = `ksfi_${'A'.repeat(43)}`;
const secondToken = `ksfi_${'B'.repeat(43)}`;
const secondPeer = { ...peer, personId: id(8), handle: 'fixture.second', displayName: 'Second fixture' };
function fixture(
  options: {
    emptyScan?: boolean;
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
            body.filter === 'incoming' && !linked
              ? [{ state: 'incoming', peer, pairRevision: 1, requestId: id(5) }]
              : body.cursor
                ? [{ state: 'friends', peer, pairRevision: 2, availability: { state: 'unknown' } }]
                : [],
          ...(options.emptyScan && !body.cursor && body.filter === 'friends'
            ? { next: { scope: wireScope, filter: 'friends', snapshotRevision: 1, token: 'fixture_cursor' } }
            : {}),
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
  await screen.findByText('No people to show in this list.');
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
      await screen.findByText('No people to show in this list.');
      await act(async () => {
        finishLaunch(`knowscroll://friends/invite#invite=${token}`);
        late({ url: `knowscroll://friends/invite#invite=${token}` });
        await Promise.resolve();
      });
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
      expect(screen.queryByRole('button', { name: 'Request friendship with Peer fixture' })).toBeNull();
      expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
      const current = jest.mocked(Linking.addEventListener).mock.calls.at(-1)![1];
      await act(() => current({ url: `knowscroll://friends/invite#invite=${secondToken}` }));
      expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      await screen.findByRole('button', { name: 'Request friendship with Second fixture' });
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
    await screen.findByText('No visible people in this part of the scan. Choose Next to continue.');
    expect(h.calls.map((c) => c.path)).toEqual(['/v1/social/profile', '/v1/social/invites', '/v1/social/friends/page']);
    expect(h.calls.filter((c) => c.path.endsWith('/page'))).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Peer fixture');
    expect(screen.getByText('Friends · availability not shared')).toBeOnTheScreen();
    expect(screen.queryByText('Online')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it('retains the exact unknown accept retry and refreshes instead of treating the receipt as current friendship', async () => {
  const h = fixture({ unknownAccept: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No people to show in this list.');
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Incoming requests', checked: false }));
    await screen.findByText('Peer fixture');
    expect(screen.getByRole('togglebutton', { name: 'Incoming requests', checked: true })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Accept Peer fixture' }));
    await screen.findByRole('button', { name: 'Retry the same request' });
    expect(screen.getByRole('button', { name: 'Accept Peer fixture' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry the same request' }));
    await screen.findByText('No people to show in this list.');
    const commands = h.calls.filter((c) => c.path.endsWith('/accept'));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.body).toEqual(commands[0]!.body);
    expect(screen.queryByRole('button', { name: 'Remove Peer fixture' })).toBeNull();
    expect(h.calls.slice(-3).map((c) => c.path)).toEqual([
      '/v1/social/profile',
      '/v1/social/invites',
      '/v1/social/requests/page',
    ]);
  } finally {
    await view.unmount();
    h.scope.end();
  }
});
it('resolves an invite without a mutation, purges pasted secret, and fences scope-ended data', async () => {
  const h = fixture({ invite: true });
  const view = await render(h.tree);
  try {
    await screen.findByText('No people to show in this list.');
    await fireEvent.changeText(
      screen.getByLabelText('Friend invite link'),
      `https://fixture.test/friends/invite#invite=${token}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Request friendship with Peer fixture' });
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
    await screen.findByText('No people to show in this list.');
    await fireEvent.press(screen.getByRole('button', { name: 'Create invite link' }));
    const copy = await screen.findByRole('button', { name: 'Copy invite link once' });
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    await fireEvent.press(copy);
    await screen.findByText('Invite link copied. Share it only with people you choose.');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`knowscroll://friends/invite#invite=${token}`);
    expect(screen.queryByRole('button', { name: 'Copy invite link once' })).toBeNull();
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
    await screen.findByText('No people to show in this list.');
    await fireEvent.press(screen.getByRole('button', { name: 'Add a friend' }));
    await fireEvent.changeText(screen.getByLabelText('Their handle'), 'fixture.peer');
    await fireEvent.press(screen.getByRole('button', { name: 'Find handle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send request to Peer fixture' })).toBeEnabled());
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
    await screen.findByText('No people to show in this list.');
    expect(browser.location.hash).toBe('');
    expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Request friendship with Peer fixture' });
    await fireEvent.changeText(screen.getByLabelText('Their handle'), 'fixture.peer');
    await act(() => browser.change(`#invite=${secondToken}`));
    expect(browser.location.hash).toBe('');
    expect(browser.replaceState).toHaveBeenLastCalledWith(null, '', '/friends/invite');
    expect(screen.getByLabelText('Their handle').props.value).toBe('');
    expect(screen.getByLabelText('Friend invite link').props.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Request friendship with Peer fixture' })).toBeNull();
    expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await screen.findByRole('button', { name: 'Request friendship with Second fixture' });
    await act(() => browser.change('#invite=invalid&extra=authored-fixture'));
    expect(browser.location.hash).toBe('');
    expect(screen.queryByRole('button', { name: 'Request friendship with Second fixture' })).toBeNull();
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
      await screen.findByText('No people to show in this list.');
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
      expect(screen.queryByRole('button', { name: 'Request friendship with Peer fixture' })).toBeNull();
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
      if (!valid) await act(() => browser.change(`#invite=${secondToken}`));
      expect(browser.location.hash).toBe('');
      expect(h.calls.filter((c) => c.path.endsWith('/invites/resolve'))).toHaveLength(1);
      await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
      await screen.findByRole('button', { name: 'Request friendship with Second fixture' });
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
    await screen.findByText('No people to show in this list.');
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    expect(h.calls.some((c) => c.path.endsWith('/invites/resolve'))).toBe(false);
    expect(h.calls.some((c) => c.path.endsWith('/request'))).toBe(false);
  } finally {
    await view.unmount();
    h.scope.end();
    browser.restore();
  }
});
