import type * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import { conversation, id, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { ConversationScreen } from './conversation-screen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({
      navigate: jest.fn(),
      push: mockPush,
      replace: mockReplace,
      back: jest.fn(),
      canGoBack: () => false,
    }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
let mockAccount: AccountScopeState = { status: 'signed_out', reason: 'none' };
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: mockAccount, manager: { refresh: jest.fn() } }),
}));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

async function open(server: ReturnType<typeof talkServer>) {
  mockAccount = { status: 'signed_in', scope: server.scope };
  await render(
    <QueryClientProvider client={server.scope.queryClient}>
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ConversationScreen conversationId={conversation.conversationId} m={conversation.membershipId} r="1" />
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
  mockReplace.mockClear();
});

describe('conversation thread screen (labelled in-memory server)', () => {
  it('shows the peer’s name, a first-time hint and a composer for an empty thread', async () => {
    const server = talkServer();
    await open(server);
    expect(await screen.findByText('No messages yet. Say hello.')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: peer.displayName })).toBeOnTheScreen();
    expect(screen.getByLabelText(`Message ${peer.displayName}`)).toBeOnTheScreen();
    await finish(server);
  });

  it('sends a message once, clears the box and shows the bubble in order', async () => {
    const server = talkServer();
    server.peerSays('Wait, so batching makes each answer slower?');
    await open(server);
    await screen.findByText('Wait, so batching makes each answer slower?');
    const input = screen.getByLabelText(`Message ${peer.displayName}`);
    await fireEvent.changeText(input, 'A little — that’s the trade.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('A little — that’s the trade.')).toBeOnTheScreen();
    await waitFor(() =>
      expect(server.storedTexts()).toEqual([
        'Wait, so batching makes each answer slower?',
        'A little — that’s the trade.',
      ]),
    );
    expect(screen.getByLabelText(`Message ${peer.displayName}`).props.value).toBe('');
    await finish(server);
  });

  it('keeps one bubble through a lost answer and a retry, and sends it only once', async () => {
    const server = talkServer();
    await open(server);
    await screen.findByText('No messages yet. Say hello.');
    server.failNext('/v1/social/conversations/send', 'lost_response');
    await fireEvent.changeText(screen.getByLabelText(`Message ${peer.displayName}`), 'did it arrive?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Not confirmed')).toBeOnTheScreen();
    expect(screen.getAllByText('did it arrive?')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Not confirmed')).toBeNull());
    expect(screen.getAllByText('did it arrive?')).toHaveLength(1);
    expect(server.storedTexts()).toEqual(['did it arrive?']);
    await finish(server);
  });

  it('shows a shared card with its title and opens the content on its own page', async () => {
    const server = talkServer();
    await open(server);
    await screen.findByText('No messages yet. Say hello.');
    const content = { assetId: id(77), assetRevision: 1 };
    await server.scope.api.conversations.send({
      version: 'direct-conversation.v1',
      commandId: id(900),
      conversation,
      body: { kind: 'content', target: content, note: 'This is the bit I meant' },
    });
    await server.scope.queryClient.refetchQueries();
    expect(await screen.findByText('What one answer costs to serve')).toBeOnTheScreen();
    expect(screen.getByText('This is the bit I meant')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: 'Open Reel' }));
    expect(mockPush).toHaveBeenCalledWith(`/reel/${content.assetId}`);
    await finish(server);
  });

  it('says the other person left, keeps the history and removes the composer', async () => {
    const server = talkServer();
    server.peerSays('goodbye');
    await open(server);
    await screen.findByText('goodbye');
    server.peerLeaves();
    await server.scope.queryClient.refetchQueries();
    expect(await screen.findByText(`${peer.displayName} left this conversation.`)).toBeOnTheScreen();
    expect(screen.getByText('goodbye')).toBeOnTheScreen();
    expect(screen.queryByLabelText(`Message ${peer.displayName}`)).toBeNull();
    await finish(server);
  });

  it('says nothing about why when the conversation is not available', async () => {
    const server = talkServer();
    server.failNext('/v1/social/conversations/read', 'unavailable');
    await open(server);
    expect(await screen.findByText('This conversation isn’t available')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: 'Back to Talk' }));
    expect(mockReplace).toHaveBeenCalledWith('/conversations');
    await finish(server);
  });

  it('asks a signed-out visitor to sign in', async () => {
    mockAccount = { status: 'signed_out', reason: 'none' };
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ConversationScreen conversationId={conversation.conversationId} />
      </DisplayProvider>,
    );
    expect(screen.getByText('Sign in to read this conversation')).toBeOnTheScreen();
  });
});
