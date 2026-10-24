import type * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import { conversation, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { ConversationsScreen } from './conversations-screen';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn(), push: mockPush, replace: jest.fn(), canGoBack: () => false }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
let mockAccount: AccountScopeState = { status: 'signed_out', reason: 'none' };
jest.mock('../../providers/account-scope', () => ({
  useAccountScopeIfPresent: () => ({ state: mockAccount, manager: { refresh: jest.fn() } }),
  useAccountInitial: () => undefined,
}));
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

async function mount(server: ReturnType<typeof talkServer>) {
  mockAccount = { status: 'signed_in', scope: server.scope };
  await render(
    <QueryClientProvider client={server.scope.queryClient}>
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ConversationsScreen />
      </DisplayProvider>
    </QueryClientProvider>,
  );
}

/** Unmount first so the query cache's own timers are cancelled, then end the scope. */
async function finish(server: ReturnType<typeof talkServer>) {
  await screen.unmount();
  server.scope.end();
}

afterEach(() => {
  mockPush.mockClear();
});

describe('Talk inbox (labelled in-memory server)', () => {
  it('shows the first-visit screen when signed out, with actions that lead somewhere real', async () => {
    mockAccount = { status: 'signed_out', reason: 'none' };
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ConversationsScreen />
      </DisplayProvider>,
    );
    expect(screen.getByText('No conversations yet')).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Share something' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Invite a friend' })).toBeOnTheScreen();
  });

  it('shows the empty screen for a signed-in person with no messages yet', async () => {
    const server = talkServer();
    await mount(server);
    expect(await screen.findByText('No conversations yet')).toBeOnTheScreen();
    await finish(server);
  });

  it('lists a conversation as one link with an unread description, and opens it with the person’s own reference', async () => {
    const server = talkServer();
    server.peerSays('Wait, so batching makes each answer slower?');
    await mount(server);
    const link = await screen.findByTestId(`talk-row-${conversation.conversationId}`);
    expect(link.props.accessibilityLabel).toContain(
      `${peer.displayName}, unread, Wait, so batching makes each answer slower?`,
    );
    expect(screen.getByText(peer.displayName)).toBeOnTheScreen();
    await fireEvent.press(link);
    expect(mockPush).toHaveBeenCalledWith(
      `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=1`,
    );
    await finish(server);
  });

  it('says it is offline, and keeps what it has, when a later read fails', async () => {
    const server = talkServer();
    server.peerSays('hello');
    await mount(server);
    await screen.findByText(peer.displayName);
    server.failNext('/v1/social/conversations/inbox', 'unavailable');
    await act(async () => {
      await server.scope.queryClient.refetchQueries();
    });
    await waitFor(() => expect(screen.getByText(/may be out of date/)).toBeOnTheScreen());
    expect(screen.getByText(peer.displayName)).toBeOnTheScreen();
    await finish(server);
  });

  it('offers a retry when the first read fails', async () => {
    const server = talkServer();
    server.failNext('/v1/social/conversations/inbox', 'unavailable');
    await mount(server);
    expect(await screen.findByText("Can't load conversations")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No conversations yet')).toBeOnTheScreen();
    await finish(server);
  });
});
