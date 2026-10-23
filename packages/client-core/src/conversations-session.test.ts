import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore, type AccountScope } from './account-scope';
import { createConversationsSession } from './conversations-session';
import { createContentSharesSession } from './content-shares-session';
import { SOCIAL_LIMITS, socialOwnerFor, type ConversationsState } from './conversations-types';
// Authored strict HTTP fixtures. No real memberships, messages, delivery or presence claims.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'chat@fixture.test' },
  scopeValue = { accountId: id(1), privacyEpoch: 1 };
const ref = (n = 3) => ({ conversationId: id(n), membershipId: id(n + 1000), membershipRevision: 1 });
const peer = { kind: 'person', personId: id(9), handle: 'fixture.peer', displayName: 'Authored peer' },
  own = { readThroughSequence: 0, muted: false };
const cursor = (prefix: string, n: number) => `${prefix}_${n.toString(36).padStart(43, 'a')}`;
const message = (n: number, text = 'PRIVATE_MESSAGE_CANARY') => ({
  status: 'available',
  messageId: id(10000 + n),
  sequence: n,
  author: peer,
  recordedAt: '2026-10-23T00:00:00.000Z',
  body: { kind: 'text', text },
});
function deferred<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function fixture(handler?: (path: string, input: Record<string, unknown>, request: Request) => unknown) {
  let next = 20000;
  const calls: { path: string; body: Record<string, unknown> }[] = [],
    store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    authorization: () => undefined,
    baseUrl: 'https://chat.fixture.test',
    fetch: async (request) => {
      const input = (await request.json()) as Record<string, unknown>,
        path = new URL(request.url).pathname;
      calls.push({ path, body: input });
      const result = await (handler ? handler(path, input, request) : response(path, input));
      return result instanceof Response
        ? result
        : new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    },
  });
  const session = createConversationsSession({ scope, newCommandId: () => id(next++) });
  return { session, scope, store, calls };
}
function response(path: string, x: Record<string, unknown>): unknown {
  const e = { version: 'direct-conversation.v1', scope: scopeValue, readId: x.readId };
  if (path.endsWith('/inbox'))
    return {
      ...e,
      status: 'ready',
      limit: 50,
      ...(x.cursor ? { requestCursor: x.cursor } : {}),
      viewRevision: 1,
      items: [{ conversation: ref(), peer, own, latestMessageSequence: 1, lastMessage: message(1) }],
      continuation: { kind: 'end' },
    };
  if (path.endsWith('/conversations/read'))
    return {
      ...e,
      status: 'ready',
      conversation: x.conversation,
      peer,
      own,
      latestMessageSequence: 1,
      messages: [message(1)],
      limit: 50,
      history: { kind: 'end' },
      catchUpCursor: cursor('kcc1', 1),
    };
  if (path.endsWith('/pairs/read'))
    return {
      version: 'sharing.v1',
      scope: scopeValue,
      status: 'available',
      pair: { state: 'friends', peer, pairRevision: 4, availability: { state: 'unknown' } },
    };
  if (path.endsWith('/send/read'))
    return {
      ...e,
      status: 'accepted',
      conversation: x.conversation,
      selector: x.selector,
      messageId: id(10002),
      messageSequence: 2,
      recordedAt: '2026-10-23T00:00:00.000Z',
      sent: { kind: 'text' },
    };
  if (path.endsWith('/changes'))
    return {
      ...e,
      status: 'ready',
      conversation: x.conversation,
      limit: 50,
      requestCursor: x.cursor,
      fromChangeSequence: 1,
      throughChangeSequence: 1,
      changes: [],
      continuation: { kind: 'caught_up', cursor: x.cursor },
    };
  const receipt = {
    version: 'direct-conversation.v1',
    scope: scopeValue,
    commandId: x.commandId,
    recordedAt: '2026-10-23T00:00:00.000Z',
    replayed: false,
    outcome: 'accepted',
  };
  if (path.endsWith('/start'))
    return { ...receipt, operation: 'conversation.start', conversation: ref(), peerPersonId: x.peerPersonId };
  if (path.endsWith('/send'))
    return {
      ...receipt,
      operation: 'message.send',
      conversation: x.conversation,
      messageId: id(10002),
      messageSequence: 2,
      sent: { kind: 'text' },
    };
  if (path.endsWith('/mute'))
    return { ...receipt, operation: 'conversation.mute', conversation: x.conversation, muted: x.muted };
  if (path.endsWith('/mark-read'))
    return {
      ...receipt,
      operation: 'conversation.read',
      conversation: x.conversation,
      requestedThroughSequence: x.throughSequence,
      acceptedThroughSequence: x.throughSequence,
    };
  if (path.endsWith('/leave')) return { ...receipt, operation: 'conversation.leave', conversation: x.conversation };
  throw new Error('UNEXPECTED_FIXTURE_REQUEST');
}
async function opened(h: ReturnType<typeof fixture>) {
  await h.session.refreshInbox();
  await h.session.open(ref());
}
const windowOf = (h: ReturnType<typeof fixture>) => h.session.getState().windows[0]!;
function assertNoPersistence(scope: AccountScope, keys: readonly string[]) {
  expect(keys).toEqual([]);
  for (const q of scope.queryClient.getQueryCache().getAll()) {
    expect(JSON.stringify(q.queryKey)).not.toMatch(/PRIVATE|conversationId|membershipId|kcc1|kch1/);
    expect(q.state.data === undefined || typeof q.state.data === 'number').toBe(true);
  }
}
describe('scope-lifetime Conversations controller (authored HTTP fixtures)', () => {
  it('requires current locators and a fresh accepted pair before deliberate start; ACK is not a snapshot', async () => {
    const h = fixture();
    await h.session.open(ref());
    expect(h.calls).toEqual([]);
    await h.session.start(peer.personId);
    expect(h.calls.map((x) => x.path)).toEqual(['/v1/social/pairs/read', '/v1/social/conversations/start']);
    expect(h.calls[1]!.body).toMatchObject({ expectedPairRevision: 4, peerPersonId: peer.personId });
    expect(windowOf(h)).toMatchObject({ status: 'refresh_required', messages: [] });
    expect(createConversationsSession({ scope: h.scope, newCommandId: () => id(999) })).toBe(h.session);
    await h.session.open(ref());
    expect(windowOf(h).status).toBe('ready');
    h.scope.end();
  });
  it('clears snapshot authority synchronously before refresh/focus/resync HTTP and fences abort-ignoring late results', async () => {
    const hold = deferred<unknown>();
    let holdReads = false;
    const h = fixture((path, input) =>
      path.endsWith('/conversations/read') && holdReads ? hold.promise : response(path, input),
    );
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'PRIVATE_DRAFT' });
    holdReads = true;
    const waiting = h.session.refreshConversation(ref());
    expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
    expect(windowOf(h).peer).toBeUndefined();
    expect(h.session.getState().drafts[0]!.body).toEqual({ kind: 'text', text: 'PRIVATE_DRAFT' });
    h.session.focus(false);
    h.scope.end();
    expect(h.session.getState()).toMatchObject({
      status: 'ended',
      windows: [],
      drafts: [],
      command: { status: 'idle' },
      recovery: { status: 'idle' },
    });
    hold.open(response('/v1/social/conversations/read', h.calls.at(-1)!.body));
    await waiting;
    expect(h.session.getState().windows).toEqual([]);
    assertNoPersistence(h.scope, h.store.keys());
  });
  it('rechecks authority on focus and existing metadata invalidation without caching Social values', async () => {
    const h = fixture();
    await opened(h);
    const before = h.calls.length;
    h.session.focus(true);
    expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
    await expect.poll(() => h.session.getState().inbox.status).toBe('ready');
    await expect.poll(() => h.calls.length).toBeGreaterThan(before + 1);
    await expect.poll(() => h.scope.queryClient.isFetching()).toBe(0);
    const invalidation = h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() });
    expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
    await invalidation;
    expect(h.calls.filter((c) => c.path.endsWith('/conversations/read'))).toHaveLength(3);
    assertNoPersistence(h.scope, h.store.keys());
    h.scope.end();
  });
  it('inhibits reentrant sends during the first focus publication and cannot recreate a query after scope end', async () => {
    const h = fixture();
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'private draft' });
    let observed = false,
      firstFocus: unknown;
    h.session.subscribe(() => {
      if (!observed && h.session.getState().focused) {
        observed = true;
        firstFocus = windowOf(h);
        void h.session.send(ref());
        h.scope.end();
      }
    });
    h.session.focus(true);
    expect(observed).toBe(true);
    expect(firstFocus).toMatchObject({ status: 'loading', messages: [] });
    expect(h.session.getState().status).toBe('ended');
    expect(h.calls.some((c) => c.path.endsWith('/send'))).toBe(false);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
  });
  it('invalidates focused continuation on blur even when the HTTP adapter ignores abort', async () => {
    const held = deferred<unknown>();
    let hold = false;
    const h = fixture((path, input) =>
      hold && path.endsWith('/conversations/read') ? held.promise : response(path, input),
    );
    await opened(h);
    hold = true;
    const before = h.calls.length;
    h.session.focus(true);
    await expect.poll(() => h.calls.length).toBe(before + 1);
    const original = h.calls.at(-1)!.body;
    h.session.focus(false);
    expect(h.session.getState().focused).toBe(false);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    held.open(response('/v1/social/conversations/read', original));
    await expect.poll(() => h.scope.queryClient.isFetching()).toBe(0);
    // One event-loop yield drains only the already-issued promise/JSON continuations.
    await new Promise<void>((done) => setImmediate(done));
    expect(h.calls).toHaveLength(before + 1);
    expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    h.scope.end();
  });
  it('cannot recreate an observer or dispatch HTTP after a reentrant first-publication blur', async () => {
    const h = fixture();
    await opened(h);
    const before = h.calls.length;
    let blurred = false;
    h.session.subscribe(() => {
      if (!blurred && h.session.getState().focused) {
        blurred = true;
        h.session.focus(false);
      }
    });
    h.session.focus(true);
    await Promise.resolve();
    expect(blurred).toBe(true);
    expect(h.session.getState().focused).toBe(false);
    expect(h.calls).toHaveLength(before);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    h.scope.end();
  });
  it.each(['history', 'changes'] as const)(
    'does not revive an old %s page after snapshot replacement and scope purge',
    async (lane) => {
      const held = deferred<unknown>();
      let holding = false;
      const h = fixture((path, input) => {
        if (holding && path.endsWith('/' + lane)) return held.promise;
        const b = response(path, input) as Record<string, unknown>;
        if (path.endsWith('/conversations/read'))
          return {
            ...b,
            latestMessageSequence: 2,
            messages: [message(2)],
            history: { kind: 'more', cursor: cursor('kch1', 1) },
          };
        return b;
      });
      await opened(h);
      holding = true;
      const waiting = lane === 'history' ? h.session.history(ref()) : h.session.catchUp(ref());
      await expect.poll(() => h.calls.at(-1)!.path).toBe('/v1/social/conversations/' + lane);
      const original = h.calls.at(-1)!.body;
      const replacement = h.session.refreshConversation(ref());
      expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
      h.scope.end();
      held.open(
        lane === 'changes'
          ? {
              ...(response('/v1/social/conversations/changes', original) as object),
              fromChangeSequence: 2,
              throughChangeSequence: 2,
            }
          : {
              version: 'direct-conversation.v1',
              scope: scopeValue,
              readId: original.readId,
              status: 'ready',
              conversation: ref(),
              limit: 50,
              requestCursor: original.cursor,
              messages: [message(1, 'LATE_PRIVATE_PAGE')],
              continuation: { kind: 'end' },
            },
      );
      await waiting;
      await replacement;
      expect(h.session.getState()).toMatchObject({ status: 'ended', windows: [], drafts: [] });
      expect(h.calls.filter((c) => c.path.endsWith('/conversations/read'))).toHaveLength(1);
      expect(JSON.stringify(h.session.getState())).not.toContain('LATE_PRIVATE_PAGE');
      assertNoPersistence(h.scope, h.store.keys());
    },
  );
  it.each(['history', 'changes'] as const)(
    'reacquires only the replacement window after an obsolete %s settles',
    async (lane) => {
      const held = deferred<unknown>();
      let holding = false;
      const h = fixture((path, input) => {
        if (holding && path.endsWith('/' + lane)) return held.promise;
        const b = response(path, input) as Record<string, unknown>;
        return path.endsWith('/conversations/read')
          ? {
              ...b,
              latestMessageSequence: 2,
              messages: [message(2, 'CURRENT_WINDOW')],
              history: { kind: 'more', cursor: cursor('kch1', 1) },
            }
          : b;
      });
      await opened(h);
      holding = true;
      const waiting = lane === 'history' ? h.session.history(ref()) : h.session.catchUp(ref());
      await expect.poll(() => h.calls.at(-1)!.path).toBe('/v1/social/conversations/' + lane);
      const original = h.calls.at(-1)!.body;
      const replacement = h.session.refreshConversation(ref());
      expect(windowOf(h)).toMatchObject({ status: 'loading', messages: [] });
      held.open(
        lane === 'changes'
          ? {
              ...(response('/v1/social/conversations/changes', original) as object),
              fromChangeSequence: 2,
              throughChangeSequence: 2,
            }
          : {
              version: 'direct-conversation.v1',
              scope: scopeValue,
              readId: original.readId,
              status: 'ready',
              conversation: ref(),
              limit: 50,
              requestCursor: original.cursor,
              messages: [message(1, 'OBSOLETE_PAGE')],
              continuation: { kind: 'end' },
            },
      );
      await waiting;
      await replacement;
      expect(windowOf(h)).toMatchObject({ status: 'ready', messages: [message(2, 'CURRENT_WINDOW')] });
      expect(JSON.stringify(h.session.getState())).not.toContain('OBSOLETE_PAGE');
      expect(h.calls.filter((c) => c.path.endsWith('/conversations/read'))).toHaveLength(2);
      h.scope.end();
    },
  );
  it.each(['success', 'failure'] as const)(
    'retires the held original HTTP body before accepted recovery releases its slot; late %s cannot touch the next command',
    async (obsoleteOutcome) => {
      const first = deferred<unknown>(),
        second = deferred<unknown>();
      const signals: AbortSignal[] = [];
      let sendCount = 0,
        recovered = false;
      let abortBusy: boolean | undefined, abortBudget: boolean | undefined, abortCommand: unknown;
      const h = fixture((path, input, request) => {
        if (path.endsWith('/send')) {
          signals.push(request.signal);
          if (++sendCount === 1) {
            request.signal.addEventListener(
              'abort',
              () => {
                abortBusy = owner.busy();
                abortCommand = h.session.getState().command;
                // Only a direct actual-owner admission probe, never a wire payload.
                abortBudget = owner.retain(probe, { text: 'x'.repeat(remainingBytes) });
                owner.drop(probe);
                void h.session.retryCommand();
                void h.session.start(peer.personId);
              },
              { once: true },
            );
            return first.promise;
          }
          return second.promise;
        }
        if (path.endsWith('/send/read')) recovered = true;
        const b = response(path, input) as Record<string, unknown>;
        return recovered && path.endsWith('/conversations/read')
          ? { ...b, latestMessageSequence: 2, messages: [message(2)] }
          : b;
      });
      const owner = socialOwnerFor(h.scope),
        probe = {},
        remainingBytes = SOCIAL_LIMITS.bodyBytes - new TextEncoder().encode('PRIVATE_MESSAGE_CANARY').length;
      await opened(h);
      h.session.setDraft(ref(), { kind: 'text', text: 'FIRST_PRIVATE_BODY' });
      const firstSend = h.session.send(ref());
      await expect.poll(() => sendCount).toBe(1);
      const original = h.calls.find((c) => c.path.endsWith('/send'))!.body;
      expect(h.session.getState().command).toMatchObject({ status: 'pending', commandId: original.commandId });
      const releaseFacts: { aborted: boolean; admitted: boolean }[] = [];
      const off = owner.subscribe(() => {
        if (!owner.busy() && recovered) {
          releaseFacts.push({
            aborted: signals[0]!.aborted,
            admitted: owner.retain(probe, { text: 'x'.repeat(remainingBytes) }),
          });
          owner.drop(probe);
        }
      });
      await h.session.recoverOwnSend(ref());
      off();
      expect(abortBusy).toBe(true);
      expect(abortBudget).toBe(false);
      expect(abortCommand).toMatchObject({ status: 'accepted', commandId: original.commandId });
      expect(signals[0]!.aborted).toBe(true);
      expect(releaseFacts).toEqual([{ aborted: true, admitted: true }]);
      expect(owner.busy()).toBe(false);
      expect(h.session.getState()).toMatchObject({
        command: { status: 'accepted', commandId: original.commandId },
        recovery: { status: 'ready', data: { selector: { kind: 'command', commandId: original.commandId } } },
      });
      expect(windowOf(h)).toMatchObject({ status: 'refresh_required', messages: [] });
      expect(h.calls.some((c) => c.path.endsWith('/pairs/read'))).toBe(false);
      await h.session.refreshConversation(ref());
      h.session.setDraft(ref(), { kind: 'text', text: 'SECOND_PRIVATE_BODY' });
      const secondSend = h.session.send(ref());
      await expect.poll(() => sendCount).toBe(2);
      const next = h.calls.filter((c) => c.path.endsWith('/send'))[1]!.body;
      expect(next.commandId).not.toBe(original.commandId);
      first.open(
        obsoleteOutcome === 'success'
          ? response('/v1/social/conversations/send', original)
          : new Response(JSON.stringify(problemDetails('FORBIDDEN')), {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            }),
      );
      await firstSend;
      await new Promise<void>((done) => setImmediate(done));
      expect(signals[1]!.aborted).toBe(false);
      expect(owner.busy()).toBe(true);
      expect(h.session.getState().command).toMatchObject({ status: 'pending', commandId: next.commandId });
      expect(h.session.getState().drafts[0]!.body).toEqual({ kind: 'text', text: 'SECOND_PRIVATE_BODY' });
      expect(sendCount).toBe(2);
      h.scope.end();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(owner.busy()).toBe(false);
      second.open(response('/v1/social/conversations/send', next));
      await secondSend;
      expect(h.session.getState()).toMatchObject({
        status: 'ended',
        windows: [],
        drafts: [],
        command: { status: 'idle' },
      });
      assertNoPersistence(h.scope, h.store.keys());
    },
  );
  it('pins one unknown original command globally; later refusal cannot prove non-send; recovery is body-free and never a bubble', async () => {
    let sends = 0;
    const h = fixture((path, input) => {
      if (path.endsWith('/send')) {
        if (++sends === 1) throw new Error('PRIVATE_NETWORK');
        return new Response(JSON.stringify(problemDetails('FORBIDDEN')), {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return response(path, input);
    });
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'PRIVATE_SEND' });
    await h.session.send(ref());
    expect(h.session.getState().command).toMatchObject({ status: 'unknown', operation: 'send' });
    const original = h.calls.at(-1)!.body;
    const shares = createContentSharesSession({ scope: h.scope, newCommandId: () => id(999) });
    await shares.create({ target: { assetId: id(50), assetRevision: 1 }, audience: { kind: 'public_metadata' } });
    expect(shares.getState().failure).toBe('busy');
    expect(sends).toBe(1);
    await h.session.retryCommand();
    expect(sends).toBe(2);
    expect(h.calls.at(-1)!.body).toEqual(original);
    expect(h.session.getState().command.status).toBe('unknown');
    expect(windowOf(h).messages).toEqual([]);
    await h.session.refreshConversation(ref());
    await h.session.recoverOwnSend(ref());
    expect(h.session.getState().command.status).toBe('accepted');
    expect(windowOf(h)).toMatchObject({ status: 'refresh_required', messages: [] });
    expect(JSON.stringify(h.session.getState().recovery)).not.toContain('PRIVATE_SEND');
    expect(h.calls.at(-1)!.body).toMatchObject({ selector: { kind: 'command', commandId: original.commandId } });
    assertNoPersistence(h.scope, h.store.keys());
    h.scope.end();
    expect(h.session.getState().recovery).toEqual({ status: 'idle' });
    expect(shares.getState().status).toBe('ended');
  });
  it('refuses start/retry when the actual current pair is not the original accepted friendship', async () => {
    let revision = 4,
      sends = 0;
    const h = fixture((path, input) => {
      if (path.endsWith('/pairs/read'))
        return {
          version: 'sharing.v1',
          scope: scopeValue,
          status: 'available',
          pair: { state: 'friends', peer, pairRevision: revision, availability: { state: 'unknown' } },
        };
      if (path.endsWith('/start')) {
        sends++;
        throw new Error('UNKNOWN_START');
      }
      return response(path, input);
    });
    await h.session.start(peer.personId);
    expect(sends).toBe(1);
    expect(h.session.getState().command.status).toBe('unknown');
    revision = 5;
    await h.session.retryCommand();
    expect(sends).toBe(1);
    expect(h.session.getState()).toMatchObject({ command: { status: 'unknown' }, failure: 'refresh_required' });
    expect(h.calls.filter((c) => c.path.endsWith('/pairs/read'))).toHaveLength(2);
    h.scope.end();
  });
  it('bounds necessary read/mute/leave mutations to current caller-visible truth and rereads after ACK', async () => {
    const h = fixture();
    await opened(h);
    const initial = h.calls.length;
    await h.session.markRead(ref(), 2);
    expect(h.calls).toHaveLength(initial);
    await h.session.markRead(ref(), 1);
    expect(h.session.getState().command).toMatchObject({ status: 'accepted', operation: 'markRead' });
    await h.session.mute(ref(), true);
    expect(h.calls).toHaveLength(initial + 1);
    await h.session.refreshConversation(ref());
    await h.session.mute(ref(), true);
    expect(h.session.getState().command).toMatchObject({ status: 'accepted', operation: 'mute' });
    await h.session.refreshConversation(ref());
    await h.session.leave(ref());
    expect(windowOf(h)).toMatchObject({ status: 'unavailable', messages: [] });
    h.scope.end();
  });
  it('purges BOTH controllers before reentrant end publication and cannot publish a stale ACK', async () => {
    const held = deferred<unknown>();
    const h = fixture((path, input) => (path.endsWith('/send') ? held.promise : response(path, input)));
    await opened(h);
    const shares = createContentSharesSession({ scope: h.scope, newCommandId: () => id(909) });
    h.session.setDraft(ref(), { kind: 'text', text: 'PRIVATE_PENDING' });
    const command = h.session.send(ref());
    await expect.poll(() => h.calls.some((x) => x.path.endsWith('/send'))).toBe(true);
    let endedPublications = 0,
      otherAtEnd: unknown;
    h.session.subscribe(() => {
      if (h.session.getState().status === 'ended') {
        endedPublications++;
        otherAtEnd = shares.getState();
      }
    });
    h.scope.end();
    expect(endedPublications).toBe(1);
    expect(otherAtEnd).toMatchObject({
      status: 'ended',
      own: { status: 'idle' },
      resolved: { status: 'idle' },
      tokenAvailable: false,
    });
    held.open(response('/v1/social/conversations/send', h.calls.at(-1)!.body));
    await command;
    expect(h.session.getState()).toMatchObject({
      status: 'ended',
      command: { status: 'idle' },
      drafts: [],
      windows: [],
    });
    const calls = h.calls.length;
    await h.session.retryCommand();
    await h.session.start(peer.personId);
    expect(h.calls).toHaveLength(calls);
  });
  it('does not discard a newly edited draft when an earlier exact send ACK arrives', async () => {
    const held = deferred<unknown>();
    const h = fixture((path, input) => (path.endsWith('/send') ? held.promise : response(path, input)));
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'first body' });
    const pending = h.session.send(ref());
    await expect.poll(() => h.calls.some((c) => c.path.endsWith('/send'))).toBe(true);
    h.session.setDraft(ref(), { kind: 'text', text: 'second deliberate draft' });
    held.open(response('/v1/social/conversations/send', h.calls.at(-1)!.body));
    await pending;
    expect(h.session.getState().drafts[0]!.body).toEqual({ kind: 'text', text: 'second deliberate draft' });
    expect(h.calls.filter((c) => c.path.endsWith('/send'))).toHaveLength(1);
    h.scope.end();
  });
  it('allows editing-invalid whitespace but validates before send and refuses accessor drafts', async () => {
    const h = fixture();
    await opened(h);
    const count = h.calls.length;
    h.session.setDraft(ref(), { kind: 'text', text: '  editing ' });
    expect(h.session.getState().drafts).toHaveLength(1);
    await h.session.send(ref());
    expect(h.calls).toHaveLength(count);
    expect(h.session.getState().failure).toBe('invalid');
    let reads = 0;
    const hostile = Object.defineProperty({ kind: 'text' }, 'text', {
      enumerable: true,
      get() {
        reads++;
        return 'SECRET';
      },
    });
    h.session.setDraft(ref(), hostile as { kind: 'text'; text: string });
    expect(reads).toBe(0);
    h.session.setDraft(ref(), { kind: 'text', text: 'valid' });
    await h.session.send(ref());
    expect(h.session.getState().command.status).toBe('accepted');
    expect(windowOf(h)).toMatchObject({ status: 'refresh_required', messages: [] });
    expect(h.session.getState().drafts).toEqual([]);
    h.scope.end();
  });
  it('performs one finite catch-up page per explicit call and applies neutral tombstones without resurrection', async () => {
    let page = 0;
    const h = fixture((path, input) => {
      if (!path.endsWith('/changes')) return response(path, input);
      page++;
      return {
        version: 'direct-conversation.v1',
        scope: scopeValue,
        readId: input.readId,
        status: 'ready',
        conversation: input.conversation,
        limit: 50,
        requestCursor: input.cursor,
        fromChangeSequence: page === 1 ? 1 : 2,
        throughChangeSequence: 3,
        changes: [
          {
            changeSequence: page === 1 ? 2 : 3,
            message: page === 1 ? { status: 'unavailable', messageId: message(1).messageId, sequence: 1 } : message(2),
          },
        ],
        continuation: { kind: page === 1 ? 'more' : 'caught_up', cursor: cursor('kcc1', page + 1) },
      };
    });
    await opened(h);
    await h.session.catchUp(ref());
    expect(page).toBe(1);
    expect(windowOf(h).catchUp).toBe('more');
    expect(windowOf(h).messages[0]).toEqual({ status: 'unavailable', messageId: message(1).messageId, sequence: 1 });
    await h.session.catchUp(ref());
    expect(page).toBe(2);
    expect(windowOf(h).catchUp).toBe('caught_up');
    expect(windowOf(h).messages).toHaveLength(2);
    h.scope.end();
  });
  it('keeps bounded neutral tombstones across snapshot rechecks rather than resurrecting an old private body', async () => {
    let deleted = false;
    const h = fixture((path, input) => {
      if (path.endsWith('/changes')) {
        deleted = true;
        return {
          version: 'direct-conversation.v1',
          scope: scopeValue,
          readId: input.readId,
          status: 'ready',
          conversation: input.conversation,
          limit: 50,
          requestCursor: input.cursor,
          fromChangeSequence: 1,
          throughChangeSequence: 2,
          changes: [
            { changeSequence: 2, message: { status: 'unavailable', messageId: message(1).messageId, sequence: 1 } },
          ],
          continuation: { kind: 'caught_up', cursor: cursor('kcc1', 2) },
        };
      }
      return response(path, input);
    });
    await opened(h);
    await h.session.catchUp(ref());
    expect(deleted).toBe(true);
    await h.session.refreshConversation(ref());
    expect(windowOf(h)).toMatchObject({ status: 'refresh_required', reason: 'invalid', messages: [] });
    expect(JSON.stringify(h.session.getState().windows)).not.toContain('PRIVATE_MESSAGE_CANARY');
    h.scope.end();
  });
  it('does not auto-drain empty inbox pages or silently substitute page one for a stale cursor', async () => {
    let pages = 0;
    const h = fixture((_path, input) => {
      pages++;
      return input.cursor
        ? {
            version: 'direct-conversation.v1',
            scope: scopeValue,
            readId: input.readId,
            status: 'refresh_required',
            limit: 50,
            requestCursor: input.cursor,
          }
        : {
            version: 'direct-conversation.v1',
            scope: scopeValue,
            readId: input.readId,
            status: 'ready',
            limit: 50,
            viewRevision: 1,
            items: [],
            continuation: { kind: 'more', cursor: cursor('kci1', 1) },
          };
    });
    await h.session.refreshInbox();
    expect(pages).toBe(1);
    await h.session.nextInbox();
    expect(pages).toBe(2);
    expect(h.session.getState().inbox).toMatchObject({ status: 'unavailable', reason: 'refresh_required' });
    await h.session.nextInbox();
    expect(pages).toBe(2);
    h.scope.end();
  });
  it('bounds retained windows/drafts and requires explicit inactive eviction without replacing a pending command', async () => {
    const h = fixture((path, input) =>
      path.endsWith('/inbox')
        ? {
            version: 'direct-conversation.v1',
            scope: scopeValue,
            readId: input.readId,
            status: 'ready',
            limit: 50,
            viewRevision: 1,
            items: Array.from({ length: 9 }, (_, i) => ({
              conversation: ref(i + 3),
              peer,
              own,
              latestMessageSequence: 1,
              lastMessage: message(1),
            })),
            continuation: { kind: 'end' },
          }
        : response(path, input),
    );
    await h.session.refreshInbox();
    for (let i = 3; i < 11; i++) {
      await h.session.open(ref(i));
      h.session.setDraft(ref(i), { kind: 'text', text: 'draft' });
    }
    expect(h.session.getState().windows).toHaveLength(8);
    expect(h.session.getState().drafts).toHaveLength(8);
    const count = h.calls.length;
    await h.session.open(ref(11));
    expect(h.calls).toHaveLength(count);
    expect(h.session.getState().failure).toBe('capacity');
    h.session.forgetWindow(ref(10));
    expect(h.session.getState().failure).toBe('busy');
    h.session.forgetWindow(ref(3));
    expect(h.session.getState().windows).toHaveLength(7);
    await h.session.open(ref(11));
    expect(h.session.getState().windows).toHaveLength(8);
    h.scope.end();
  });
  it('refuses over-100 history as explicit capacity while retaining the confirmed bounded page and draft', async () => {
    let history = 0;
    const h = fixture((path, input) => {
      const e = {
        version: 'direct-conversation.v1',
        scope: scopeValue,
        readId: input.readId,
        status: 'ready',
        conversation: input.conversation,
        limit: 50,
      };
      if (path.endsWith('/conversations/read'))
        return {
          ...e,
          peer,
          own,
          latestMessageSequence: 150,
          messages: Array.from({ length: 50 }, (_, i) => message(101 + i)),
          history: { kind: 'more', cursor: cursor('kch1', 1) },
          catchUpCursor: cursor('kcc1', 1),
        };
      if (path.endsWith('/history')) {
        history++;
        return {
          ...e,
          requestCursor: input.cursor,
          messages: Array.from({ length: 50 }, (_, i) => message((history === 1 ? 51 : 1) + i)),
          continuation: { kind: 'more', cursor: cursor('kch1', history + 1) },
        };
      }
      return response(path, input);
    });
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'retained' });
    await h.session.history(ref());
    expect(windowOf(h).messages).toHaveLength(100);
    await h.session.history(ref());
    expect(windowOf(h)).toMatchObject({ status: 'ready', reason: 'capacity', historyAvailable: false });
    expect(windowOf(h).messages).toHaveLength(100);
    expect(h.session.getState().drafts).toHaveLength(1);
    expect(history).toBe(2);
    h.scope.end();
  });
  it('bounds accepted UTF-8 bodies across the whole owner rather than just each response', async () => {
    const h = fixture((path, input) => {
      if (path.endsWith('/inbox'))
        return {
          version: 'direct-conversation.v1',
          scope: scopeValue,
          readId: input.readId,
          status: 'ready',
          limit: 50,
          viewRevision: 1,
          items: Array.from({ length: 8 }, (_, i) => ({
            conversation: ref(i + 3),
            peer,
            own,
            latestMessageSequence: 1,
            lastMessage: message(1),
          })),
          continuation: { kind: 'end' },
        };
      if (path.endsWith('/conversations/read'))
        return {
          version: 'direct-conversation.v1',
          scope: scopeValue,
          readId: input.readId,
          status: 'ready',
          conversation: input.conversation,
          limit: 50,
          peer,
          own,
          latestMessageSequence: 50,
          messages: Array.from({ length: 50 }, (_, i) => message(i + 1, '界'.repeat(2000))),
          history: { kind: 'end' },
          catchUpCursor: cursor('kcc1', 1),
        };
      return response(path, input);
    });
    await h.session.refreshInbox();
    for (let i = 3; i < 10; i++) await h.session.open(ref(i));
    expect(h.session.getState().windows.filter((w) => w.status === 'ready')).toHaveLength(6);
    expect(h.session.getState().windows.at(-1)).toMatchObject({
      status: 'refresh_required',
      reason: 'capacity',
      messages: [],
    });
    expect(h.session.getState().failure).toBe('capacity');
    expect(h.calls.filter((c) => c.path.endsWith('/conversations/read'))).toHaveLength(7);
    h.scope.end();
  });
  it('never authorizes current mutations from a historical receipt or neutral unavailable snapshot', async () => {
    let unavailable = false;
    const h = fixture((path, input) =>
      path.endsWith('/conversations/read') && unavailable
        ? { version: 'direct-conversation.v1', scope: scopeValue, readId: input.readId, status: 'unavailable' }
        : response(path, input),
    );
    await opened(h);
    h.session.setDraft(ref(), { kind: 'text', text: 'purge on revocation' });
    unavailable = true;
    await h.session.refreshConversation(ref());
    expect(windowOf(h)).toMatchObject({ status: 'unavailable', messages: [] });
    expect(h.session.getState().drafts).toEqual([]);
    const count = h.calls.length;
    await h.session.mute(ref(), true);
    await h.session.leave(ref());
    expect(h.calls).toHaveLength(count);
    h.scope.end();
  });
});

// Actual scope/api abort callbacks are synchronous. Record first, then assert outside the callback
// so listener isolation cannot conceal a failed assertion or a later reentrant publication repair.
describe('accepted recovery observable state before original HTTP abort (authored fixtures)', () => {
  it.each(['sent', 'edited'] as const)(
    'purges the old ready window and rebuilds the %s draft before abort, keeping the body admission and shared lane held',
    async (draftKind) => {
      const held = deferred<unknown>();
      let signal: AbortSignal | undefined,
        abortState: ConversationsState | undefined,
        abortBusy: boolean | undefined,
        abortBudget: boolean | undefined;
      const target = { assetId: id(70), assetRevision: 1 },
        edited = 'REVISED_PRIVATE_DRAFT';
      const h = fixture((path, input, request) => {
        if (path.endsWith('/conversations/send')) {
          signal = request.signal;
          request.signal.addEventListener(
            'abort',
            () => {
              // Observe before retry/start can publish a repaired snapshot from the maps.
              abortState = h.session.getState();
              abortBusy = owner.busy();
              abortBudget = owner.retain(probe, { text: 'x'.repeat(remainingBytes) });
              owner.drop(probe);
              void h.session.retryCommand();
              void h.session.start(peer.personId);
              void shares.create({ target, audience: { kind: 'public_metadata' } });
            },
            { once: true },
          );
          return held.promise;
        }
        if (path.endsWith('/content-shares/create'))
          return {
            acceptance: {
              version: 'content-share.v1',
              scope: scopeValue,
              commandId: input.commandId,
              outcome: 'accepted',
              replayed: false,
              recordedAt: '2026-10-23T00:00:00.000Z',
              operation: 'content-share.create',
              shareId: id(71),
              target: input.target,
              audience: input.audience,
              expiresAt: '2026-10-24T00:00:00.000Z',
            },
            delivery: { status: 'available', token: `kssh_${'z'.repeat(43)}` },
          };
        return response(path, input);
      });
      const owner = socialOwnerFor(h.scope),
        probe = {},
        remainingBytes =
          SOCIAL_LIMITS.bodyBytes -
          new TextEncoder().encode('PRIVATE_MESSAGE_CANARY').length -
          (draftKind === 'edited' ? new TextEncoder().encode(edited).length : 0),
        shares = createContentSharesSession({ scope: h.scope, newCommandId: () => id(72) });
      await opened(h);
      h.session.setDraft(ref(), { kind: 'text', text: 'FIRST_PRIVATE_BODY' });
      const pending = h.session.send(ref());
      await expect.poll(() => !!signal).toBe(true);
      const original = h.calls.find((call) => call.path.endsWith('/conversations/send'))!.body;
      if (draftKind === 'edited') h.session.setDraft(ref(), { kind: 'text', text: edited });
      const premature: ConversationsState[] = [];
      const stopState = h.session.subscribe(() => {
        const state = h.session.getState();
        if (state.command.status === 'accepted' && !signal!.aborted) premature.push(state);
      });
      const releases: { aborted: boolean; admitted: boolean; busy: boolean; state: ConversationsState }[] = [];
      const stopOwner = owner.subscribe(() => {
        if (!owner.busy()) {
          releases.push({
            aborted: signal!.aborted,
            admitted: owner.retain(probe, { text: 'x'.repeat(remainingBytes) }),
            busy: owner.busy(),
            state: h.session.getState(),
          });
          owner.drop(probe);
        }
      });
      await h.session.recoverOwnSend(ref());
      stopState();
      stopOwner();
      expect(abortState?.command).toEqual({ status: 'accepted', operation: 'send', commandId: original.commandId });
      expect(abortState?.windows).toEqual([
        {
          conversation: ref(),
          status: 'refresh_required',
          latestMessageSequence: 1,
          messages: [],
          historyAvailable: false,
          catchUp: 'refresh_required',
        },
      ]);
      expect(abortState?.drafts).toEqual(
        draftKind === 'edited' ? [{ conversation: ref(), body: { kind: 'text', text: edited } }] : [],
      );
      expect(abortState?.mutationBlocked).toBe(true);
      expect(abortBusy).toBe(true);
      expect(abortBudget).toBe(false);
      expect(Object.isFrozen(abortState)).toBe(true);
      expect(Object.isFrozen(abortState?.windows[0])).toBe(true);
      expect(Object.isFrozen(abortState?.drafts)).toBe(true);
      expect(JSON.stringify([abortState?.windows, abortState?.drafts, abortState?.command])).not.toContain(
        'FIRST_PRIVATE_BODY',
      );
      expect(JSON.stringify(abortState?.windows)).not.toContain('PRIVATE_MESSAGE_CANARY');
      expect(premature).toEqual([]);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ aborted: true, admitted: true, busy: false });
      expect(releases[0]!.state.windows).toEqual(abortState?.windows);
      expect(releases[0]!.state.drafts).toEqual(abortState?.drafts);
      expect(shares.getState().failure).toBe('busy');
      expect(h.calls.filter((call) => call.path.endsWith('/content-shares/create'))).toHaveLength(0);
      expect(h.calls.filter((call) => call.path.endsWith('/pairs/read'))).toHaveLength(0);
      expect(h.calls.filter((call) => call.path.endsWith('/conversations/send'))).toHaveLength(1);
      await shares.create({ target, audience: { kind: 'public_metadata' } });
      const sharedCommand = shares.getState().command;
      expect(sharedCommand).toMatchObject({ status: 'accepted', operation: 'create', commandId: id(72) });
      expect(h.calls.filter((call) => call.path.endsWith('/content-shares/create'))).toHaveLength(1);
      held.open(
        draftKind === 'sent'
          ? response('/v1/social/conversations/send', original)
          : new Response(JSON.stringify(problemDetails('FORBIDDEN')), {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            }),
      );
      await pending;
      expect(shares.getState().command).toEqual(sharedCommand);
      expect(h.session.getState().drafts).toEqual(abortState?.drafts);
      expect(owner.busy()).toBe(false);
      h.scope.end();
      expect(h.session.getState()).toMatchObject({
        status: 'ended',
        windows: [],
        drafts: [],
        command: { status: 'idle' },
      });
      expect(shares.getState()).toMatchObject({ status: 'ended', tokenAvailable: false });
      assertNoPersistence(h.scope, h.store.keys());
    },
  );
});
