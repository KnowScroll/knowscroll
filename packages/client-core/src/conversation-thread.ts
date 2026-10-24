import type {
  ConversationMessage,
  DirectConversationRef,
  PublicPersonRef,
  SendConversationMessage,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { awayAfter, newestSequence } from './away-divider';
import { talkFailure } from './talk-failure';

const VERSION = 'direct-conversation.v1' as const;
const SNAPSHOT_LIMIT = 30;
const CHANGES_LIMIT = 50;

export type MessageBody = SendConversationMessage['body'];

/**
 * A message the person has sent that the thread has not yet read back in order.
 * - `sending`: the request is in flight.
 * - `accepted`: the server stored it; it leaves this list when its message arrives in the thread.
 * - `unconfirmed`: no answer came. It may or may not have been stored; retrying sends the identical
 *   command, so it can never appear twice.
 * - `not_sent`: the server refused it.
 */
export interface OutgoingMessage {
  readonly commandId: string;
  readonly body: MessageBody;
  readonly status: 'sending' | 'accepted' | 'unconfirmed' | 'not_sent';
  readonly sequence?: number;
}

export interface ThreadState {
  /** `unavailable`: not a member, blocked or removed; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly peer: PublicPersonRef | undefined;
  /** Messages the server confirmed, oldest first, tombstones included. */
  readonly messages: readonly ConversationMessage[];
  readonly outgoing: readonly OutgoingMessage[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The other person left: the history stays, nothing more can be sent. */
  readonly ended: boolean;
  readonly muted: boolean;
  /** The last read answer did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
  /** After a lost connection returned with new messages: the sequence the "While you were away" divider follows. */
  readonly awayAfterSequence: number | undefined;
}

export interface ThreadController {
  readonly getState: () => ThreadState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts the thread: reads the newest messages. Safe to call again to start over. */
  readonly load: () => Promise<void>;
  /** Catches up from the last confirmed change, after a hint, a reconnect, a focus or a poll. */
  readonly refresh: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  /** Sends one message once; a failed one stays a single bubble until retried or dismissed. */
  readonly send: (body: MessageBody) => Promise<void>;
  readonly retry: (commandId: string) => Promise<void>;
  readonly dismiss: (commandId: string) => void;
  /** While the thread is on screen its newest messages count as read. Reading never creates evidence. */
  readonly setActive: (active: boolean) => void;
  readonly mute: (muted: boolean) => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
}

export interface ThreadOptions {
  readonly scope: AccountScope;
  readonly conversation: DirectConversationRef;
  readonly newId: () => string;
}

const sortedBySequence = <M extends { readonly sequence: number }>(messages: Iterable<M>) =>
  [...messages].sort((a, b) => a.sequence - b.sequence);

/**
 * Messages by sequence. A tombstone is final: an older page fetched before a deletion must never
 * bring the deleted text back, so an `available` copy never replaces an `unavailable` one. Any
 * other later version replaces the earlier. Works for direct and thread messages alike.
 */
export function mergeMessages<M extends { readonly sequence: number; readonly status: 'available' | 'unavailable' }>(
  existing: readonly M[],
  incoming: readonly M[],
): readonly M[] {
  const bySequence = new Map<number, M>();
  for (const message of existing) bySequence.set(message.sequence, message);
  for (const message of incoming) {
    if (bySequence.get(message.sequence)?.status === 'unavailable' && message.status === 'available') continue;
    bySequence.set(message.sequence, message);
  }
  return sortedBySequence(bySequence.values());
}

/**
 * One conversation's client state (blueprint §4 "durable conversation delivery"). The server owns
 * the messages and their order; this keeps what the person has read so far, asks for what is
 * missing from its last confirmed position, and holds the bubbles it is still sending.
 *
 * Nothing here depends on a hint: hints, focus, reconnects and a slow poll all call `refresh`, and
 * a refresh is just "read from my cursor", so a lost hint only delays an update. A cursor the
 * server calls stale starts the thread over from a fresh snapshot.
 */
export function createConversationThread(options: ThreadOptions): ThreadController {
  const { scope, conversation, newId } = options;
  const api = scope.api.conversations;
  const listeners = new Set<() => void>();
  let state: ThreadState = {
    phase: 'loading',
    peer: undefined,
    messages: [],
    outgoing: [],
    hasOlder: false,
    loadingOlder: false,
    ended: false,
    muted: false,
    offline: false,
    awayAfterSequence: undefined,
  };
  let lostAfter: number | undefined;
  let catchUpCursor: string | undefined;
  let olderCursor: string | undefined;
  let readThrough = 0;
  let active = false;
  let syncing: Promise<void> | undefined;
  let syncAgain = false;
  let marking = false;

  function publish(patch: Partial<ThreadState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  /** Drops bubbles whose message has arrived in order. */
  function settle(messages: readonly ConversationMessage[]): readonly OutgoingMessage[] {
    const have = new Set(messages.map((message) => message.sequence));
    return state.outgoing.filter((entry) => entry.sequence === undefined || !have.has(entry.sequence));
  }

  function failed(error: unknown): void {
    const kind = talkFailure(error);
    if (kind === 'ended') return;
    if (kind === 'unavailable') publish({ phase: 'unavailable' });
    else if (state.phase === 'loading') publish({ phase: 'failed', offline: kind === 'offline' });
    else {
      if (!state.offline) lostAfter = newestSequence(state.messages);
      publish({ offline: true });
    }
  }

  /** The divider patch for messages read right after a lost connection came back. */
  function returned(messages: readonly ConversationMessage[]): Partial<ThreadState> {
    const away = state.offline ? awayAfter(lostAfter, messages) : undefined;
    lostAfter = undefined;
    return away === undefined ? {} : { awayAfterSequence: away };
  }

  async function load(): Promise<void> {
    try {
      const snapshot = await api.read({ version: VERSION, readId: newId(), conversation, limit: SNAPSHOT_LIMIT });
      if (snapshot.status === 'unavailable') {
        publish({ phase: 'unavailable' });
        return;
      }
      catchUpCursor = snapshot.catchUpCursor;
      olderCursor = snapshot.history.kind === 'more' ? snapshot.history.cursor : undefined;
      readThrough = snapshot.own.readThroughSequence;
      publish({
        phase: 'ready',
        peer: snapshot.peer,
        messages: snapshot.messages,
        outgoing: settle(snapshot.messages),
        hasOlder: olderCursor !== undefined,
        ended: snapshot.ended === true,
        muted: snapshot.own.muted,
        offline: false,
        ...returned(snapshot.messages),
      });
      void markRead();
    } catch (error) {
      failed(error);
    }
  }

  async function catchUpOnce(): Promise<void> {
    try {
      while (catchUpCursor !== undefined) {
        const page = await api.changes({
          version: VERSION,
          readId: newId(),
          conversation,
          limit: CHANGES_LIMIT,
          cursor: catchUpCursor,
        });
        if (page.status === 'unavailable') {
          publish({ phase: 'unavailable' });
          return;
        }
        if (page.status === 'refresh_required') {
          await load();
          return;
        }
        const messages = mergeMessages(
          state.messages,
          page.changes.map((change) => change.message),
        );
        catchUpCursor = page.continuation.cursor;
        const wasEnded = state.ended;
        publish({
          messages,
          outgoing: settle(messages),
          ended: page.ended === true,
          offline: false,
          ...returned(messages),
        });
        // The conversation just ended (someone left, or an account was deleted): read it afresh,
        // because who the other person is shown as may have changed with it.
        if (page.ended === true && !wasEnded) {
          await load();
          return;
        }
        if (page.continuation.kind === 'caught_up') break;
      }
      void markRead();
    } catch (error) {
      failed(error);
    }
  }

  /** One catch-up at a time; a request that arrives meanwhile asks for one more round afterwards. */
  function catchUp(): Promise<void> {
    if (syncing !== undefined) {
      syncAgain = true;
      return syncing;
    }
    syncing = catchUpOnce().finally(() => {
      syncing = undefined;
      if (syncAgain) {
        syncAgain = false;
        void catchUp();
      }
    });
    return syncing;
  }

  async function markRead(): Promise<void> {
    const latest = state.messages.at(-1)?.sequence ?? 0;
    if (!active || marking || latest <= readThrough || state.phase !== 'ready') return;
    marking = true;
    try {
      const accepted = await api.markRead({
        version: VERSION,
        commandId: newId(),
        conversation,
        throughSequence: latest,
      });
      readThrough = Math.max(readThrough, accepted.acceptedThroughSequence);
    } catch {
      // Reading position is a convenience; the next refresh tries again.
    } finally {
      marking = false;
    }
  }

  const setOutgoing = (commandId: string, patch: Partial<OutgoingMessage>) =>
    publish({
      outgoing: state.outgoing.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry)),
    });

  async function attempt(commandId: string, body: MessageBody): Promise<void> {
    setOutgoing(commandId, { status: 'sending' });
    try {
      const accepted = await api.send({ version: VERSION, commandId, conversation, body });
      setOutgoing(commandId, { status: 'accepted', sequence: accepted.messageSequence });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      setOutgoing(commandId, { status: kind === 'offline' ? 'unconfirmed' : 'not_sent' });
      // A refusal means something changed (left, blocked, withdrawn): read again to find out what.
      if (kind === 'unavailable') void load();
      return;
    }
    await catchUp();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async refresh() {
      if (state.phase === 'unavailable') return;
      if (catchUpCursor === undefined) await load();
      else await catchUp();
    },
    async loadOlder() {
      const cursor = olderCursor;
      if (cursor === undefined || state.loadingOlder) return;
      publish({ loadingOlder: true });
      try {
        const page = await api.history({
          version: VERSION,
          readId: newId(),
          conversation,
          limit: SNAPSHOT_LIMIT,
          cursor,
        });
        if (page.status !== 'ready') {
          publish({ loadingOlder: false });
          if (page.status === 'unavailable') publish({ phase: 'unavailable' });
          return;
        }
        olderCursor = page.continuation.kind === 'more' ? page.continuation.cursor : undefined;
        const messages = mergeMessages(state.messages, page.messages);
        publish({ messages, hasOlder: olderCursor !== undefined, loadingOlder: false });
      } catch (error) {
        publish({ loadingOlder: false });
        failed(error);
      }
    },
    async send(body) {
      const commandId = newId();
      publish({ outgoing: [...state.outgoing, { commandId, body, status: 'sending' }] });
      await attempt(commandId, body);
    },
    async retry(commandId) {
      const entry = state.outgoing.find((candidate) => candidate.commandId === commandId);
      if (entry && (entry.status === 'unconfirmed' || entry.status === 'not_sent'))
        await attempt(commandId, entry.body);
    },
    dismiss(commandId) {
      publish({
        outgoing: state.outgoing.filter((entry) => entry.commandId !== commandId || entry.status !== 'not_sent'),
      });
    },
    setActive(next) {
      active = next;
      if (next) void markRead();
    },
    async mute(muted) {
      try {
        await api.mute({ version: VERSION, commandId: newId(), conversation, muted });
        publish({ muted });
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },
    async leave() {
      try {
        await api.leave({ version: VERSION, commandId: newId(), conversation });
        publish({ phase: 'unavailable' });
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },
  };
}
