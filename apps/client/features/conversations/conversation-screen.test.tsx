import type * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { createAccountScope, memoryStore, type ConversationsState } from '@knowscroll/client-core';
import { SignedInConversation } from './conversation-screen';
import { ConversationMessage } from './conversation-message';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<typeof React>('react').useEffect(effect, [effect]),
}));
jest.mock('../shell/screen-frame', () => ({ ScreenFrame: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../friends/use-friends-session', () => ({ useFriendsSession: () => undefined }));
const mockOpenContent = jest.fn(() => true);
jest.mock('../encounter/use-encounter-session', () => ({
  encounterSessionFor: () => ({ openConversationContent: mockOpenContent }),
}));
let mockState: ConversationsState;
const mockSession = {
  getState: () => mockState,
  open: jest.fn(() => Promise.resolve()),
  refreshConversation: jest.fn(() => Promise.resolve()),
  history: jest.fn(() => Promise.resolve()),
  catchUp: jest.fn(() => Promise.resolve()),
  setDraft: jest.fn(),
  send: jest.fn(() => Promise.resolve()),
  markRead: jest.fn(() => Promise.resolve()),
  mute: jest.fn(() => Promise.resolve()),
  leave: jest.fn(() => Promise.resolve()),
  retryCommand: jest.fn(() => Promise.resolve()),
  recoverOwnSend: jest.fn(() => Promise.resolve()),
};
jest.mock('./use-conversations-session', () => ({
  useConversationsSession: () => ({ session: mockSession, state: mockState }),
  conversationOffset: () => 0,
  retainConversationOffset: jest.fn(),
}));
const id = (n: number) => `0199c000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ref = { conversationId: id(4), membershipId: id(5), membershipRevision: 1 };
const peer = { kind: 'person' as const, personId: id(6), handle: 'peer.fixture', displayName: 'Peer fixture' };
const account = () =>
  createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'ui-fixture@example.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: () => Promise.reject(new Error('No fixture transport')),
  });
const empty = (): ConversationsState => ({
  status: 'active',
  focused: true,
  inbox: { status: 'idle' },
  windows: [],
  drafts: [],
  command: { status: 'idle' },
  recovery: { status: 'idle' },
  mutationBlocked: false,
});
const ready = (): ConversationsState => ({
  ...empty(),
  windows: [
    {
      conversation: ref,
      status: 'ready',
      peer,
      own: { muted: false, readThroughSequence: 0 },
      latestMessageSequence: 1,
      messages: [
        {
          status: 'available',
          messageId: id(7),
          sequence: 1,
          author: peer,
          recordedAt: '2026-10-23T00:00:00.000Z',
          body: { kind: 'text', text: 'Real fixture body' },
        },
      ],
      historyAvailable: true,
      catchUp: 'available',
    },
  ],
});
beforeEach(() => {
  jest.clearAllMocks();
  mockState = ready();
});
it('requires current selection for a deep link and never invents membership authority', async () => {
  const scope = account();
  mockState = empty();
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={id(98)} />
    </DisplayProvider>,
  );
  expect(screen.getByText('Choose a current conversation')).toBeTruthy();
  expect(mockSession.open).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Message text')).toBeNull();
  await act(() => scope.end());
});
it('keeps ambiguous send read/retry explicit and does not resend or mark unseen messages on render', async () => {
  const scope = account();
  mockState = {
    ...ready(),
    command: { status: 'unknown', operation: 'send', commandId: id(9) },
    mutationBlocked: true,
    drafts: [{ conversation: ref, body: { kind: 'text', text: 'Unconfirmed fixture' } }],
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  expect(screen.getByLabelText('Message text').props.editable).toBe(false);
  expect(mockSession.send).not.toHaveBeenCalled();
  expect(mockSession.markRead).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Check prior send' }));
  expect(mockSession.recoverOwnSend).toHaveBeenCalledWith(ref);
  await fireEvent.press(screen.getByRole('button', { name: 'Retry same request' }));
  expect(mockSession.retryCommand).toHaveBeenCalledTimes(1);
  await act(() => scope.end());
  expect(screen.queryByText('Real fixture body')).toBeNull();
  expect(screen.queryByLabelText('Message text')).toBeNull();
});
it('removes composer and cached private bodies when current membership is unavailable', async () => {
  const scope = account();
  mockState = { ...ready(), windows: [{ ...ready().windows[0]!, status: 'unavailable', messages: [] }] };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  expect(screen.queryByText('Real fixture body')).toBeNull();
  expect(screen.queryByLabelText('Message text')).toBeNull();
  expect(screen.getByText('This conversation is unavailable. Refresh to check current access.')).toBeTruthy();
  await act(() => scope.end());
});
it('renders unavailable markers without old author or body and never labels peer messages Sent', async () => {
  await render(
    <DisplayProvider value={{}}>
      <ConversationMessage message={{ status: 'unavailable', messageId: id(8), sequence: 1 }} own onOpen={jest.fn()} />
    </DisplayProvider>,
  );
  expect(screen.getByText('Message unavailable')).toBeTruthy();
  expect(screen.queryByText('You')).toBeNull();
  expect(screen.queryByText('Sent')).toBeNull();
});
it('keeps unavailable own-send recovery uncertain and never starts a replacement send', async () => {
  const scope = account();
  mockState = {
    ...ready(),
    command: { status: 'unknown', operation: 'send', commandId: id(9) },
    mutationBlocked: true,
    recovery: {
      status: 'ready',
      data: {
        version: 'direct-conversation.v1',
        readId: id(12),
        scope: { accountId: id(1), privacyEpoch: 1 },
        status: 'unavailable',
        selector: { kind: 'command', commandId: id(9) },
      },
    },
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  expect(screen.getByText('The prior send is unavailable. That does not mean it wasn’t sent.')).toBeTruthy();
  expect(mockSession.send).not.toHaveBeenCalled();
  await act(() => scope.end());
});
it('uses explicit original/current canonical targets for correction and marks only actual own bodies Sent', async () => {
  const open = jest.fn();
  const original = { assetId: id(30), assetRevision: 1 };
  const current = {
    assetId: id(30),
    assetRevision: 2,
    metadata: { kind: 'scroll' as const, title: 'Updated fixture', summary: 'Fixture only', language: 'en' },
  };
  await render(
    <DisplayProvider value={{}}>
      <ConversationMessage
        own={false}
        message={{
          status: 'available',
          messageId: id(31),
          sequence: 2,
          author: peer,
          recordedAt: '2026-10-23T00:00:00.000Z',
          body: { kind: 'content', content: { status: 'corrected', target: original, current } },
        }}
        onOpen={open}
      />
    </DisplayProvider>,
  );
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByText('Sent')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Open original version' }));
  expect(open).toHaveBeenLastCalledWith(original);
  await fireEvent.press(screen.getByRole('button', { name: 'Open updated version' }));
  expect(open).toHaveBeenLastCalledWith(current);
});
