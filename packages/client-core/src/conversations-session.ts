import { QueryObserver } from '@tanstack/react-query';
import {
  DirectConversationRefSchema,
  ConversationContentRefSchema,
  type DirectConversationRef,
  type ConversationMessage,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createFriendsHttp } from './friends-http';
import {
  createConversationsHttp,
  SocialHttpError,
  socialFailure,
  sameContent,
  stableSocialMessages,
} from './conversations-http';
import {
  conversationKey,
  sameConversation,
  sameSocialId,
  socialData,
  freezeSocial,
  socialOwnerFor,
  SOCIAL_LIMITS,
  type ConversationsSession,
  type ConversationsState,
  type ConversationDraft,
  type ConversationInput,
  type ConversationMutation,
  type ConversationOutput,
  type ConversationWindow,
  type SocialFailure,
} from './conversations-types';
type Pending = {
  [K in ConversationMutation]: { operation: K; input?: ConversationInput<K>; ambiguous: boolean };
}[ConversationMutation];
type Window = {
  view: ConversationWindow;
  history?: string;
  changes?: string;
  lastChange?: number;
  ceiling?: number;
  historySeen: string[];
  changeSeen: string[];
  budget: object;
  tombstones?: readonly string[];
};
type ReadJob = {
  kind: 'inbox' | 'snapshot' | 'history' | 'changes' | 'recovery';
  ref?: DirectConversationRef;
  cursor?: string;
  serial: number;
  done: () => void;
};
let nextOwner = 0;
const empty = (): ConversationsState => ({
  status: 'active',
  focused: false,
  inbox: { status: 'idle' },
  windows: [],
  drafts: [],
  command: { status: 'idle' },
  recovery: { status: 'idle' },
  mutationBlocked: false,
});
const sessions = new WeakMap<AccountScope, ConversationsSession>();
/** One scope-lifetime owner. Focus changes only hint observation, never drafts or unknown commands. */
export function createConversationsSession(options: {
  scope: AccountScope;
  newCommandId: () => string;
}): ConversationsSession {
  const existing = sessions.get(options.scope);
  if (existing) return existing;
  const { scope } = options,
    owner = socialOwnerFor(scope),
    http = createConversationsHttp(scope),
    token = {},
    pendingBudget = {},
    inboxBudget = {};
  let state = freezeSocial(empty()),
    ended = false,
    serial = 0,
    commandSerial = 0,
    publication = 0,
    reading = false,
    preparingRetry = false;
  let controller: AbortController | undefined,
    commandController: AbortController | undefined,
    pending: Pending | undefined,
    queued: ReadJob | undefined;
  let inboxCursor: string | undefined,
    inboxWatermark = 0,
    inboxSeen: string[] = [],
    activeKey: string | undefined;
  const windows = new Map<string, Window>(),
    drafts = new Map<string, { conversation: DirectConversationRef; body: ConversationDraft; budget: object }>(),
    listeners = new Set<() => void>();
  const queryKey = scope.queryKey('conversations-trigger', ++nextOwner);
  let observer: QueryObserver<number> | undefined,
    completion = 0;
  const live = () => !ended && owner.live();
  function publish(patch: Partial<ConversationsState> = {}) {
    state = freezeSocial({
      ...state,
      ...patch,
      windows: [...windows.values()].map((w) => w.view),
      drafts: [...drafts.values()].map(({ conversation, body }) => ({ conversation, body })),
      mutationBlocked: owner.busy(),
    });
    const mine = ++publication;
    for (const listener of [...listeners]) {
      if (mine !== publication) break;
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        /* A subscriber cannot block scope purge. */
      }
    }
  }
  function dropDraft(key: string) {
    const d = drafts.get(key);
    if (d) owner.drop(d.budget);
    drafts.delete(key);
  }
  function stopReads() {
    serial++;
    controller?.abort();
    controller = undefined;
    queued?.done();
    queued = undefined;
  }
  const stopObserver = () => {
    observer?.destroy();
    observer = undefined;
    void scope.queryClient.cancelQueries({ queryKey });
    scope.queryClient.removeQueries({ queryKey });
  };
  function end() {
    if (ended) return;
    ended = true;
    stopReads();
    commandSerial++;
    commandController?.abort();
    commandController = undefined;
    stopObserver();
    if (pending) pending.input = undefined;
    pending = undefined;
    windows.clear();
    drafts.clear();
    inboxCursor = undefined;
    inboxSeen = [];
    inboxWatermark = 0;
    activeKey = undefined;
    state = freezeSocial({ ...empty(), status: 'ended' });
  }
  owner.onEnd(end, () => {
    publish();
    listeners.clear();
  });
  owner.subscribe(() => {
    if (live()) publish();
  });
  function fail(reason: SocialFailure) {
    if (live()) publish({ failure: reason });
  }
  function refOf(input: DirectConversationRef): DirectConversationRef | undefined {
    if (!socialData(input)) return undefined;
    const p = DirectConversationRefSchema.safeParse(input);
    return p.success ? freezeSocial(p.data) : undefined;
  }
  function clearWindow(ref: DirectConversationRef, reason: SocialFailure) {
    const key = conversationKey(ref),
      w = windows.get(key);
    if (w) {
      owner.drop(w.budget);
      windows.set(key, {
        ...w,
        view: {
          conversation: ref,
          status: reason === 'refresh_required' ? 'refresh_required' : 'unavailable',
          reason,
          latestMessageSequence: 0,
          messages: [],
          historyAvailable: false,
          catchUp: 'refresh_required',
        },
        history: undefined,
        changes: undefined,
        historySeen: [],
        changeSeen: [],
        lastChange: undefined,
        ceiling: undefined,
      });
    }
    dropDraft(key);
    owner.forget(ref);
    publish({ failure: reason });
  }
  function unavailable(reason: SocialFailure, ref?: DirectConversationRef) {
    if (ref) {
      // A temporary failed page cannot silently evict an editable draft or retained page.
      // Authority failures purge them; retained history is explicitly unavailable for mutation.
      if (reason === 'authority' || reason === 'unavailable') clearWindow(ref, reason);
      else {
        const key = conversationKey(ref),
          w = windows.get(key);
        if (w)
          windows.set(key, {
            ...w,
            view: { ...w.view, status: 'refresh_required', reason, catchUp: 'refresh_required' },
          });
        publish({ failure: reason });
      }
      return;
    }
    owner.drop(inboxBudget);
    inboxCursor = undefined;
    inboxSeen = [];
    publish({ inbox: { status: 'unavailable', reason }, failure: reason });
  }
  function install(key: string, next: Window) {
    const tombstones = new Set(next.tombstones ?? []);
    for (const m of next.view.messages) {
      const id = m.messageId.toLowerCase();
      if (m.status === 'unavailable') tombstones.add(id);
      else if (tombstones.has(id)) throw new SocialHttpError('invalid', false);
    }
    if (tombstones.size > SOCIAL_LIMITS.messages) throw new SocialHttpError('capacity', false);
    next = { ...next, tombstones: [...tombstones] };
    if (!owner.retain(next.budget, next.view)) throw new SocialHttpError('capacity', false);
    windows.set(key, next);
  }
  function mergeMessages(
    old: readonly ConversationMessage[],
    incoming: readonly ConversationMessage[],
  ): ConversationMessage[] {
    if (!stableSocialMessages([...old, ...incoming], true)) throw new SocialHttpError('invalid', false);
    const map = new Map(old.map((m) => [m.messageId.toLowerCase(), m]));
    for (const m of incoming) {
      const previous = map.get(m.messageId.toLowerCase());
      if (previous?.status === 'unavailable' && m.status !== 'unavailable') throw new SocialHttpError('invalid', false);
      map.set(m.messageId.toLowerCase(), m);
    }
    const messages = [...map.values()].sort((a, b) => a.sequence - b.sequence);
    if (messages.length > SOCIAL_LIMITS.messages) throw new SocialHttpError('capacity', false);
    return messages;
  }
  function dropSentDraft(ref: DirectConversationRef, sent: ConversationDraft) {
    const key = conversationKey(ref),
      d = drafts.get(key)?.body;
    if (!d || d.kind !== sent.kind) return;
    const same =
      d.kind === 'text'
        ? sent.kind === 'text' && d.text === sent.text
        : sent.kind === 'content' && sameContent(d.target, sent.target) && d.note === sent.note;
    if (same) dropDraft(key);
  }
  async function run(job: ReadJob) {
    const abort = new AbortController();
    controller = abort;
    const current = () => live() && serial === job.serial && !abort.signal.aborted;
    if (!current()) return;
    const ref = job.ref,
      key = ref ? conversationKey(ref) : undefined;
    try {
      const readId = options.newCommandId();
      if (job.kind === 'inbox') {
        const b = await http.call(
          'inbox',
          {
            version: 'direct-conversation.v1',
            readId,
            limit: SOCIAL_LIMITS.page,
            ...(job.cursor ? { cursor: job.cursor } : {}),
          },
          abort.signal,
        );
        if (!current()) return;
        if (b.status === 'refresh_required') {
          unavailable('refresh_required');
          return;
        }
        if (
          b.viewRevision < inboxWatermark ||
          (b.continuation.kind === 'more' &&
            (inboxSeen.includes(b.continuation.cursor) || inboxSeen.length >= SOCIAL_LIMITS.cursorHistory))
        )
          throw new SocialHttpError('refresh_required', false);
        if (!owner.retain(inboxBudget, b)) throw new SocialHttpError('capacity', false);
        inboxWatermark = b.viewRevision;
        inboxCursor = b.continuation.kind === 'more' ? b.continuation.cursor : undefined;
        if (job.cursor) inboxSeen.push(job.cursor);
        for (const row of b.items) {
          const retained = windows.get(conversationKey(row.conversation));
          if (
            row.lastMessage?.status === 'available' &&
            retained?.tombstones?.includes(row.lastMessage.messageId.toLowerCase())
          )
            throw new SocialHttpError('invalid', false);
          // A newly certified membership invalidates any older locator for the same thread.
          for (const old of [...windows.values()])
            if (
              sameSocialId(old.view.conversation.conversationId, row.conversation.conversationId) &&
              !sameConversation(old.view.conversation, row.conversation)
            )
              clearWindow(old.view.conversation, 'unavailable');
          if (!current()) return;
          if (!owner.remember(row.conversation)) throw new SocialHttpError('capacity', false);
        }
        publish({ inbox: { status: 'ready', data: b }, failure: undefined });
        return;
      }
      if (!ref || !key) return;
      const w = windows.get(key);
      if (job.kind === 'recovery') {
        const p = pending;
        if (!p?.input || p.operation !== 'send' || !sameConversation(p.input.conversation, ref) || !owner.knows(ref))
          return;
        const b = await http.call(
          'readOwnSend',
          {
            version: 'direct-conversation.v1',
            readId,
            conversation: ref,
            selector: { kind: 'command', commandId: p.input.commandId },
          },
          abort.signal,
        );
        if (!current() || pending !== p) return;
        // Status recovery is historical correlation, never a current message snapshot.
        const currentWindow = windows.get(key);
        if (currentWindow) {
          owner.drop(currentWindow.budget);
          windows.set(key, {
            ...currentWindow,
            view: {
              conversation: ref,
              status: 'refresh_required',
              latestMessageSequence: currentWindow.view.latestMessageSequence,
              messages: [],
              historyAvailable: false,
              catchUp: 'refresh_required',
            },
            history: undefined,
            changes: undefined,
          });
        }
        if (b.status === 'accepted') {
          if (
            p.input.body.kind !== b.sent.kind ||
            (p.input.body.kind === 'content' &&
              (b.sent.kind !== 'content' || !sameContent(p.input.body.target, b.sent.target)))
          )
            throw new SocialHttpError('invalid', false);
          const id = p.input.commandId;
          dropSentDraft(p.input.conversation, p.input.body);
          pending = undefined;
          owner.drop(pendingBudget);
          state = { ...state, command: { status: 'accepted', operation: 'send', commandId: id } };
          p.input = undefined;
          owner.release(token);
          if (!current()) return;
        }
        publish({ recovery: { status: 'ready', data: b } });
        return;
      }
      if (!w) return;
      if (job.kind === 'snapshot') {
        const b = await http.call(
          'read',
          { version: 'direct-conversation.v1', readId, conversation: ref, limit: SOCIAL_LIMITS.page },
          abort.signal,
        );
        if (!current()) return;
        if (b.status === 'unavailable') {
          unavailable('unavailable', ref);
          return;
        }
        if (b.latestMessageSequence < w.view.latestMessageSequence) throw new SocialHttpError('invalid', false);
        install(key, {
          ...w,
          view: {
            conversation: b.conversation,
            status: 'ready',
            peer: b.peer,
            own: b.own,
            latestMessageSequence: b.latestMessageSequence,
            messages: b.messages,
            historyAvailable: b.history.kind === 'more',
            catchUp: 'available',
          },
          history: b.history.kind === 'more' ? b.history.cursor : undefined,
          changes: b.catchUpCursor,
          historySeen: [],
          changeSeen: [],
          lastChange: undefined,
          ceiling: undefined,
        });
        owner.remember(b.conversation);
        publish({ failure: undefined });
        return;
      }
      if (!job.cursor || w.view.status !== 'ready') return;
      if (job.kind === 'history') {
        const b = await http.call(
          'history',
          {
            version: 'direct-conversation.v1',
            readId,
            conversation: ref,
            limit: SOCIAL_LIMITS.page,
            cursor: job.cursor,
          },
          abort.signal,
        );
        if (!current()) return;
        if (b.status !== 'ready') {
          unavailable(b.status === 'unavailable' ? 'unavailable' : 'refresh_required', ref);
          return;
        }
        if (
          (b.continuation.kind === 'more' &&
            (w.historySeen.includes(b.continuation.cursor) || w.historySeen.length >= SOCIAL_LIMITS.cursorHistory)) ||
          b.messages.some((m) => m.sequence >= (w.view.messages[0]?.sequence ?? Infinity))
        )
          throw new SocialHttpError('refresh_required', false);
        const messages = mergeMessages(w.view.messages, b.messages);
        install(key, {
          ...w,
          view: { ...w.view, messages, historyAvailable: b.continuation.kind === 'more' },
          history: b.continuation.kind === 'more' ? b.continuation.cursor : undefined,
          historySeen: [...w.historySeen, job.cursor],
        });
        publish({ failure: undefined });
        return;
      }
      const b = await http.call(
        'changes',
        { version: 'direct-conversation.v1', readId, conversation: ref, limit: SOCIAL_LIMITS.page, cursor: job.cursor },
        abort.signal,
      );
      if (!current()) return;
      if (b.status !== 'ready') {
        unavailable(b.status === 'unavailable' ? 'unavailable' : 'refresh_required', ref);
        return;
      }
      if (
        (w.lastChange !== undefined
          ? b.fromChangeSequence !== w.lastChange
          : b.fromChangeSequence < w.view.latestMessageSequence) ||
        (w.ceiling !== undefined && b.throughChangeSequence !== w.ceiling) ||
        (b.continuation.kind === 'more' &&
          (w.changeSeen.includes(b.continuation.cursor) || w.changeSeen.length >= SOCIAL_LIMITS.cursorHistory))
      )
        throw new SocialHttpError('refresh_required', false);
      const messages = mergeMessages(
          w.view.messages,
          b.changes.map((c) => c.message),
        ),
        lastChange = b.changes.at(-1)?.changeSequence ?? b.fromChangeSequence;
      install(key, {
        ...w,
        view: {
          ...w.view,
          messages,
          latestMessageSequence: Math.max(w.view.latestMessageSequence, ...messages.map((m) => m.sequence)),
          catchUp: b.continuation.kind,
        },
        changes: b.continuation.cursor,
        lastChange,
        ceiling: b.continuation.kind === 'more' ? b.throughChangeSequence : undefined,
        changeSeen: b.continuation.kind === 'more' ? [...w.changeSeen, job.cursor] : [],
      });
      publish({ failure: undefined });
    } catch (e) {
      if (current()) {
        const error = socialFailure(e);
        if (job.kind === 'recovery')
          publish({ recovery: { status: 'unavailable', reason: error.reason }, failure: error.reason });
        else if (
          (job.kind === 'history' || job.kind === 'changes') &&
          (error.reason === 'network' || error.reason === 'capacity') &&
          key
        ) {
          // A failed optional page does not revoke the separately certified current snapshot.
          // Keep its bounded data readable; capacity discloses that this window cannot grow.
          const retained = windows.get(key);
          if (retained)
            windows.set(key, {
              ...retained,
              view: {
                ...retained.view,
                reason: error.reason,
                ...(error.reason === 'capacity' && job.kind === 'history' ? { historyAvailable: false } : {}),
                ...(error.reason === 'capacity' && job.kind === 'changes'
                  ? { catchUp: 'refresh_required' as const }
                  : {}),
              },
              ...(error.reason === 'capacity' && job.kind === 'history' ? { history: undefined } : {}),
            });
          publish({ failure: error.reason });
        } else unavailable(error.reason, ref);
      }
    }
  }
  async function dispatch(job: ReadJob) {
    if (reading) {
      queued?.done();
      queued = job;
      return;
    }
    reading = true;
    try {
      await run(job);
    } finally {
      reading = false;
      job.done();
      const next = queued;
      queued = undefined;
      if (next && live()) void dispatch(next);
    }
  }
  function read(kind: ReadJob['kind'], ref?: DirectConversationRef, cursor?: string): Promise<void> {
    if (!live()) return Promise.resolve();
    const mine = ++serial;
    if (kind === 'inbox') {
      owner.drop(inboxBudget);
      publish({ inbox: { status: 'loading' } });
    }
    if (kind === 'snapshot' && ref) {
      const key = conversationKey(ref),
        w = windows.get(key);
      if (w) {
        owner.drop(w.budget);
        windows.set(key, {
          ...w,
          view: {
            conversation: ref,
            status: 'loading',
            latestMessageSequence: w.view.latestMessageSequence,
            messages: [],
            historyAvailable: false,
            catchUp: 'refresh_required',
          },
          history: undefined,
          changes: undefined,
          historySeen: [],
          changeSeen: [],
        });
        publish();
      }
    }
    if (kind === 'recovery') publish({ recovery: { status: 'loading' } });
    if (!live() || serial !== mine) return Promise.resolve();
    controller?.abort();
    if (!live() || serial !== mine) return Promise.resolve();
    return new Promise((done) => {
      void dispatch({ kind, ...(ref ? { ref } : {}), ...(cursor ? { cursor } : {}), serial: mine, done });
    });
  }
  function ready(ref: DirectConversationRef): Window | undefined {
    const w = windows.get(conversationKey(ref));
    return live() && w?.view.status === 'ready' && owner.knows(ref) ? w : undefined;
  }
  function validMutation(p: Pending): boolean {
    if (!p.input) return false;
    if (p.operation === 'start') return false;
    const w = ready(p.input.conversation);
    if (!w) return false;
    if (p.operation !== 'markRead') return true;
    const through = p.input.throughSequence;
    return (
      through <= w.view.latestMessageSequence && (through === 0 || w.view.messages.some((m) => m.sequence === through))
    );
  }
  async function sendPending(retry: boolean) {
    const p = pending;
    if (!live() || !p?.input || state.command.status === 'pending') return;
    if (preparingRetry) return;
    if (retry && p.operation === 'start') {
      preparingRetry = true;
      const mine = ++commandSerial,
        abort = new AbortController();
      commandController = abort;
      try {
        const pair = await createFriendsHttp(scope).call(
          'pair',
          { version: 'sharing.v1', peerPersonId: p.input.peerPersonId },
          abort.signal,
        );
        if (!live() || mine !== commandSerial || pending !== p) return;
        if (
          pair.status !== 'available' ||
          pair.pair.state !== 'friends' ||
          !sameSocialId(pair.pair.peer.personId, p.input.peerPersonId) ||
          pair.pair.pairRevision !== p.input.expectedPairRevision
        ) {
          fail('refresh_required');
          return;
        }
      } catch {
        if (live() && pending === p) fail('unavailable');
        return;
      } finally {
        preparingRetry = false;
      }
      if (!live() || pending !== p) return;
    }
    if (retry && p.operation !== 'start' && !validMutation(p)) {
      fail('refresh_required');
      return;
    }
    const mine = ++commandSerial,
      abort = new AbortController();
    commandController = abort;
    state = { ...state, command: { status: 'pending', operation: p.operation, commandId: p.input.commandId } };
    publish();
    if (!live() || mine !== commandSerial) return;
    try {
      const reply = await http.call(p.operation, p.input, abort.signal);
      if (!live() || mine !== commandSerial || abort.signal.aborted || pending !== p) return;
      pending = undefined;
      owner.drop(pendingBudget);
      if (p.operation === 'start') {
        if (!owner.remember((reply as ConversationOutput<'start'>).conversation))
          state = { ...state, failure: 'capacity' };
      } else {
        const key = conversationKey(p.input.conversation),
          w = windows.get(key);
        if (w) {
          owner.drop(w.budget);
          windows.set(key, {
            ...w,
            view: {
              conversation: w.view.conversation,
              status: p.operation === 'leave' ? 'unavailable' : 'refresh_required',
              latestMessageSequence: w.view.latestMessageSequence,
              messages: [],
              historyAvailable: false,
              catchUp: 'refresh_required',
            },
            history: undefined,
            changes: undefined,
          });
        }
        if (p.operation === 'send') dropSentDraft(p.input.conversation, p.input.body);
        if (p.operation === 'leave') dropDraft(key);
        if (p.operation === 'leave') owner.forget(p.input.conversation);
      }
      state = { ...state, command: { status: 'accepted', operation: p.operation, commandId: p.input.commandId } };
      if (p.operation === 'start') {
        const ref = (reply as ConversationOutput<'start'>).conversation;
        if (!windows.has(conversationKey(ref)) && windows.size < SOCIAL_LIMITS.windows)
          windows.set(conversationKey(ref), {
            budget: {},
            view: {
              conversation: ref,
              status: 'refresh_required',
              latestMessageSequence: 0,
              messages: [],
              historyAvailable: false,
              catchUp: 'refresh_required',
            },
            historySeen: [],
            changeSeen: [],
          });
      }
      p.input = undefined;
      owner.release(token);
      if (live() && mine === commandSerial) publish();
    } catch (e) {
      if (!live() || mine !== commandSerial || pending !== p || !p.input) return;
      const error = socialFailure(e);
      p.ambiguous ||= error.ambiguous;
      if (error.reason === 'authority') {
        for (const w of [...windows.values()]) {
          clearWindow(w.view.conversation, 'authority');
          if (!live() || pending !== p) return;
        }
        owner.drop(inboxBudget);
        state = { ...state, inbox: { status: 'unavailable', reason: 'authority' }, recovery: { status: 'idle' } };
      }
      if (p.ambiguous)
        publish({
          command: { status: 'unknown', operation: p.operation, commandId: p.input.commandId },
          failure: error.reason,
        });
      else {
        pending = undefined;
        owner.drop(pendingBudget);
        state = { ...state, command: { status: 'rejected', reason: error.reason } };
        p.input = undefined;
        owner.release(token);
        if (live()) publish();
      }
    }
  }
  function mutate<K extends Exclude<ConversationMutation, 'start'>>(
    operation: K,
    refInput: DirectConversationRef,
    fields: Omit<ConversationInput<K>, 'version' | 'commandId' | 'conversation'>,
  ): Promise<void> {
    const ref = refOf(refInput);
    if (!live() || !ref) return Promise.resolve();
    if (owner.busy()) {
      fail('busy');
      return Promise.resolve();
    }
    try {
      const input = http.prepare(operation, {
          version: 'direct-conversation.v1',
          commandId: options.newCommandId(),
          conversation: ref,
          ...fields,
        }),
        p = { operation, input, ambiguous: false } as Pending;
      if (!validMutation(p)) {
        fail('refresh_required');
        return Promise.resolve();
      }
      if (!owner.retain(pendingBudget, p.input)) {
        fail('capacity');
        return Promise.resolve();
      }
      if (!owner.claim(token)) {
        owner.drop(pendingBudget);
        return Promise.resolve();
      }
      pending = p;
      stopReads();
      state = { ...state, command: { status: 'idle' } };
      return sendPending(false);
    } catch {
      fail('invalid');
      return Promise.resolve();
    }
  }
  const session: ConversationsSession = {
    getState: () => (owner.live() ? state : freezeSocial({ ...empty(), status: 'ended' })),
    subscribe(listener) {
      if (!live()) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    focus(active) {
      if (!live() || active === state.focused) return;
      if (!active) {
        publish({ focused: false });
        if (!live()) return;
        stopObserver();
        stopReads();
        return;
      }
      state = { ...state, focused: true };
      const selected = activeKey ? windows.get(activeKey)?.view.conversation : undefined;
      // Focus/resync revalidates current authority. Purge prior server bodies synchronously,
      // before even the metadata-triggered HTTP starts. Drafts remain private and disabled.
      const initial = selected ? read('snapshot', selected) : Promise.resolve();
      if (!selected) publish();
      if (!live()) return;
      let first = true;
      observer = new QueryObserver<number>(scope.queryClient, {
        queryKey,
        queryFn: async () => {
          if (first) {
            first = false;
            await initial;
          } else {
            const ref = activeKey ? windows.get(activeKey)?.view.conversation : undefined;
            if (ref) await read('snapshot', ref);
          }
          if (live()) await session.refreshInbox();
          return ++completion;
        },
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      });
      observer.subscribe(() => {
        /* Metadata-only completion trigger. */
      });
    },
    async refreshInbox() {
      inboxCursor = undefined;
      inboxSeen = [];
      await read('inbox');
    },
    async nextInbox() {
      if (!live() || !inboxCursor || state.inbox.status !== 'ready') return;
      await read('inbox', undefined, inboxCursor);
    },
    async open(input) {
      const ref = refOf(input);
      if (!live() || !ref || !owner.knows(ref)) {
        fail('refresh_required');
        return;
      }
      const key = conversationKey(ref);
      let w = windows.get(key);
      if (!w) {
        if (windows.size >= SOCIAL_LIMITS.windows) {
          fail('capacity');
          return;
        }
        w = {
          budget: {},
          view: {
            conversation: ref,
            status: 'loading',
            latestMessageSequence: 0,
            messages: [],
            historyAvailable: false,
            catchUp: 'available',
          },
          historySeen: [],
          changeSeen: [],
        };
        windows.set(key, w);
      }
      activeKey = key;
      owner.drop(w.budget);
      windows.set(key, { ...w, view: { ...w.view, status: 'loading', peer: undefined, own: undefined, messages: [] } });
      publish();
      await read('snapshot', ref);
    },
    async refreshConversation(ref) {
      const key = refOf(ref);
      if (key && (windows.has(conversationKey(key)) || owner.knows(key))) {
        owner.remember(key);
        await session.open(key);
      } else fail('refresh_required');
    },
    async history(ref) {
      const r = refOf(ref),
        w = r ? ready(r) : undefined;
      if (r && w?.history) await read('history', r, w.history);
    },
    async catchUp(ref) {
      const r = refOf(ref),
        w = r ? ready(r) : undefined;
      if (r && w?.changes) await read('changes', r, w.changes);
    },
    setDraft(input, value) {
      const ref = refOf(input);
      if (!ref || !ready(ref)) {
        fail('refresh_required');
        return;
      }
      const key = conversationKey(ref);
      if (value === undefined) {
        dropDraft(key);
        publish();
        return;
      }
      if (!socialData(value)) {
        fail('invalid');
        return;
      }
      const valid =
        value.kind === 'text'
          ? Object.keys(value).length === 2 &&
            typeof value.text === 'string' &&
            value.text.length <= SOCIAL_LIMITS.draftCharacters
          : value.kind === 'content' &&
            Object.keys(value).every((k) => ['kind', 'target', 'note'].includes(k)) &&
            ConversationContentRefSchema.safeParse(value.target).success &&
            (value.note === undefined ||
              (typeof value.note === 'string' && value.note.length <= SOCIAL_LIMITS.draftCharacters));
      if (!valid) {
        fail('invalid');
        return;
      }
      if (value.kind === 'text' && value.text === '') {
        dropDraft(key);
        publish();
        return;
      }
      const old = drafts.get(key);
      if (!old && drafts.size >= SOCIAL_LIMITS.drafts) {
        fail('capacity');
        return;
      }
      const body = freezeSocial(JSON.parse(JSON.stringify(value)) as ConversationDraft),
        budget = old?.budget ?? {};
      if (!owner.retain(budget, body)) {
        fail('capacity');
        return;
      }
      drafts.set(key, { conversation: ref, body, budget });
      publish({ failure: undefined });
    },
    send(ref) {
      const r = refOf(ref),
        draft = r ? drafts.get(conversationKey(r)) : undefined;
      return r && draft ? mutate('send', r, { body: draft.body }) : Promise.resolve();
    },
    async start(peerPersonId) {
      if (!live() || owner.busy()) {
        fail('busy');
        return;
      }
      let commandId: string;
      try {
        commandId = options.newCommandId();
        http.prepare('start', { version: 'direct-conversation.v1', commandId, peerPersonId, expectedPairRevision: 1 });
      } catch {
        fail('invalid');
        return;
      }
      if (!owner.claim(token)) return;
      const mine = ++commandSerial,
        abort = new AbortController();
      commandController = abort;
      stopReads();
      publish({ command: { status: 'pending', operation: 'start', commandId } });
      try {
        const pair = await createFriendsHttp(scope).call('pair', { version: 'sharing.v1', peerPersonId }, abort.signal);
        if (!live() || mine !== commandSerial || abort.signal.aborted) return;
        if (
          pair.status !== 'available' ||
          pair.pair.state !== 'friends' ||
          !sameSocialId(pair.pair.peer.personId, peerPersonId)
        )
          throw new SocialHttpError('unavailable', false);
        pending = {
          operation: 'start',
          input: http.prepare('start', {
            version: 'direct-conversation.v1',
            commandId,
            peerPersonId,
            expectedPairRevision: pair.pair.pairRevision,
          }),
          ambiguous: false,
        };
        state = { ...state, command: { status: 'idle' } };
        await sendPending(false);
      } catch {
        if (live() && mine === commandSerial) {
          state = { ...state, command: { status: 'rejected', reason: 'unavailable' } };
          owner.release(token);
          if (live()) publish();
        }
      }
    },
    async markRead(ref, throughSequence) {
      await mutate('markRead', ref, { throughSequence });
    },
    async mute(ref, muted) {
      await mutate('mute', ref, { muted });
    },
    async leave(ref) {
      await mutate('leave', ref, {});
    },
    async recoverOwnSend(input) {
      const ref = refOf(input);
      if (ref && ready(ref)) await read('recovery', ref);
      else fail('refresh_required');
    },
    async retryCommand() {
      if (pending && state.command.status === 'unknown') await sendPending(true);
    },
    forgetWindow(input) {
      const ref = refOf(input);
      if (!live() || !ref) return;
      const key = conversationKey(ref);
      if (
        activeKey === key ||
        (pending?.input && 'conversation' in pending.input && sameConversation(ref, pending.input.conversation))
      ) {
        fail('busy');
        return;
      }
      const w = windows.get(key);
      if (w) owner.drop(w.budget);
      windows.delete(key);
      dropDraft(key);
      owner.forget(ref);
      publish({ failure: undefined });
    },
    dispose: () => owner.end(),
  };
  sessions.set(scope, session);
  return session;
}
