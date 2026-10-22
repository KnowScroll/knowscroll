import type * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { SignedInFriends } from './friends-screen';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('expo-linking', () => ({
  createURL: () => 'knowscroll://friends/invite',
  getInitialURL: () => Promise.resolve(null),
  addEventListener: () => ({ remove: () => undefined }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const own = { kind: 'person', personId: id(3), handle: 'fixture.own', displayName: 'Own fixture' };
const peer = { kind: 'person', personId: id(4), handle: 'fixture.peer', displayName: 'Peer fixture' };
const wireScope = { accountId: id(1), privacyEpoch: 1 };
const envelope = { version: 'sharing.v1', scope: wireScope };
const token = `ksfi_${'A'.repeat(43)}`;
function fixture(options: { emptyScan?: boolean; unknownAccept?: boolean; invite?: boolean; delay?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let failures = options.unknownAccept ? 1 : 0;
  let linked = false;
  let activeLink = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = createAccountScope({
    account: { ...wireScope, universeId: id(2), email: 'fixture@example.test' },
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
      } else if (path.endsWith('/invites/resolve'))
        data = { ...envelope, status: 'available', issuer: peer, pairRevision: 0 };
      else throw new Error('Unexpected fixture route');
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
  return { scope, calls, tree, release };
}

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
    await fireEvent.press(screen.getByRole('button', { name: 'Incoming requests' }));
    await screen.findByText('Peer fixture');
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
