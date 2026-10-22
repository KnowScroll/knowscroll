import type { AccountScope } from './account-scope';
import { ScopeEndedError } from './account-scope';
import { createFriendsHttp, freezeFriends, FRIENDS_LIMITS, FriendsHttpError, sameFriendsId } from './friends-http';
import type {
  FriendsAcceptance,
  FriendsCommandDraft,
  FriendsCommandOperation,
  FriendsCursor,
  FriendsFilter,
  FriendsInput,
  FriendsOperation,
  FriendsOutput,
  FriendsPage,
  FriendsSession,
  FriendsState,
} from './friends-types';

type Field = 'profile' | 'lookup' | 'pair' | 'invites' | 'resolvedInvite' | 'roster';
type Pending = { [K in FriendsCommandOperation]: { operation: K; input: FriendsInput<K> } }[FriendsCommandOperation];
const empty = (status: 'active' | 'ended', filter: FriendsFilter): FriendsState =>
  freezeFriends({
    status,
    filter,
    profile: { status: 'idle' },
    lookup: { status: 'idle' },
    pair: { status: 'idle' },
    invites: { status: 'idle' },
    resolvedInvite: { status: 'idle' },
    roster: { status: 'idle' },
    canPrevious: false,
    canNext: false,
    command: { status: 'idle' },
  });
/** Ephemeral scope-object-owned Friends controller. No polling, persistence, hints or observations. */
export function createFriendsSession(options: { scope: AccountScope; newCommandId: () => string }): FriendsSession {
  const { scope } = options;
  if (!scope.active || typeof scope.onEnd !== 'function') throw new ScopeEndedError();
  const http = createFriendsHttp(scope);
  let state = empty('active', 'friends');
  let ended = false,
    readSerial = 0,
    commandSerial = 0;
  let readController: AbortController | undefined, commandController: AbortController | undefined;
  let reading = false;
  let queued: { run: () => Promise<void>; done: () => void } | undefined;
  let pending: Pending | undefined;
  let inviteToken: string | undefined, resolvedToken: string | undefined;
  let currentCursor: FriendsCursor | undefined;
  // Entries are page-start cursors only. No old page/body is retained.
  let previous: (FriendsCursor | undefined)[] = [];
  const listeners = new Set<() => void>();
  let publication = 0;
  const publish = (next: FriendsState) => {
    state = freezeFriends(next);
    const mine = ++publication;
    for (const listener of [...listeners]) {
      if (mine !== publication) break;
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        /* A consumer cannot prevent another consumer's scope purge. */
      }
    }
  };
  const live = () => !ended && scope.active;
  const resetPages = () => {
    currentCursor = undefined;
    previous = [];
  };
  const end = () => {
    if (ended) return;
    ended = true;
    readSerial++;
    commandSerial++;
    readController?.abort();
    commandController?.abort();
    readController = commandController = undefined;
    queued?.done();
    queued = undefined;
    pending = undefined;
    inviteToken = resolvedToken = undefined;
    resetPages();
    publish(empty('ended', 'friends'));
    listeners.clear();
  };
  const off = scope.onEnd(end);
  async function dispatch(run: () => Promise<void>): Promise<void> {
    if (reading) {
      queued?.done();
      await new Promise<void>((done) => {
        queued = { run, done };
      });
      return;
    }
    reading = true;
    try {
      await run();
    } finally {
      reading = false;
      const next = queued;
      queued = undefined;
      if (next) void dispatch(next.run).finally(next.done);
    }
  }
  async function read<K extends FriendsOperation>(
    field: Field,
    operation: K,
    input: FriendsInput<K>,
    apply?: (value: FriendsOutput<K>) => void,
  ): Promise<void> {
    if (!live()) return;
    const serial = ++readSerial;
    readController?.abort();
    const controller = new AbortController();
    readController = controller;
    const next = { ...state };
    for (const key of ['profile', 'lookup', 'pair', 'invites', 'resolvedInvite', 'roster'] as const)
      if (next[key].status === 'loading') next[key] = { status: 'idle' };
    next[field] = { status: 'loading' };
    if (field === 'roster') next.canNext = next.canPrevious = false;
    publish(next);
    const current = () => live() && serial === readSerial && !controller.signal.aborted;
    await dispatch(async () => {
      if (!current()) return;
      try {
        const reply = await http.call(operation, input, controller.signal);
        if (!current()) return;
        apply?.(reply);
        if (!current()) return;
        // Field and operation are paired only by the named public read methods below.
        publish({ ...state, [field]: { status: 'ready', data: reply } });
      } catch (error) {
        if (!current()) return;
        const reason = error instanceof FriendsHttpError ? error.reason : 'invalid';
        if (reason === 'authority') {
          end();
          return;
        }
        if (field === 'roster') {
          // A failed continuation never means the roster ended or became empty.
          // Refresh starts at the first page; no guessed or changed cursor is retried.
          resetPages();
          publish({ ...state, canNext: false, canPrevious: false, roster: { status: 'unavailable', reason } });
        } else publish({ ...state, [field]: { status: 'unavailable', reason } });
      }
    });
  }
  async function page(cursor: FriendsCursor | undefined, history: (FriendsCursor | undefined)[]): Promise<void> {
    if (!live()) return;
    const filter = state.filter;
    let requestId: string;
    try {
      requestId = options.newCommandId();
    } catch {
      requestId = '';
    }
    const input = {
      version: 'friend-pages.v2' as const,
      requestId,
      filter,
      limit: FRIENDS_LIMITS.pageItems,
      ...(cursor ? { cursor } : {}),
    };
    const apply = (reply: FriendsPage) => {
      if (reply.next && history.some((c) => c?.token === reply.next?.token))
        throw new FriendsHttpError('invalid', false);
      currentCursor = cursor;
      previous = history;
      // Published atomically with the ready page by read().
      state = { ...state, canPrevious: previous.length > 0, canNext: !!reply.next };
    };
    if (filter === 'friends' || filter === 'blocked') await read('roster', 'friends', { ...input, filter }, apply);
    else await read('roster', 'requests', { ...input, filter }, apply);
  }
  function boundCommand(command: Pending): boolean {
    const body = command.input;
    if (command.operation === 'setProfile')
      return (
        state.profile.status === 'ready' && state.profile.data.profileRevision === command.input.expectedProfileRevision
      );
    if (command.operation === 'createInvite' || command.operation === 'revokeInvite') {
      if (state.invites.status !== 'ready') return false;
      const invite = state.invites.data.invite;
      return (
        invite.inviteRevision === command.input.expectedInviteRevision &&
        (command.operation === 'createInvite'
          ? invite.status !== 'active'
          : invite.status === 'active' && sameFriendsId(invite.linkId, command.input.linkId))
      );
    }
    if (command.operation === 'request') {
      const { target, expectedPeerPersonId, expectedPairRevision } = command.input;
      if (target.kind === 'handle')
        return (
          state.lookup.status === 'ready' &&
          state.lookup.data.status === 'available' &&
          state.lookup.data.person.handle === target.handle &&
          sameFriendsId(state.lookup.data.person.personId, expectedPeerPersonId) &&
          state.lookup.data.pairRevision === expectedPairRevision
        );
      return (
        target.token === resolvedToken &&
        state.resolvedInvite.status === 'ready' &&
        state.resolvedInvite.data.status === 'available' &&
        sameFriendsId(state.resolvedInvite.data.issuer.personId, expectedPeerPersonId) &&
        state.resolvedInvite.data.pairRevision === expectedPairRevision
      );
    }
    if (!('peerPersonId' in body)) return false;
    const pair =
      state.pair.status === 'ready' &&
      state.pair.data.status === 'available' &&
      sameFriendsId(state.pair.data.pair.peer.personId, body.peerPersonId)
        ? state.pair.data.pair
        : state.roster.status === 'ready'
          ? state.roster.data.items.find((p) => sameFriendsId(p.peer.personId, body.peerPersonId))
          : undefined;
    if (!pair || pair.pairRevision !== body.expectedPairRevision) return false;
    if ('requestId' in body && (!('requestId' in pair) || !sameFriendsId(pair.requestId, body.requestId))) return false;
    return command.operation === 'accept' || command.operation === 'decline'
      ? pair.state === 'incoming'
      : command.operation === 'cancel'
        ? pair.state === 'outgoing'
        : command.operation === 'remove'
          ? pair.state === 'friends'
          : command.operation === 'unblock'
            ? pair.state === 'blocked'
            : command.operation === 'block';
  }
  async function send(retry: boolean): Promise<void> {
    const command = pending;
    if (!live() || !command || state.command.status === 'pending') return;
    const serial = ++commandSerial;
    const controller = new AbortController();
    commandController = controller;
    publish({
      ...state,
      command: { status: 'pending', operation: command.operation, commandId: command.input.commandId },
    });
    try {
      const reply = await http.call(command.operation, command.input, controller.signal);
      if (!live() || serial !== commandSerial || controller.signal.aborted) return;
      const created = 'acceptance' in reply ? reply : undefined;
      const acceptance = created ? created.acceptance : (reply as FriendsAcceptance);
      inviteToken = created?.delivery.status === 'available' ? created.delivery.token : undefined;
      pending = undefined;
      // Fence reads started before the ACK so none can restore pre-command current state.
      readSerial++;
      readController?.abort();
      queued?.done();
      queued = undefined;
      resetPages();
      resolvedToken = undefined;
      const cleared = empty('active', state.filter);
      publish({
        ...cleared,
        command: {
          status: 'accepted',
          operation: command.operation,
          acceptance,
          delivery: inviteToken ? 'available' : 'unavailable',
        },
      });
    } catch (error) {
      if (!live() || serial !== commandSerial || controller.signal.aborted) return;
      const reason = error instanceof FriendsHttpError ? error.reason : 'invalid';
      if (reason === 'authority') {
        end();
        return;
      }
      // A later refusal cannot disprove an earlier ambiguous send. Preserve original bytes/ID.
      if (retry || !(error instanceof FriendsHttpError) || error.ambiguous)
        publish({
          ...state,
          command: { status: 'unknown', operation: command.operation, commandId: command.input.commandId },
        });
      else {
        pending = undefined;
        if (reason === 'refresh_required' || reason === 'conflict') {
          readSerial++;
          readController?.abort();
          queued?.done();
          queued = undefined;
          resetPages();
          resolvedToken = undefined;
          inviteToken = undefined;
          publish({
            ...empty('active', state.filter),
            command: { status: 'rejected', operation: command.operation, reason },
          });
        } else publish({ ...state, command: { status: 'rejected', operation: command.operation, reason } });
      }
    }
  }
  const session: FriendsSession = {
    getState: () => state,
    subscribe(listener) {
      if (ended) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readProfile: () => read('profile', 'profile', {}),
    lookup: (handle) => read('lookup', 'lookup', { version: 'sharing.v1', handle }),
    readPair: (peerPersonId) => read('pair', 'pair', { version: 'sharing.v1', peerPersonId }),
    readInvites: () => read('invites', 'invites', {}),
    resolveInvite(token) {
      resolvedToken = undefined;
      return read('resolvedInvite', 'resolveInvite', { version: 'sharing.v1', token }, (reply) => {
        if (reply.status === 'available') resolvedToken = token;
      });
    },
    async selectFilter(filter) {
      if (!live() || !['friends', 'incoming', 'outgoing', 'blocked'].includes(filter)) return;
      resetPages();
      state = { ...state, filter };
      await page(undefined, []);
    },
    refreshPage: () => page(undefined, []),
    async nextPage() {
      if (!live() || state.roster.status !== 'ready' || !state.roster.data.next) return;
      const history = [...previous, currentCursor].slice(-FRIENDS_LIMITS.previousCursors);
      await page(state.roster.data.next, history);
    },
    async previousPage() {
      if (!live() || state.roster.status !== 'ready' || previous.length === 0) return;
      await page(previous[previous.length - 1], previous.slice(0, -1));
    },
    async command<K extends FriendsCommandOperation>(operation: K, input: FriendsCommandDraft<K>) {
      if (!live() || pending) return;
      // Parse and detach the draft before retaining an exact retry body.
      let candidate: Pending;
      try {
        candidate = freezeFriends({
          operation,
          input: http.prepare(operation, {
            ...input,
            version: 'sharing.v1',
            commandId: options.newCommandId(),
          } as FriendsInput<K>),
        }) as Pending;
      } catch {
        publish({ ...state, command: { status: 'rejected', operation, reason: 'invalid' } });
        return;
      }
      if (!boundCommand(candidate)) {
        publish({ ...state, command: { status: 'rejected', operation, reason: 'refresh_required' } });
        return;
      }
      inviteToken = undefined;
      pending = candidate;
      await send(false);
    },
    retryCommand: () => (state.command.status === 'unknown' ? send(true) : Promise.resolve()),
    takeInviteToken() {
      if (!live()) return undefined;
      const token = inviteToken;
      inviteToken = undefined;
      if (state.command.status === 'accepted' && state.command.delivery === 'available')
        publish({ ...state, command: { ...state.command, delivery: 'unavailable' } });
      return token;
    },
    dispose() {
      end();
      off();
    },
  };
  return session;
}
