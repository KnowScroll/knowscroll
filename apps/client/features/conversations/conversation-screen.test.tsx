import type * as React from 'react';
import type * as ConversationOwner from './use-conversations-session';
import {
  ConversationInboxSchema,
  DirectConversationSnapshotSchema,
  ReadConversationInboxSchema,
  ReadDirectConversationSchema,
  SendConversationMessageSchema,
  type DirectConversationRef,
} from '@knowscroll/contracts';
import type { AccountScope } from '@knowscroll/client-core';
import { harness } from '../encounter/encounter-session.fixture';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { createAccountScope, memoryStore, type ConversationsState } from '@knowscroll/client-core';
import { SignedInConversation } from './conversation-screen';
import { ConversationMessage } from './conversation-message';

// Finite, unique SDK primitive stand-ins only; the native command-id producer remains real.
jest.mock('expo-crypto', () => {
  const ids = Array.from({ length: 256 }, (_, i) => `0199f000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  let next = 0;
  return {
    randomUUID: jest.fn(() => {
      const value = ids[next++];
      if (!value) throw new Error('SDK UUID fixture exhausted');
      return value;
    }),
  };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: mockBack, canGoBack: () => true }),
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<typeof React>('react').useEffect(effect, [effect]),
}));
jest.mock('../shell/screen-frame', () => ({ ScreenFrame: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('../friends/use-friends-session', () => ({ useFriendsSession: () => undefined }));
const mockPush = jest.fn(),
  mockReplace = jest.fn(),
  mockBack = jest.fn();
let mockActualOwner = false;
const mockOpenContent = jest.fn((_target: { assetId: string; assetRevision: number }, _return: () => void) => true);
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
  useConversationsSession: (scope: AccountScope) =>
    mockActualOwner
      ? jest.requireActual<typeof ConversationOwner>('./use-conversations-session').useConversationsSession(scope)
      : { session: mockSession, state: mockState },
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
  inbox: {
    status: 'ready',
    data: {
      version: 'direct-conversation.v1',
      readId: id(11),
      scope: { accountId: id(1), privacyEpoch: 1 },
      status: 'ready',
      viewRevision: 1,
      limit: 20,
      items: [
        {
          conversation: {
            ...ref,
            conversationId: ref.conversationId.toUpperCase(),
            membershipId: ref.membershipId.toUpperCase(),
          },
          peer,
          own: { muted: false, readThroughSequence: 0 },
          latestMessageSequence: 0,
        },
      ],
      continuation: { kind: 'end' },
    },
  },
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
  mockActualOwner = false;
  mockOpenContent.mockImplementation(() => true);
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

it('opens current inbox membership over retained unavailable ABA membership with semantic UUID matching and keeps the old unknown command', async () => {
  mockActualOwner = true;
  const nextRef: DirectConversationRef = { ...ref, membershipId: id(50), membershipRevision: 1 };
  const upper = (value: DirectConversationRef): DirectConversationRef => ({
    ...value,
    conversationId: value.conversationId.toUpperCase(),
    membershipId: value.membershipId.toUpperCase(),
  });
  let replacement = false;
  const reads: DirectConversationRef[] = [];
  const sends: unknown[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'aba-detail@fixture.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      expect(request.headers.get('x-ks-scope')).toBe(scope.id);
      const path = new URL(request.url).pathname;
      const raw: unknown = await request.json();
      const common = { version: 'direct-conversation.v1', scope: { accountId: id(1), privacyEpoch: 1 } };
      if (path.endsWith('/inbox')) {
        const input = ReadConversationInboxSchema.parse(raw);
        return json({
          ...common,
          ...input,
          status: 'ready',
          viewRevision: replacement ? 2 : 1,
          items: [
            {
              conversation: replacement ? upper(nextRef) : ref,
              peer,
              own: { muted: false, readThroughSequence: 0 },
              latestMessageSequence: 0,
            },
          ],
          continuation: { kind: 'end' },
        });
      }
      if (path.endsWith('/read')) {
        const input = ReadDirectConversationSchema.parse(raw);
        reads.push(input.conversation);
        if (replacement && input.conversation.membershipId.toLowerCase() === ref.membershipId)
          return json({ ...common, readId: input.readId, status: 'unavailable' });
        return json({
          ...common,
          ...input,
          conversation: replacement ? nextRef : ref,
          status: 'ready',
          peer: { ...peer, displayName: replacement ? 'New current participation' : 'Old participation' },
          own: { muted: false, readThroughSequence: 0 },
          latestMessageSequence: 0,
          messages: [],
          history: { kind: 'end' },
          catchUpCursor: `kcc1_${'A'.repeat(43)}`,
        });
      }
      if (path.endsWith('/send')) {
        sends.push(SendConversationMessageSchema.parse(raw));
        throw new Error('Authored ambiguous old command');
      }
      throw new Error('Unexpected ABA fixture endpoint');
    },
  });
  const owner = jest.requireActual<typeof ConversationOwner>('./use-conversations-session').conversationsFor(scope);
  await owner.refreshInbox();
  await owner.open(ref);
  owner.setDraft(ref, { kind: 'text', text: 'Original old-membership command' });
  await owner.send(ref);
  const original = owner.getState().command;
  expect(original.status).toBe('unknown');
  replacement = true;
  await owner.open(ref);
  expect(owner.getState().windows[0]!.status).toBe('unavailable');
  await owner.refreshInbox();
  // Final core focus independently rechecks the selected old membership before inbox.
  // Settle that prerequisite before measuring the UI's exact new-membership Open.
  owner.focus(true);
  await waitFor(() => expect(scope.queryClient.isFetching()).toBe(0));
  reads.length = 0;
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId.toUpperCase()} />
    </DisplayProvider>,
  );
  await screen.findByText('New current participation');
  expect(reads).toEqual([upper(nextRef)]);
  expect(owner.getState().windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ conversation: ref, status: 'unavailable' }),
      expect.objectContaining({ conversation: nextRef, status: 'ready' }),
    ]),
  );
  expect(owner.getState().command).toEqual(original);
  expect(owner.getState().mutationBlocked).toBe(true);
  expect(screen.getByLabelText('Message text').props.editable).toBe(false);
  expect(screen.queryByText('This conversation is unavailable. Refresh to check current access.')).toBeNull();
  expect(sends).toHaveLength(1);
  await act(() => scope.end());
  expect(owner.getState()).toMatchObject({ status: 'ended', windows: [], drafts: [], command: { status: 'idle' } });
});
it('does not route detail after a real opening subscriber ends the scope, or resurrect its return callback', async () => {
  const h = harness();
  mockOpenContent.mockImplementation((target, returned) => h.session.openConversationContent(target, returned));
  const readyWindow = ready().windows[0]!;
  mockState = {
    ...ready(),
    windows: [
      {
        ...readyWindow,
        messages: [
          {
            status: 'available',
            messageId: id(31),
            sequence: 1,
            author: peer,
            recordedAt: '2026-10-23T00:00:00.000Z',
            body: {
              kind: 'content',
              content: {
                status: 'corrected',
                target: { assetId: id(30), assetRevision: 1 },
                current: {
                  assetId: id(30),
                  assetRevision: 2,
                  metadata: {
                    kind: 'reel',
                    title: 'Corrected detail fixture',
                    summary: 'Fixture only',
                    language: 'en',
                  },
                },
              },
            },
          },
        ],
      },
    ],
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={h.scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  h.session.subscribe(() => {
    if (h.session.getState().phase === 'opening') h.scope.end();
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Open updated version' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
  expect(h.session.back()).toBe(false);
  expect(h.session.getState().phase).toBe('revoked');
  expect(h.calls.filter((call) => call.path.endsWith('/open') || call.path.endsWith('/activate'))).toHaveLength(0);
});
it('matches mixed-case current window and draft UUIDs without borrowing another membership revision', async () => {
  const scope = account();
  mockState = {
    ...ready(),
    windows: [
      {
        ...ready().windows[0]!,
        conversation: {
          ...ref,
          conversationId: ref.conversationId.toUpperCase(),
          membershipId: ref.membershipId.toUpperCase(),
        },
      },
    ],
    drafts: [
      { conversation: ref, body: { kind: 'text', text: 'Exact semantic UUID draft' } },
      { conversation: { ...ref, membershipRevision: 2 }, body: { kind: 'text', text: 'Different revision draft' } },
    ],
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  expect(screen.getByLabelText('Message text').props.value).toBe('Exact semantic UUID draft');
  expect(mockSession.open).toHaveBeenCalledWith(mockState.windows[0]!.conversation);
  await act(() => scope.end());
});
it('rechecks the detail UI scope after a successful delegated Open before routing', async () => {
  const h = harness();
  mockOpenContent.mockImplementation((target, returned) => {
    const admitted = h.session.openConversationContent(target, returned);
    h.scope.end();
    return admitted;
  });
  mockState = {
    ...ready(),
    windows: [
      {
        ...ready().windows[0]!,
        messages: [
          {
            status: 'available',
            messageId: id(31),
            sequence: 1,
            author: peer,
            recordedAt: '2026-10-23T00:00:00.000Z',
            body: {
              kind: 'content',
              content: {
                status: 'available',
                target: { assetId: id(30), assetRevision: 1 },
                metadata: { kind: 'reel', title: 'Post-call fence fixture', summary: 'Fixture only', language: 'en' },
              },
            },
          },
        ],
      },
    ],
  };
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={h.scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Open Reel' }));
  expect(mockPush).not.toHaveBeenCalled();
  expect(h.session.back()).toBe(false);
});

it('lets actual final-core focus and resync finish a held inbox without automatic replacement from loading', async () => {
  mockActualOwner = true;
  const reads: { conversation: DirectConversationRef; readId: string; scopeHeader: string | null }[] = [];
  const inboxes: { signal: AbortSignal; readId: string; scopeHeader: string | null }[] = [];
  const unexpected: string[] = [];
  let holdInbox = false;
  const held: (() => void)[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'held-inbox@fixture.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const raw: unknown = await request.json();
      const common = { version: 'direct-conversation.v1', scope: { accountId: id(1), privacyEpoch: 1 } };
      if (path.endsWith('/inbox')) {
        const input = ReadConversationInboxSchema.parse(raw);
        inboxes.push({ signal: request.signal, readId: input.readId, scopeHeader: request.headers.get('x-ks-scope') });
        const response = () =>
          json(
            ConversationInboxSchema.parse({
              ...common,
              ...input,
              status: 'ready',
              viewRevision: 1,
              items: [
                { conversation: ref, peer, own: { muted: false, readThroughSequence: 0 }, latestMessageSequence: 0 },
              ],
              continuation: { kind: 'end' },
            }),
          );
        if (holdInbox) return new Promise<Response>((resolve) => held.push(() => resolve(response())));
        return response();
      }
      if (path.endsWith('/read')) {
        const input = ReadDirectConversationSchema.parse(raw);
        reads.push({
          conversation: input.conversation,
          readId: input.readId,
          scopeHeader: request.headers.get('x-ks-scope'),
        });
        return json(
          DirectConversationSnapshotSchema.parse({
            ...common,
            ...input,
            status: 'ready',
            peer,
            own: { muted: false, readThroughSequence: 0 },
            latestMessageSequence: 0,
            messages: [],
            history: { kind: 'end' },
            catchUpCursor: `kcc1_${'A'.repeat(43)}`,
          }),
        );
      }
      unexpected.push(path);
      throw new Error('Unexpected held inbox fixture endpoint');
    },
  });
  const owner = jest.requireActual<typeof ConversationOwner>('./use-conversations-session').conversationsFor(scope);
  await owner.refreshInbox();
  await owner.open(ref);
  owner.focus(true);
  await waitFor(() => expect(scope.queryClient.isFetching()).toBe(0));
  await render(
    <DisplayProvider value={{}}>
      <SignedInConversation scope={scope} conversationId={ref.conversationId} />
    </DisplayProvider>,
  );
  await waitFor(() => expect(owner.getState().windows[0]!.status).toBe('ready'));
  for (const cause of ['focus', 'resync'] as const) {
    holdInbox = true;
    const previousHeld = held.length;
    await act(() => {
      if (cause === 'focus') {
        owner.focus(false);
        owner.focus(true);
      } else void scope.queryClient.invalidateQueries();
    });
    await waitFor(() => expect(held).toHaveLength(previousHeld + 1));
    const pending = inboxes.at(-1)!;
    const readsWhileHeld = reads.length;
    await act(async () => {
      await Promise.resolve();
    });
    expect(owner.getState().inbox.status).toBe('loading');
    expect(pending.signal.aborted).toBe(false);
    expect(reads).toHaveLength(readsWhileHeld);
    expect(owner.getState().windows[0]!.status).toBe('ready');
    expect(owner.getState().command).toEqual({ status: 'idle' });
    holdInbox = false;
    await act(() => held[previousHeld]!());
    await waitFor(() => expect(owner.getState().inbox.status).toBe('ready'));
    await waitFor(() => expect(owner.getState().windows[0]!.status).toBe('ready'));
    await waitFor(() => expect(scope.queryClient.isFetching()).toBe(0));
    const inbox = owner.getState().inbox;
    expect(inbox).toMatchObject({ status: 'ready', data: { readId: pending.readId, items: [{ conversation: ref }] } });
    expect(pending.scopeHeader).toBe(scope.id);
    expect(owner.getState().command).toEqual({ status: 'idle' });
  }
  expect(reads.every((read) => JSON.stringify(read.conversation) === JSON.stringify(ref))).toBe(true);
  expect(reads.every((read) => read.scopeHeader === scope.id)).toBe(true);
  expect(new Set([...reads.map((read) => read.readId), ...inboxes.map((read) => read.readId)]).size).toBe(
    reads.length + inboxes.length,
  );
  expect(unexpected).toEqual([]);
  await act(() => scope.end());
  expect(owner.getState()).toMatchObject({ status: 'ended', windows: [], drafts: [] });
});
