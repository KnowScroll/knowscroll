import type * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { AccountScopeState } from '@knowscroll/client-core';
import { conversation, createdThread, id, peer, talkServer } from '@knowscroll/client-core/talk-fixture';
import { capsuleLabel } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { ConversationScreen } from './conversation-screen';

const mockCopy = jest.fn();
jest.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => {
    mockCopy(text);
    return Promise.resolve();
  },
}));

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

  it('puts messages that arrived while the connection was lost under one divider, and none without a loss', async () => {
    const server = talkServer();
    server.peerSays('before the loss');
    await open(server);
    await screen.findByText('before the loss');
    server.peerSays('arrived live');
    await server.scope.queryClient.refetchQueries();
    await screen.findByText('arrived live');
    expect(screen.queryByTestId('away-divider')).toBeNull();
    server.failNext('/v1/social/conversations/changes', 'network');
    await server.scope.queryClient.refetchQueries();
    expect(await screen.findByText('Reconnecting…')).toBeOnTheScreen();
    server.peerSays('while you were gone');
    await server.scope.queryClient.refetchQueries();
    await screen.findByText('while you were gone');
    expect(screen.getByText('WHILE YOU WERE AWAY')).toBeOnTheScreen();
    expect(screen.getAllByTestId('away-divider')).toHaveLength(1);
    await finish(server);
  });

  it('turns the shared card into a thread with the other person, once, from the header', async () => {
    const server = talkServer();
    await open(server);
    await screen.findByText('No messages yet. Say hello.');
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull();
    const content = { assetId: id(77), assetRevision: 1 };
    await server.scope.api.conversations.send({
      version: 'direct-conversation.v1',
      commandId: id(901),
      conversation,
      body: { kind: 'content', target: content },
    });
    await server.scope.queryClient.refetchQueries();
    await fireEvent.press(await screen.findByRole('button', { name: 'Start a thread' }));
    expect(screen.getByText(/is invited and joins when they answer/)).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Thread name (optional)'), 'Batching');
    await fireEvent.press(screen.getByRole('button', { name: 'Start thread' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Open thread' }));
    expect(mockPush).toHaveBeenCalledWith(
      `/threads/${createdThread.threadId}?m=${createdThread.membershipId}&r=${String(createdThread.membershipRevision)}`,
    );
    const created = server.requests.filter((request) => request.path.endsWith('/threads/create'));
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({ root: content, friendPersonIds: [peer.personId], name: 'Batching' });
    await finish(server);
  });

  it('offers no thread while the conversation has no shared card', async () => {
    const server = talkServer();
    server.peerSays('hello');
    await open(server);
    await screen.findByText('hello');
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull();
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

  it('names a deleted account neutrally, keeps the history and offers nothing to block', async () => {
    const server = talkServer();
    server.peerSays('goodbye');
    await open(server);
    await screen.findByText('goodbye');
    server.peerDeletes();
    await server.scope.queryClient.refetchQueries();
    expect(await screen.findByText('This account was deleted.')).toBeOnTheScreen();
    expect(screen.getByText('goodbye')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Deleted account' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Conversation options' }));
    expect(screen.queryByRole('button', { name: /^Block/ })).toBeNull();
    await finish(server);
  });

  it('draws a capsule for the day and the time under the last message of a run', async () => {
    const server = talkServer();
    server.peerSays('part 1 dekha?');
    server.peerSays('moon ka bulge samajh aaya');
    await open(server);
    await screen.findByText('moon ka bulge samajh aaya');
    // The fixture's messages are all from one moment: one run, so one time under the second.
    const capsule = capsuleLabel(new Date('2026-10-24T08:00:00.000Z'), new Date());
    expect(screen.getByRole('header', { name: capsule })).toBeOnTheScreen();
    expect(screen.getAllByTestId('message-time')).toHaveLength(1);
    await finish(server);
  });

  describe('replies, reactions and the message menu', () => {
    const longPress = (text: string) => fireEvent(screen.getByText(text), 'longPress');

    it('replies from the long-press menu: the chip waits above the box, the reply names its original, and the quote shows', async () => {
      const server = talkServer();
      server.peerSays('who is on part 2?');
      await open(server);
      await screen.findByText('who is on part 2?');
      await longPress('who is on part 2?');
      await fireEvent.press(await screen.findByRole('menuitem', { name: 'Reply' }));
      expect(await screen.findByText(`Replying to ${peer.displayName}`)).toBeOnTheScreen();
      await fireEvent.changeText(screen.getByLabelText(`Message ${peer.displayName}`), 'part 2 abhi start kiya');
      await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(server.storedTexts()).toEqual(['who is on part 2?', 'part 2 abhi start kiya']));
      const sent = server.requests.find((request) => request.path.endsWith('/conversations/send'));
      expect(sent?.body['replyTo']).toBe(id(1001));
      // The chip is gone once the reply is sent, and the quote strip names the original.
      await waitFor(() => expect(screen.queryByTestId('reply-chip')).toBeNull());
      expect(
        await screen.findByRole('button', {
          name: `Reply to ${peer.displayName}: who is on part 2?. Go to the original message`,
        }),
      ).toBeOnTheScreen();
      await finish(server);
    });

    it('cancels a reply with its ✕, so the next message is not one', async () => {
      const server = talkServer();
      server.peerSays('hello');
      await open(server);
      await screen.findByText('hello');
      await longPress('hello');
      await fireEvent.press(await screen.findByRole('menuitem', { name: 'Reply' }));
      await fireEvent.press(await screen.findByRole('button', { name: 'Cancel reply' }));
      expect(screen.queryByTestId('reply-chip')).toBeNull();
      await fireEvent.changeText(screen.getByLabelText(`Message ${peer.displayName}`), 'plain');
      await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(server.storedTexts()).toEqual(['hello', 'plain']));
      expect(server.requests.find((request) => request.path.endsWith('/conversations/send'))?.body).not.toHaveProperty(
        'replyTo',
      );
      await finish(server);
    });

    it('reacts from the menu, shows the pill with a count, lists who, and takes the reaction back', async () => {
      const server = talkServer();
      server.peerSays('the far side bulges too');
      await open(server);
      await screen.findByText('the far side bulges too');
      await longPress('the far side bulges too');
      await fireEvent.press(await screen.findByRole('togglebutton', { name: 'Heart' }));
      await waitFor(() => expect(server.reactionsOn(1)).toEqual([{ kind: 'heart', by: 'me' }]));
      const pill = await screen.findByRole('button', { name: 'Heart, 1 person, including you' });
      server.peerReacts(1, 'heart');
      await server.scope.queryClient.refetchQueries();
      await fireEvent.press(await screen.findByRole('button', { name: 'Heart, 2 people, including you' }));
      const who = within(await screen.findByLabelText('People who reacted with Heart'));
      expect(who.getByText('You')).toBeOnTheScreen();
      expect(who.getByText(peer.displayName)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Take back your Heart' }));
      await waitFor(() => expect(server.reactionsOn(1)).toEqual([{ kind: 'heart', by: 'peer' }]));
      expect(pill).toBeTruthy();
      await finish(server);
    });

    it('offers Copy and Report on another person’s message, and Report opens the report about that message', async () => {
      const server = talkServer();
      server.peerSays('hello');
      await open(server);
      await screen.findByText('hello');
      await longPress('hello');
      await fireEvent.press(await screen.findByRole('menuitem', { name: 'Copy' }));
      expect(mockCopy).toHaveBeenCalledWith('hello');
      await longPress('hello');
      expect(await screen.findByRole('menuitem', { name: 'Report' })).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('menuitem', { name: 'Report' }));
      expect(await screen.findByText('Report abuse')).toBeOnTheScreen();
      expect(screen.getByText(new RegExp(peer.displayName + '’s message'))).toBeOnTheScreen();
      await finish(server);
    });

    it('swipes right past 60 px to reply, and not for less, or when the finger goes down', async () => {
      const server = talkServer();
      server.peerSays('swipe me');
      await open(server);
      await screen.findByText('swipe me');
      const row = screen.getByTestId('message-1');
      const touch = (x: number, y: number) => ({ nativeEvent: { touches: [{ pageX: x, pageY: y }] } });
      // Short of the threshold: nothing.
      await fireEvent(row, 'touchStart', touch(10, 100));
      await fireEvent(row, 'touchMove', touch(50, 102));
      await fireEvent(row, 'touchEnd', {});
      expect(screen.queryByTestId('reply-chip')).toBeNull();
      // Mostly down: the list scrolls, nothing replies.
      await fireEvent(row, 'touchStart', touch(10, 100));
      await fireEvent(row, 'touchMove', touch(80, 190));
      await fireEvent(row, 'touchEnd', {});
      expect(screen.queryByTestId('reply-chip')).toBeNull();
      // Past 60 px and clearly across: the reply chip waits in the box.
      await fireEvent(row, 'touchStart', touch(10, 100));
      await fireEvent(row, 'touchMove', touch(40, 101));
      await fireEvent(row, 'touchMove', touch(80, 103));
      await fireEvent(row, 'touchEnd', {});
      expect(await screen.findByText(`Replying to ${peer.displayName}`)).toBeOnTheScreen();
      await finish(server);
    });

    it('replies and opens the menu from the keyboard, ignoring keys with a modifier', async () => {
      const server = talkServer();
      server.peerSays('keys');
      await open(server);
      await screen.findByText('keys');
      const row = screen.getByTestId('message-1');
      await fireEvent(row, 'keyDown', { key: 'r', ctrlKey: true, preventDefault: jest.fn() });
      expect(screen.queryByTestId('reply-chip')).toBeNull();
      await fireEvent(row, 'keyDown', { key: 'e', preventDefault: jest.fn() });
      expect(await screen.findByRole('menuitem', { name: 'Reply' })).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('menuitem', { name: 'Reply' }));
      await fireEvent(row, 'keyDown', { key: 'R', preventDefault: jest.fn() });
      expect(await screen.findByText(`Replying to ${peer.displayName}`)).toBeOnTheScreen();
      await finish(server);
    });

    it('offers no reply or reaction once the other person has left', async () => {
      const server = talkServer();
      server.peerSays('goodbye');
      await open(server);
      await screen.findByText('goodbye');
      server.peerLeaves();
      await server.scope.queryClient.refetchQueries();
      await screen.findByText(`${peer.displayName} left this conversation.`);
      await longPress('goodbye');
      expect(await screen.findByRole('menuitem', { name: 'Copy' })).toBeOnTheScreen();
      expect(screen.queryByRole('menuitem', { name: 'Reply' })).toBeNull();
      expect(screen.queryByRole('togglebutton', { name: 'Heart' })).toBeNull();
      await finish(server);
    });

    it('drops the reply chip when the message it answers is removed meanwhile', async () => {
      const server = talkServer();
      server.peerSays('soon removed');
      await open(server);
      await screen.findByText('soon removed');
      await longPress('soon removed');
      await fireEvent.press(await screen.findByRole('menuitem', { name: 'Reply' }));
      expect(await screen.findByTestId('reply-chip')).toBeOnTheScreen();
      server.tombstone(1);
      await server.scope.queryClient.refetchQueries();
      await waitFor(() => expect(screen.queryByTestId('reply-chip')).toBeNull());
      await fireEvent.changeText(screen.getByLabelText(`Message ${peer.displayName}`), 'a plain one');
      await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(server.storedTexts()).toEqual([null, 'a plain one']));
      expect(server.requests.find((request) => request.path.endsWith('/conversations/send'))?.body).not.toHaveProperty(
        'replyTo',
      );
      await finish(server);
    });

    it('offers to send a refused reply without the quote, once the message it answers was removed before it went', async () => {
      const server = talkServer();
      server.peerSays('soon removed');
      await open(server);
      await screen.findByText('soon removed');
      await longPress('soon removed');
      await fireEvent.press(await screen.findByRole('menuitem', { name: 'Reply' }));
      // The removal has not reached this reader yet when the reply goes.
      server.tombstone(1);
      await fireEvent.changeText(screen.getByLabelText(`Message ${peer.displayName}`), 'part 2 abhi start kiya');
      await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
      expect(await screen.findByText('Not sent')).toBeOnTheScreen();
      await fireEvent.press(await screen.findByRole('button', { name: 'Send without the quote' }));
      await waitFor(() => expect(server.storedTexts()).toEqual([null, 'part 2 abhi start kiya']));
      await waitFor(() => expect(screen.queryByText('Not sent')).toBeNull());
      expect(screen.queryByRole('button', { name: 'Send without the quote' })).toBeNull();
      await finish(server);
    });

    it('says the original is gone in a quote, and does not offer to jump', async () => {
      const server = talkServer();
      server.peerSays('soon removed');
      server.peerSays('an answer', 1);
      await open(server);
      await screen.findByText('an answer');
      server.tombstone(1);
      await server.scope.queryClient.refetchQueries();
      expect(await screen.findByText('Original message removed')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /Go to the original message/ })).toBeNull();
      await finish(server);
    });
  });

  it('does not offer Watch together once the other person has left', async () => {
    const server = talkServer();
    await open(server);
    await screen.findByText('No messages yet. Say hello.');
    await server.scope.api.conversations.send({
      version: 'direct-conversation.v1',
      commandId: id(903),
      conversation,
      body: { kind: 'content', target: { assetId: id(77), assetRevision: 1 } },
    });
    await server.scope.queryClient.refetchQueries();
    expect(await screen.findByRole('button', { name: 'Watch together' })).toBeOnTheScreen();
    server.peerLeaves();
    await server.scope.queryClient.refetchQueries();
    await screen.findByText(`${peer.displayName} left this conversation.`);
    expect(screen.queryByRole('button', { name: 'Watch together' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull();
    await finish(server);
  });

  it('starts a thread from a shared card with Watch together, for the same two people, and leaves the chat as it is', async () => {
    const server = talkServer();
    await open(server);
    await screen.findByText('No messages yet. Say hello.');
    const content = { assetId: id(77), assetRevision: 1 };
    await server.scope.api.conversations.send({
      version: 'direct-conversation.v1',
      commandId: id(902),
      conversation,
      body: { kind: 'content', target: content },
    });
    await server.scope.queryClient.refetchQueries();
    await fireEvent.press(await screen.findByRole('button', { name: 'Watch together' }));
    expect(await screen.findByText(/This chat stays as it is/)).toBeOnTheScreen();
    // Two buttons share the words now: the card's and the sheet's. The sheet's is the last.
    const buttons = screen.getAllByRole('button', { name: 'Watch together' });
    await fireEvent.press(buttons[buttons.length - 1]!);
    await fireEvent.press(await screen.findByRole('button', { name: 'Open thread' }));
    const created = server.requests.filter((request) => request.path.endsWith('/threads/create'));
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({ root: content, friendPersonIds: [peer.personId] });
    expect(mockPush).toHaveBeenCalledWith(
      `/threads/${createdThread.threadId}?m=${createdThread.membershipId}&r=${String(createdThread.membershipRevision)}`,
    );
    // The conversation is untouched: no message was sent by starting it.
    expect(server.messageCount()).toBe(1);
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
