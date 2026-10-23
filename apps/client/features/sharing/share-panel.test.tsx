import type * as React from 'react';
import type * as ConversationOwner from '../conversations/use-conversations-session';
import type * as EncounterOwner from '../encounter/use-encounter-session';
import {
  OpenRevisitRequestSchema,
  ReadConversationInboxSchema,
  ReadDirectConversationSchema,
  SendConversationMessageSchema,
  type DirectConversationRef,
} from '@knowscroll/contracts';
import type { AccountScope } from '@knowscroll/client-core';
import { PrivateShareScreen } from './private-share-screen';
import { ConversationMessage } from '../conversations/conversation-message';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { DisplayProvider } from '@knowscroll/ui';
import {
  createAccountScope,
  memoryStore,
  type ContentSharesState,
  type ConversationsState,
} from '@knowscroll/client-core';
import { SignedInSharePanel } from './share-panel';
import { harness } from '../encounter/encounter-session.fixture';

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
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<typeof React>('react').useEffect(effect, [effect]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('../../platform/api', () => ({ appApiOrigin: () => ({ ok: true, baseUrl: 'https://fixture.invalid' }) }));
const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockActualOwner = false;
let mockEncounter: ReturnType<typeof harness>['session'] | undefined;
jest.mock('../encounter/use-encounter-session', () => ({
  encounterSessionFor: (scope: AccountScope) =>
    mockEncounter ??
    jest.requireActual<typeof EncounterOwner>('../encounter/use-encounter-session').encounterSessionFor(scope),
}));
let mockTalkState: ConversationsState;
let mockShareState: ContentSharesState;
const mockConversations = {
  open: jest.fn((_ref: DirectConversationRef) => Promise.resolve()),
  refreshInbox: jest.fn(() => Promise.resolve()),
  nextInbox: jest.fn(() => Promise.resolve()),
  setDraft: jest.fn(
    (_conversation: typeof ref, _body: NonNullable<ConversationsState['drafts'][number]>['body']) => undefined,
  ),
  send: jest.fn(() => Promise.resolve()),
  retryCommand: jest.fn(() => Promise.resolve()),
  recoverOwnSend: jest.fn(() => Promise.resolve()),
  getState: () => mockTalkState,
};
const mockShares = {
  create: jest.fn(() => Promise.resolve()),
  readOwn: jest.fn(() => Promise.resolve()),
  resolve: jest.fn(() => Promise.resolve()),
  revoke: jest.fn(() => Promise.resolve()),
  retryCommand: jest.fn(() => Promise.resolve()),
  takeToken: jest.fn(() => `kssh_${'A'.repeat(43)}`),
  getState: () => mockShareState,
};
jest.mock('../conversations/use-conversations-session', () => ({
  useConversationsSession: (scope: AccountScope) =>
    mockActualOwner
      ? jest
          .requireActual<typeof ConversationOwner>('../conversations/use-conversations-session')
          .useConversationsSession(scope)
      : { session: mockConversations, state: mockTalkState },
  conversationsFor: (scope: AccountScope) =>
    jest.requireActual<typeof ConversationOwner>('../conversations/use-conversations-session').conversationsFor(scope),
}));
jest.mock('./use-share-session', () => ({ useShareSession: () => ({ session: mockShares, state: mockShareState }) }));
const id = (n: number) => `0199d000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const target = { assetId: id(9), assetRevision: 2 };
const ref = { conversationId: id(4), membershipId: id(5), membershipRevision: 1 };
const own = {
  version: 'content-share.v1' as const,
  readId: id(10),
  scope: { accountId: id(1), privacyEpoch: 1 },
  status: 'available' as const,
  selector: { kind: 'share' as const, shareId: id(8) },
  shareId: id(8),
  target,
  audience: { kind: 'public_metadata' as const },
  state: 'active' as const,
  expiresAt: '2026-10-30T00:00:00.000Z',
};
const account = () =>
  createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'share-ui@example.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: () => Promise.reject(new Error('No UI transport')),
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockActualOwner = false;
  mockEncounter = undefined;
  mockConversations.open.mockImplementation((conversation) => {
    mockTalkState = {
      ...mockTalkState,
      windows: [
        {
          conversation,
          status: 'ready',
          latestMessageSequence: 0,
          messages: [],
          historyAvailable: false,
          catchUp: 'available',
        },
      ],
    };
    return Promise.resolve();
  });
  mockShares.readOwn.mockImplementation(() => Promise.resolve());
  mockConversations.setDraft.mockImplementation((conversation, body) => {
    mockTalkState = { ...mockTalkState, drafts: [{ conversation, body }] };
  });
  mockTalkState = {
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
        items: [
          {
            conversation: ref,
            peer: { kind: 'person', personId: id(6), handle: 'peer.fixture', displayName: 'Peer fixture' },
            own: { muted: false, readThroughSequence: 0 },
            latestMessageSequence: 0,
          },
        ],
        continuation: { kind: 'end' },
      },
    },
    windows: [],
    drafts: [],
    command: { status: 'idle' },
    recovery: { status: 'idle' },
    mutationBlocked: false,
  };
  mockShareState = {
    status: 'active',
    own: { status: 'idle' },
    resolved: { status: 'idle' },
    command: { status: 'idle' },
    tokenAvailable: false,
    mutationBlocked: false,
  };
});
it('sends only on deliberate selected conversation send and does not confuse copying with delivery', async () => {
  const scope = account();
  await render(
    <DisplayProvider value={{}}>
      <SignedInSharePanel scope={scope} target={target} title="Authored fixture" onClose={jest.fn()} />
    </DisplayProvider>,
  );
  expect(mockConversations.send).not.toHaveBeenCalled();
  expect(mockShares.create).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Peer fixture' }));
  await fireEvent.changeText(screen.getByLabelText('Optional share note'), 'A deliberate note');
  await fireEvent.press(screen.getByRole('button', { name: 'Send to selected conversation' }));
  expect(mockConversations.setDraft).toHaveBeenCalledWith(ref, { kind: 'content', target, note: 'A deliberate note' });
  expect(mockConversations.send).toHaveBeenCalledWith(ref);
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  await act(() => scope.end());
});
it('consumes secret delivery once only after a fresh own read; lost delivery never creates a new link', async () => {
  const scope = account();
  mockShareState = { ...mockShareState, own: { status: 'ready', data: own }, tokenAvailable: true };
  await render(
    <DisplayProvider value={{}}>
      <SignedInSharePanel scope={scope} target={target} title="Authored fixture" onClose={jest.fn()} />
    </DisplayProvider>,
  );
  expect(screen.queryByText(`kssh_${'A'.repeat(43)}`)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Copy link once' }));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1));
  expect(mockShares.readOwn).toHaveBeenCalledWith({ kind: 'share', shareId: own.shareId });
  expect(mockShares.takeToken).toHaveBeenCalledTimes(1);
  expect(mockShares.create).not.toHaveBeenCalled();
  expect(screen.getByText('Link copied. External copies can’t be recalled.')).toBeTruthy();
  await act(() => scope.end());
});
it('fences a late copy continuation and purges controlled note on scope end', async () => {
  const scope = account();
  let release!: () => void;
  mockShares.readOwn.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  mockShareState = { ...mockShareState, own: { status: 'ready', data: own }, tokenAvailable: true };
  await render(
    <DisplayProvider value={{}}>
      <SignedInSharePanel scope={scope} target={target} title="Authored fixture" onClose={jest.fn()} />
    </DisplayProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Optional share note'), 'Private local draft');
  await fireEvent.press(screen.getByRole('button', { name: 'Copy link once' }));
  await act(() => scope.end());
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(mockShares.takeToken).not.toHaveBeenCalled();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Optional share note')).toBeNull();
});

// Real AccountScope/encounter controller + authored HTTP fixture; no media/provider runtime claim.
async function readyEncounter() {
  const h = harness();
  h.session.setForeground(true);
  h.session.open({ kind: 'discover' });
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  const entry = h.session.getState().entry!;
  h.session.mount(entry);
  return { h, entry };
}
it('parks before opening Share and consumes prior playing intent exactly once on deliberate close', async () => {
  const { h, entry } = await readyEncounter();
  const pause = jest.fn();
  entry.surface = { capture: () => ({ kind: 'reel', positionMs: 12000, playing: true, muted: true }), pause };
  const before = h.calls.filter((c) => c.path.endsWith('/open') || c.path.endsWith('/activate')).length;
  expect(h.session.openShare()).toBe(true);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(entry.position).toMatchObject({ positionMs: 12000, playing: true, muted: true });
  h.session.setOverlay(false);
  expect(h.session.consumeShareResume(entry)).toBe(true);
  expect(h.session.consumeShareResume(entry)).toBe(false);
  expect(h.calls.filter((c) => c.path.endsWith('/open') || c.path.endsWith('/activate'))).toHaveLength(before);
  h.scope.end();
});
it('never grants share-close resume after background or scope end, and never for a paused source', async () => {
  const { h, entry } = await readyEncounter();
  entry.surface = {
    capture: () => ({ kind: 'reel', positionMs: 5000, playing: true, muted: false }),
    pause: jest.fn(),
  };
  h.session.openShare();
  h.session.setForeground(false);
  h.session.setForeground(true);
  h.session.setOverlay(false);
  expect(h.session.consumeShareResume(entry)).toBe(false);
  entry.surface = {
    capture: () => ({ kind: 'reel', positionMs: 5000, playing: false, muted: false }),
    pause: jest.fn(),
  };
  h.session.openShare();
  h.session.setOverlay(false);
  expect(h.session.consumeShareResume(entry)).toBe(false);
  entry.surface = {
    capture: () => ({ kind: 'reel', positionMs: 5000, playing: true, muted: false }),
    pause: jest.fn(),
  };
  h.session.openShare();
  h.scope.end();
  h.session.setOverlay(false);
  expect(h.session.consumeShareResume(entry)).toBe(false);
});
it('never sends an older conversation draft when a new content draft is refused', async () => {
  const scope = account();
  mockTalkState = {
    ...mockTalkState,
    drafts: [{ conversation: ref, body: { kind: 'text', text: 'Unrelated earlier draft' } }],
  };
  mockConversations.setDraft.mockImplementation(() => undefined);
  await render(
    <DisplayProvider value={{}}>
      <SignedInSharePanel scope={scope} target={target} title="Authored fixture" onClose={jest.fn()} />
    </DisplayProvider>,
  );
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Peer fixture' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Send to selected conversation' }));
  expect(mockConversations.send).not.toHaveBeenCalled();
  expect(
    screen.getByText('This share draft couldn’t be prepared. Check current conversation status before trying again.'),
  ).toBeTruthy();
  await act(() => scope.end());
});
it('does not transfer share-close playback intent into a newly opened canonical target', async () => {
  const { h, entry } = await readyEncounter();
  entry.surface = {
    capture: () => ({ kind: 'reel', positionMs: 5000, playing: true, muted: false }),
    pause: jest.fn(),
  };
  h.session.openShare();
  const before = h.session.getState().shareResumeRevision ?? 0;
  expect(h.session.openConversationContent({ assetId: id(99), assetRevision: 1 }, jest.fn())).toBe(true);
  h.session.setOverlay(false);
  expect(h.session.getState().shareResumeRevision ?? 0).toBe(before);
  expect(h.session.consumeShareResume(entry)).toBe(false);
  h.scope.end();
});

// Actual AccountScope -> native UUID producer -> core -> strict HTTP contracts. No live Social data.
function actualTalkFixture(
  options: {
    snapshot?: (
      body: ReturnType<typeof ReadDirectConversationSchema.parse>,
    ) => Promise<Record<string, unknown> | undefined>;
    unknownSend?: boolean;
  } = {},
) {
  const other = { conversationId: id(14), membershipId: id(15), membershipRevision: 1 };
  const refs = [ref, other];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'actual-share@fixture.test' },
    baseUrl: 'https://fixture.invalid',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      expect(request.headers.get('x-ks-scope')).toBe(scope.id);
      const path = new URL(request.url).pathname;
      const raw: unknown = await request.json();
      const scopeClaim = { accountId: id(1), privacyEpoch: 1 };
      if (path.endsWith('/inbox')) {
        const body = ReadConversationInboxSchema.parse(raw);
        calls.push({ path, body });
        return json({
          ...body,
          scope: scopeClaim,
          status: 'ready',
          viewRevision: 1,
          items: refs.map((conversation, index) => ({
            conversation,
            peer: {
              kind: 'person',
              personId: id(6 + index),
              handle: `peer${index}.fixture`,
              displayName: `Actual peer ${index}`,
            },
            own: { muted: false, readThroughSequence: 0 },
            latestMessageSequence: 0,
          })),
          continuation: { kind: 'end' },
        });
      }
      if (path.endsWith('/read')) {
        const body = ReadDirectConversationSchema.parse(raw);
        calls.push({ path, body });
        const override = await options.snapshot?.(body);
        return json(
          override ?? {
            ...body,
            scope: scopeClaim,
            status: 'ready',
            peer: { kind: 'person', personId: id(6), handle: 'peer.fixture', displayName: 'Snapshot peer' },
            own: { muted: false, readThroughSequence: 0 },
            latestMessageSequence: 0,
            messages: [],
            history: { kind: 'end' },
            catchUpCursor: `kcc1_${'A'.repeat(43)}`,
          },
        );
      }
      if (path.endsWith('/send')) {
        const body = SendConversationMessageSchema.parse(raw);
        calls.push({ path, body });
        if (options.unknownSend) throw new Error('Authored ambiguous transport outcome');
        return json({
          version: body.version,
          scope: scopeClaim,
          commandId: body.commandId,
          recordedAt: '2026-10-23T00:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'message.send',
          conversation: body.conversation,
          messageId: id(70),
          messageSequence: 1,
          sent: body.body.kind === 'content' ? { kind: 'content', target: body.body.target } : { kind: 'text' },
        });
      }
      throw new Error('Unexpected actual Share fixture endpoint');
    },
  });
  const owner = jest
    .requireActual<typeof ConversationOwner>('../conversations/use-conversations-session')
    .conversationsFor(scope);
  return { scope, owner, other, calls };
}
async function renderActualShare(f: ReturnType<typeof actualTalkFixture>) {
  mockActualOwner = true;
  await render(
    <DisplayProvider value={{}}>
      <SignedInSharePanel scope={f.scope} target={target} title="Actual core fixture" onClose={jest.fn()} />
    </DisplayProvider>,
  );
  await screen.findByRole('togglebutton', { name: 'Actual peer 0' });
}
it('reads the exact selected snapshot from a fresh Explore owner before preparing and sending content', async () => {
  const f = actualTalkFixture();
  await renderActualShare(f);
  expect(f.owner.getState().windows).toEqual([]);
  expect(f.owner.getState().drafts).toEqual([]);
  expect(screen.getByRole('togglebutton', { name: 'Actual peer 0', checked: false })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState).toMatchObject({
    disabled: true,
  });
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Actual peer 0' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState,
    ).toMatchObject({ disabled: false }),
  );
  expect(screen.getByRole('togglebutton', { name: 'Actual peer 0', checked: true })).toBeTruthy();
  expect(f.calls.filter((call) => call.path.endsWith('/read')).map((call) => call.body.conversation)).toEqual([ref]);
  expect(f.owner.getState().drafts).toEqual([]);
  expect(f.calls.filter((call) => call.path.endsWith('/send'))).toHaveLength(0);
  await fireEvent.changeText(screen.getByLabelText('Optional share note'), 'Deliberate content note');
  await fireEvent.press(screen.getByRole('button', { name: 'Send to selected conversation' }));
  await waitFor(() => expect(f.owner.getState().command.status).toBe('accepted'));
  const sent = f.calls.filter((call) => call.path.endsWith('/send'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({
    conversation: ref,
    body: { kind: 'content', target, note: 'Deliberate content note' },
  });
  expect(f.owner.getState().windows.every((window) => window.messages.length === 0)).toBe(true);
  await act(() => f.scope.end());
  expect(f.owner.getState().drafts).toEqual([]);
});
it('does not let a late previous selection admit a draft or enable Send for the new selection', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = actualTalkFixture({
    snapshot: async (body) => {
      if (body.conversation.membershipId === ref.membershipId) await gate;
      return undefined;
    },
  });
  await renderActualShare(f);
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Actual peer 0' }));
  await waitFor(() => expect(f.calls.some((call) => call.path.endsWith('/read'))).toBe(true));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Actual peer 1' }));
  expect(screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState).toMatchObject({
    disabled: true,
  });
  expect(f.owner.getState().drafts).toEqual([]);
  await act(async () => {
    release();
    await gate;
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState,
    ).toMatchObject({ disabled: false }),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Send to selected conversation' }));
  await waitFor(() => expect(f.owner.getState().command.status).toBe('accepted'));
  expect(f.calls.filter((call) => call.path.endsWith('/send')).map((call) => call.body.conversation)).toEqual([
    f.other,
  ]);
  await act(() => f.scope.end());
});
it.each(['unavailable', 'wrong-read', 'wrong-scope'] as const)(
  'keeps Send disabled after a %s actual snapshot response',
  async (mode) => {
    const f = actualTalkFixture({
      snapshot: (body) =>
        Promise.resolve({
          version: body.version,
          readId: mode === 'wrong-read' ? id(90) : body.readId,
          scope: { accountId: mode === 'wrong-scope' ? id(91) : id(1), privacyEpoch: 1 },
          status: 'unavailable',
        }),
    });
    await renderActualShare(f);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Actual peer 0' }));
    await screen.findByText('This conversation couldn’t be checked. Choose a current destination again.');
    expect(
      screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(f.owner.getState().drafts).toEqual([]);
    expect(f.calls.filter((call) => call.path.endsWith('/send'))).toHaveLength(0);
    await act(() => f.scope.end());
  },
);
it('purges selected read continuation on scope end and refuses its late available snapshot', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = actualTalkFixture({
    snapshot: async () => {
      await gate;
      return undefined;
    },
  });
  await renderActualShare(f);
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Actual peer 0' }));
  await waitFor(() => expect(f.calls.some((call) => call.path.endsWith('/read'))).toBe(true));
  await act(() => f.scope.end());
  await act(async () => {
    release();
    await gate;
  });
  expect(f.owner.getState()).toMatchObject({ status: 'ended', windows: [], drafts: [] });
  expect(screen.queryByRole('button', { name: 'Send to selected conversation' })).toBeNull();
  expect(f.calls.filter((call) => call.path.endsWith('/send'))).toHaveLength(0);
});
it('preserves the actual global unknown command and its original draft while Share is opened', async () => {
  const f = actualTalkFixture({ unknownSend: true });
  await f.owner.refreshInbox();
  await f.owner.open(ref);
  f.owner.setDraft(ref, { kind: 'text', text: 'Original ambiguous body' });
  await f.owner.send(ref);
  const command = f.owner.getState().command;
  expect(command.status).toBe('unknown');
  const drafts = f.owner.getState().drafts;
  const original = f.calls.filter((call) => call.path.endsWith('/send'))[0]!.body;
  await renderActualShare(f);
  expect(screen.getByRole('togglebutton', { name: 'Actual peer 0' }).props.accessibilityState).toMatchObject({
    disabled: true,
  });
  expect(screen.getByRole('button', { name: 'Send to selected conversation' }).props.accessibilityState).toMatchObject({
    disabled: true,
  });
  expect(f.owner.getState().command).toEqual(command);
  expect(f.owner.getState().drafts).toEqual(drafts);
  expect(f.calls.filter((call) => call.path.endsWith('/send')).map((call) => call.body)).toEqual([original]);
  await fireEvent.press(screen.getByRole('button', { name: 'Retry same send' }));
  await waitFor(() => expect(f.calls.filter((call) => call.path.endsWith('/send'))).toHaveLength(2));
  expect(f.calls.filter((call) => call.path.endsWith('/send'))[1]!.body).toEqual(original);
  expect(f.owner.getState().command).toEqual(command);
  await act(() => f.scope.end());
});

const corrected = {
  status: 'corrected' as const,
  target: { assetId: id(30), assetRevision: 1 },
  current: {
    assetId: id(30),
    assetRevision: 2,
    metadata: {
      kind: 'reel' as const,
      title: 'Corrected fixture metadata',
      summary: 'Public fixture summary',
      language: 'en',
    },
  },
};
it.each([
  ['message', 'original'],
  ['message', 'updated'],
  ['private-check', 'original'],
  ['private-check', 'updated'],
] as const)(
  'projects the %s %s choice through the actual canonical API with a strict locator only',
  async (surface, version) => {
    const h = harness();
    mockEncounter = h.session;
    h.session.setForeground(true);
    if (surface === 'message') {
      await render(
        <DisplayProvider value={{}}>
          <ConversationMessage
            own={false}
            message={{
              status: 'available',
              messageId: id(31),
              sequence: 1,
              author: { kind: 'person', personId: id(6), handle: 'peer.fixture', displayName: 'Peer fixture' },
              recordedAt: '2026-10-23T00:00:00.000Z',
              body: { kind: 'content', content: corrected, note: 'Private Social note' },
            }}
            onOpen={(value) => {
              h.session.openConversationContent(value, jest.fn());
            }}
          />
        </DisplayProvider>,
      );
    } else {
      mockShareState = {
        ...mockShareState,
        resolved: {
          status: 'ready',
          data: {
            version: 'content-share.v1',
            readId: id(40),
            status: 'conversation',
            scope: { accountId: id(3), privacyEpoch: 1 },
            conversation: ref,
            content: corrected,
          },
        },
      };
      await render(
        <DisplayProvider value={{}}>
          <PrivateShareScreen scope={h.scope} onClose={jest.fn()} />
        </DisplayProvider>,
      );
      await fireEvent.changeText(screen.getByLabelText('Private share code'), `kssh_${'A'.repeat(43)}`);
      await fireEvent.press(screen.getByRole('button', { name: 'Check share' }));
    }
    expect(h.calls.filter((call) => call.path.endsWith('/open') || call.path.endsWith('/activate'))).toHaveLength(0);
    await fireEvent.press(await screen.findByRole('button', { name: `Open ${version} version` }));
    await waitFor(() => expect(h.calls.filter((call) => call.path.endsWith('/open'))).toHaveLength(1));
    const request = h.calls.find((call) => call.path.endsWith('/open'))!.body;
    expect(OpenRevisitRequestSchema.safeParse(request).success).toBe(true);
    expect(request.target).toEqual({
      kind: 'return',
      assetId: corrected.target.assetId,
      assetRevision: version === 'original' ? 1 : 2,
    });
    expect(Object.keys(request.target as object).sort()).toEqual(['assetId', 'assetRevision', 'kind']);
    expect(JSON.stringify(request)).not.toContain('Private Social note');
    expect(JSON.stringify(request)).not.toContain('Corrected fixture metadata');
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
    expect(h.calls.filter((call) => call.path.endsWith('/activate'))).toHaveLength(1);
    await act(() => h.scope.end());
  },
);
it('does not reinstall a return callback after an opening subscriber ends the genuine scope', async () => {
  const h = harness();
  const returned = jest.fn();
  h.session.setForeground(true);
  h.session.subscribe(() => {
    if (h.session.getState().phase === 'opening') h.scope.end();
  });
  expect(h.session.openConversationContent(corrected.current, returned)).toBe(false);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(h.session.getState()).toMatchObject({ phase: 'revoked', trail: [] });
  expect(h.session.back()).toBe(false);
  expect(h.session.openConversationContent(corrected.target, returned)).toBe(false);
  expect(returned).not.toHaveBeenCalled();
  expect(h.calls.filter((call) => call.path.endsWith('/open') || call.path.endsWith('/activate'))).toHaveLength(0);
});
it('rechecks lifecycle immediately before a stored return callback after synchronous publication', async () => {
  const h = harness();
  const returned = jest.fn();
  h.session.setForeground(true);
  expect(h.session.openConversationContent(corrected.current, returned)).toBe(true);
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  h.session.subscribe(() => h.scope.end());
  expect(h.session.back()).toBe(false);
  expect(returned).not.toHaveBeenCalled();
  expect(h.session.getState().phase).toBe('revoked');
});
it('does not close or route a private check after the real opening publication ends its scope', async () => {
  const h = harness();
  mockEncounter = h.session;
  const close = jest.fn();
  mockShareState = {
    ...mockShareState,
    resolved: {
      status: 'ready',
      data: {
        version: 'content-share.v1',
        readId: id(40),
        status: 'conversation',
        scope: { accountId: id(3), privacyEpoch: 1 },
        conversation: ref,
        content: corrected,
      },
    },
  };
  await render(
    <DisplayProvider value={{}}>
      <PrivateShareScreen scope={h.scope} onClose={close} />
    </DisplayProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Private share code'), `kssh_${'A'.repeat(43)}`);
  await fireEvent.press(screen.getByRole('button', { name: 'Check share' }));
  h.session.subscribe(() => {
    if (h.session.getState().phase === 'opening') h.scope.end();
  });
  await fireEvent.press(await screen.findByRole('button', { name: 'Open updated version' }));
  expect(close).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(h.session.back()).toBe(false);
  expect(h.calls.filter((call) => call.path.endsWith('/activate'))).toHaveLength(0);
});
it('rechecks the private UI scope after a successful delegated canonical Open before closing or routing', async () => {
  const h = harness();
  mockEncounter = h.session;
  const close = jest.fn();
  const open = h.session.openConversationContent.bind(h.session);
  jest.spyOn(h.session, 'openConversationContent').mockImplementation((value, returned) => {
    const admitted = open(value, returned);
    h.scope.end();
    return admitted;
  });
  mockShareState = {
    ...mockShareState,
    resolved: {
      status: 'ready',
      data: {
        version: 'content-share.v1',
        readId: id(40),
        status: 'conversation',
        scope: { accountId: id(3), privacyEpoch: 1 },
        conversation: ref,
        content: corrected,
      },
    },
  };
  await render(
    <DisplayProvider value={{}}>
      <PrivateShareScreen scope={h.scope} onClose={close} />
    </DisplayProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText('Private share code'), `kssh_${'A'.repeat(43)}`);
  await fireEvent.press(screen.getByRole('button', { name: 'Check share' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open updated version' }));
  expect(close).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  expect(h.session.back()).toBe(false);
});
it('does not execute an old return callback when synchronous publication starts different canonical work', async () => {
  const h = harness();
  const returned = jest.fn();
  h.session.setForeground(true);
  expect(h.session.openConversationContent(corrected.current, returned)).toBe(true);
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  let once = true;
  h.session.subscribe(() => {
    if (once) {
      once = false;
      h.session.open({ kind: 'discover' });
    }
  });
  expect(h.session.back()).toBe(false);
  expect(returned).not.toHaveBeenCalled();
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  h.scope.end();
});
