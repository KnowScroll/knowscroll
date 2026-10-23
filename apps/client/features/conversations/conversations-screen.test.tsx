import type * as React from 'react';
import type * as ConversationOwner from './use-conversations-session';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { createAccountScope, memoryStore, type AccountScope, type ConversationsState } from '@knowscroll/client-core';
import { SignedInConversations } from './conversations-screen';

// UI fixtures only: source controllers/transport have their own real-adapter fixture lane.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<typeof React>('react').useEffect(effect, [effect]),
}));
jest.mock('../shell/screen-frame', () => ({ ScreenFrame: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../friends/use-friends-session', () => ({ useFriendsSession: () => undefined }));
let mockState: ConversationsState;
let mockActualOwner = false;
const mockSession = {
  refreshInbox: jest.fn(() => Promise.resolve()),
  nextInbox: jest.fn(() => Promise.resolve()),
  open: jest.fn(() => Promise.resolve()),
  start: jest.fn(() => Promise.resolve()),
  retryCommand: jest.fn(() => Promise.resolve()),
};
jest.mock('./use-conversations-session', () => ({
  useConversationsSession: (scope: AccountScope) =>
    mockActualOwner
      ? jest.requireActual<typeof ConversationOwner>('./use-conversations-session').useConversationsSession(scope)
      : { session: mockSession, state: mockState },
}));
const id = (n: number) => `0199b000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = () =>
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
  inbox: {
    status: 'ready',
    data: {
      version: 'direct-conversation.v1',
      readId: id(3),
      scope: { accountId: id(1), privacyEpoch: 1 },
      status: 'ready',
      limit: 50,
      viewRevision: 1,
      items: [],
      continuation: { kind: 'end' },
    },
  },
  windows: [],
  drafts: [],
  command: { status: 'idle' },
  recovery: { status: 'idle' },
  mutationBlocked: false,
});
beforeEach(() => {
  jest.clearAllMocks();
  mockState = empty();
  mockActualOwner = false;
});
it('keeps empty-more distinct from no conversations and advances only deliberately', async () => {
  const account = scope();
  const state = empty();
  if (state.inbox.status !== 'ready' || state.inbox.data.status !== 'ready') throw new Error('fixture');
  mockState = {
    ...state,
    inbox: {
      status: 'ready',
      data: { ...state.inbox.data, continuation: { kind: 'more', cursor: `kci1_${'A'.repeat(43)}` } },
    },
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversations scope={account} />
    </DisplayProvider>,
  );
  expect(screen.getByText('No conversations in this part of the list. More can be checked.')).toBeTruthy();
  expect(mockSession.nextInbox).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'More conversations' }));
  expect(mockSession.nextInbox).toHaveBeenCalledTimes(1);
  expect(mockSession.start).not.toHaveBeenCalled();
  await act(() => account.end());
});
it('does not replace an unknown start with another command and exposes exact retry', async () => {
  const account = scope();
  mockState = {
    ...empty(),
    command: { status: 'unknown', operation: 'start', commandId: id(9) },
    mutationBlocked: true,
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversations scope={account} />
    </DisplayProvider>,
  );
  expect(screen.getByRole('button', { name: 'New message' }).props.accessibilityState).toMatchObject({
    disabled: true,
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Retry same request' }));
  expect(mockSession.retryCommand).toHaveBeenCalledTimes(1);
  expect(mockSession.start).not.toHaveBeenCalled();
  await act(() => account.end());
});
it('retains one owner per actual scope object across view detours, then preserves only an ended empty owner', async () => {
  const actual = jest.requireActual<typeof ConversationOwner>('./use-conversations-session');
  const first = scope(),
    sameAccountNewObject = scope();
  const session = actual.conversationsFor(first);
  expect(actual.conversationsFor(first)).toBe(session);
  expect(actual.conversationsFor(sameAccountNewObject)).not.toBe(session);
  actual.retainConversationOffset(first, 'fixture-current-membership', 120);
  expect(actual.conversationOffset(first, 'fixture-current-membership')).toBe(120);
  await act(() => first.end());
  expect(actual.conversationOffset(first, 'fixture-current-membership')).toBe(0);
  expect(actual.conversationsFor(first)).toBe(session);
  expect(session.getState().status).toBe('ended');
  expect(session.getState().windows).toEqual([]);
  expect(session.getState().drafts).toEqual([]);
  await act(() => sameAccountNewObject.end());
});

it('renders a signed-in empty inbox only after a real scoped contract read returns available-empty', async () => {
  mockActualOwner = true;
  const account = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'empty-inbox@fixture.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      if (new URL(request.url).pathname !== '/v1/social/conversations/inbox')
        throw new Error('Unexpected empty inbox fixture request');
      const body = (await request.json()) as { readId: string; limit: number };
      return new Response(
        JSON.stringify({
          version: 'direct-conversation.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          readId: body.readId,
          limit: body.limit,
          viewRevision: 0,
          status: 'ready',
          items: [],
          continuation: { kind: 'end' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversations scope={account} />
    </DisplayProvider>,
  );
  expect(await screen.findByText('No conversations yet')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New message' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Share something' })).toBeTruthy();
  await act(() => account.end());
  expect(screen.queryByText('No conversations yet')).toBeNull();
});
