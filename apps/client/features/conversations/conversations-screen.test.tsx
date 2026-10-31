import type * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import { conversation, invitedThread, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider, TalkThemeProvider } from '@knowscroll/ui';
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

async function mount(server: ReturnType<typeof talkServer>, theme?: 'sky' | 'paper') {
  mockAccount = { status: 'signed_in', scope: server.scope };
  await render(
    <QueryClientProvider client={server.scope.queryClient}>
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <TalkThemeProvider {...(theme === undefined ? {} : { name: theme })}>
          <ConversationsScreen />
        </TalkThemeProvider>
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

  it('draws the list on the dark sky under the Talk theme (cream names), and in ink on Paper', async () => {
    for (const [theme, colour] of [
      ['sky', '#FFFBF0'],
      ['paper', '#111111'],
    ] as const) {
      const server = talkServer();
      server.peerSays('hello');
      await mount(server, theme);
      await screen.findByTestId(`talk-row-${conversation.conversationId}`);
      expect(screen.getByText(peer.displayName)).toHaveStyle({ color: colour });
      await finish(server);
    }
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

  it('shows an invitation as a card with a preview, and joins from the card into the thread', async () => {
    const server = talkServer();
    server.inviteToThread('Black holes');
    await mount(server);
    const card = await screen.findByTestId('thread-invitation');
    expect(card).toBeOnTheScreen();
    expect(screen.getByText(`${peer.displayName} started a thread · Black holes`)).toBeOnTheScreen();
    expect(screen.getByText(/Your universe and history aren’t shared/)).toBeOnTheScreen();
    // The invitation is a card, not a row in the list.
    expect(screen.queryByTestId(`talk-thread-${invitedThread.threadId}`)).toBeNull();
    const threadPath = `/threads/${invitedThread.threadId}?m=${invitedThread.membershipId}&r=1`;
    await fireEvent.press(screen.getByRole('link', { name: 'Preview the thread' }));
    expect(mockPush).toHaveBeenCalledWith(threadPath);
    mockPush.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'Join thread' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(threadPath));
    expect(server.invitationAnswers()).toEqual(['join']);
    await finish(server);
  });

  it('ignores an invitation with one decline, and the card goes quietly', async () => {
    const server = talkServer();
    server.inviteToThread('Black holes');
    await mount(server);
    await fireEvent.press(await screen.findByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByTestId('thread-invitation')).toBeNull());
    expect(server.invitationAnswers()).toEqual(['decline']);
    expect(mockPush).not.toHaveBeenCalled();
    await finish(server);
  });

  it('keeps the card and says so when the answer did not arrive, then retries the same command', async () => {
    const server = talkServer();
    server.inviteToThread('Black holes');
    await mount(server);
    server.failNext('/v1/social/threads/respond', 'network');
    await fireEvent.press(await screen.findByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('Couldn’t reach KnowScroll.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByTestId('thread-invitation')).toBeNull());
    const answers = server.requests.filter((request) => request.path.endsWith('/threads/respond'));
    expect(answers).toHaveLength(2);
    expect(answers[0]?.body['commandId']).toBe(answers[1]?.body['commandId']);
    await finish(server);
  });

  it('offers New once there is something in Talk, and not on the first-visit screen', async () => {
    const empty = talkServer();
    await mount(empty);
    await screen.findByText('No conversations yet');
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
    // The account stays reachable from every tab header (D-006 c), with or without New.
    expect(screen.getByRole('link', { name: 'Account and settings' })).toBeOnTheScreen();
    await finish(empty);
    const server = talkServer();
    server.peerSays('hello');
    await mount(server);
    await fireEvent.press(await screen.findByRole('button', { name: 'New conversation' }));
    expect(screen.getByRole('link', { name: 'Account and settings' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Invite a friend' }));
    expect(mockPush).toHaveBeenCalledWith('/friends');
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
