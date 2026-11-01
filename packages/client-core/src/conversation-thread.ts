import type {
  ConversationMessage,
  DirectConversationRef,
  MessageReactionKind,
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
  /** The message this one answers, kept with the command so a retry names the same one. */
  readonly replyTo?: string;
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
  /**
   * How far the other person has read, when the server says so: only while both people share their read
   * position (SEEN, D-066) and the conversation stands. `undefined` shows nothing, and is the one answer for
   * every reason the server may have to say nothing (it gives none).
   */
  readonly peerReadThrough: number | undefined;
  /** The last read answer did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
  /** After a lost connection returned with new messages: the sequence the "While you were away" divider follows. */
  readonly awayAfterSequence: number | undefined;
  /** The challenge card whose pick is on its way, so the card can show it is sending (D-245). */
  readonly lockingChallenge: string | undefined;
  /**
   * Why the last pick on a challenge card was not kept, for that card to say: recording is paused (a pick is a play
   * result and is stored only while recording is on, D-083), or no answer came and the person may press again.
   */
  readonly challengeNotice: { readonly messageId: string; readonly reason: 'paused' | 'failed' } | undefined;
}

export interface ThreadController {
  readonly getState: () => ThreadState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts the thread: reads the newest messages. Safe to call again to start over. */
  readonly load: () => Promise<void>;
  /** Catches up from the last confirmed change, after a hint, a reconnect, a focus or a poll. */
  readonly refresh: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  /** Sends one message once, optionally as a reply; a failed one stays a single bubble until retried or dismissed. */
  readonly send: (body: MessageBody, replyTo?: string) => Promise<void>;
  /**
   * Puts one of the five reactions on a message, or takes it off, then catches up so the message comes
   * back with the new count. The wanted state is the command, so pressing twice is harmless.
   */
  readonly react: (messageId: string, kind: MessageReactionKind, present: boolean) => Promise<void>;
  /**
   * Locks this person's pick on a challenge card (D-245). The first lock stands, so pressing again after a lost answer is
   * safe. While recording is paused nothing is sent and the card says so. Never throws; the thread is read again after
   * a kept pick (caught up otherwise), so the card shows what the server holds (the friend's pick only once both have called).
   */
  readonly lockChallenge: (messageId: string, option: number) => Promise<void>;
  readonly retry: (commandId: string) => Promise<void>;
  readonly dismiss: (commandId: string) => void;
  /**
   * A reply the server refused (its original was removed before it was sent) can never be sent as it is: this
   * drops that bubble and sends the same words as a plain message, under a new command.
   */
  readonly sendWithoutQuote: (commandId: string) => Promise<void>;
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
    peerReadThrough: undefined,
    offline: false,
    awayAfterSequence: undefined,
    lockingChallenge: undefined,
    challengeNotice: undefined,
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
    const peerId = state.peer?.personId;
    const isOwn = (message: ConversationMessage) =>
      message.status === 'available' && peerId !== undefined && message.author.personId !== peerId;
    const away = state.offline ? awayAfter(lostAfter, messages, isOwn) : undefined;
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
        peerReadThrough: snapshot.peerRead?.throughSequence,
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
          peerReadThrough: page.peerRead?.throughSequence,
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

  /** Asks the server to keep the pick; says whether it did, or why not. */
  async function sendPick(messageId: string, option: number): Promise<'kept' | 'paused' | 'stale' | 'failed'> {
    const recordingGeneration = await scope.recording?.generation();
    if (recordingGeneration === undefined) return 'failed';
    const answer = await api.lockChallenge({
      version: VERSION,
      conversation,
      messageId,
      option,
      recordingGeneration,
    });
    if (answer.recorded) return 'kept';
    return answer.reason === 'recording_paused' ? 'paused' : 'stale';
  }

  const setOutgoing = (commandId: string, patch: Partial<OutgoingMessage>) =>
    publish({
      outgoing: state.outgoing.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry)),
    });

  async function attempt(commandId: string, body: MessageBody, replyTo: string | undefined): Promise<void> {
    setOutgoing(commandId, { status: 'sending' });
    try {
      const accepted = await api.send({
        version: VERSION,
        commandId,
        conversation,
        body,
        ...(replyTo === undefined ? {} : { replyTo }),
      });
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

  async function sendMessage(body: MessageBody, replyTo: string | undefined): Promise<void> {
    const commandId = newId();
    publish({
      outgoing: [
        ...state.outgoing,
        { commandId, body, status: 'sending', ...(replyTo === undefined ? {} : { replyTo }) },
      ],
    });
    await attempt(commandId, body, replyTo);
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
    send: sendMessage,
    async sendWithoutQuote(commandId) {
      const entry = state.outgoing.find((candidate) => candidate.commandId === commandId);
      if (entry?.status !== 'not_sent' || entry.replyTo === undefined) return;
      publish({ outgoing: state.outgoing.filter((candidate) => candidate.commandId !== commandId) });
      await sendMessage(entry.body, undefined);
    },
    async react(messageId, kind, present) {
      try {
        await api.react({ version: VERSION, commandId: newId(), conversation, messageId, kind, present });
      } catch (error) {
        const failure = talkFailure(error);
        // A refusal means the standing changed (left, blocked, the message went): read again to find out.
        if (failure === 'unavailable') void load();
        else failed(error);
        return;
      }
      await catchUp();
    },
    async lockChallenge(messageId, option) {
      if (state.lockingChallenge !== undefined) return;
      // A pick is stored only while recording is on, and unknown counts as not on: nothing is sent.
      if (scope.recording?.getState().policy?.on === false) {
        publish({ challengeNotice: { messageId, reason: 'paused' } });
        return;
      }
      publish({ lockingChallenge: messageId, challengeNotice: undefined });
      let outcome: Awaited<ReturnType<typeof sendPick>> = 'failed';
      try {
        outcome = await sendPick(messageId, option);
        if (outcome === 'stale') {
          // The policy moved on since this device read it: read it again and send the same pick once more.
          await scope.recording?.refresh();
          outcome = await sendPick(messageId, option);
        }
      } catch (error) {
        const failure = talkFailure(error);
        if (failure === 'ended') return;
        if (failure === 'unavailable') void load();
      }
      publish({
        lockingChallenge: undefined,
        challengeNotice:
          outcome === 'kept' ? undefined : { messageId, reason: outcome === 'paused' ? 'paused' : 'failed' },
      });
      // A pick made before the friend has called moves nothing in the changes feed (that would tell the friend), so the
      // thread is read afresh to show the person's own pick.
      await (outcome === 'kept' ? load() : catchUp());
    },
    async retry(commandId) {
      const entry = state.outgoing.find((candidate) => candidate.commandId === commandId);
      if (entry && (entry.status === 'unconfirmed' || entry.status === 'not_sent'))
        await attempt(commandId, entry.body, entry.replyTo);
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
