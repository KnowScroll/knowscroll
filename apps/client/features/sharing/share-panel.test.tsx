import type * as React from 'react';
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

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual<typeof React>('react').useEffect(effect, [effect]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('../../platform/api', () => ({ appApiOrigin: () => ({ ok: true, baseUrl: 'https://fixture.invalid' }) }));
let mockTalkState: ConversationsState;
let mockShareState: ContentSharesState;
const mockConversations = {
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
  useConversationsSession: () => ({ session: mockConversations, state: mockTalkState }),
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
  await fireEvent.press(screen.getByRole('button', { name: 'Peer fixture' }));
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
  await fireEvent.press(screen.getByRole('button', { name: 'Peer fixture' }));
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
