import type {
  ConversationContentProjection,
  ContentThreadRef,
  PublicPersonRef,
  SendThreadBody,
  ThreadEpisode,
  ThreadMessage,
  ThreadParticipant,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { mergeMessages } from './conversation-thread';
import { talkFailure } from './talk-failure';

const VERSION = 'content-thread.v1' as const;
const SNAPSHOT_LIMIT = 30;
const CHANGES_LIMIT = 50;

/**
 * A message the person has sent that the thread has not yet read back in order.
 * - `sending`: the request is in flight.
 * - `accepted`: the server stored it; it leaves this list when its message arrives in the thread.
 * - `unconfirmed`: no answer came. It may or may not have been stored; retrying sends the identical
 *   command, so it can never appear twice.
 * - `not_sent`: the server refused it.
 */
export interface OutgoingThreadMessage {
  readonly commandId: string;
  readonly body: SendThreadBody;
  readonly status: 'sending' | 'accepted' | 'unconfirmed' | 'not_sent';
  readonly sequence?: number;
}

export interface ContentThreadState {
  /**
   * `invitation`: the person was invited and has not joined; only the invitation is readable.
   * `unavailable`: not a member, removed, or the friendship that invited them ended; the screen says
   * so without saying why.
   */
  readonly phase: 'loading' | 'ready' | 'invitation' | 'unavailable' | 'failed';
  readonly name: string | undefined;
  readonly root: ConversationContentProjection | undefined;
  readonly participants: readonly ThreadParticipant[];
  readonly sequence: 'single' | 'series';
  readonly episodes: readonly ThreadEpisode[];
  readonly invitedBy: PublicPersonRef | undefined;
  /** Messages the server confirmed, oldest first, tombstones included. */
  readonly messages: readonly ThreadMessage[];
  readonly outgoing: readonly OutgoingThreadMessage[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The last read answer did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
  /** Answering an invitation is in flight. */
  readonly responding: boolean;
}

export interface ContentThreadController {
  readonly getState: () => ContentThreadState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the thread afresh: newest messages, participants and the caller's own visited markers. */
  readonly load: () => Promise<void>;
  /** Catches up from the last confirmed change, after a hint, a reconnect, a focus or a poll. */
  readonly refresh: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  /** Sends one message once; a failed one stays a single bubble until retried or dismissed. */
  readonly send: (body: SendThreadBody) => Promise<void>;
  readonly retry: (commandId: string) => Promise<void>;
  readonly dismiss: (commandId: string) => void;
  /** While the thread is on screen its newest messages count as read. Reading never creates evidence. */
  readonly setActive: (active: boolean) => void;
  /** Accepts or declines an invitation; joining reads the thread. Returns whether the server accepted. */
  readonly respond: (response: 'join' | 'decline') => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
}

export interface ContentThreadOptions {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly newId: () => string;
}

const emptyState: ContentThreadState = {
  phase: 'loading',
  name: undefined,
  root: undefined,
  participants: [],
  sequence: 'single',
  episodes: [],
  invitedBy: undefined,
  messages: [],
  outgoing: [],
  hasOlder: false,
  loadingOlder: false,
  offline: false,
  responding: false,
};

/**
 * One thread's client state. The server owns the messages, the participants and the episodes; this
 * keeps what the person has read so far, asks for what is missing from its last confirmed position,
 * and holds the bubbles it is still sending. Which episode is selected, and where in it, is the
 * person's own and lives on the device (the screen), never here and never on the server.
 *
 * Nothing here depends on a hint: hints, focus, reconnects and a slow poll all call `refresh`, and a
 * refresh is "read from my cursor", so a lost hint only delays an update. A cursor the server calls
 * stale starts over from a fresh snapshot.
 */
export function createContentThread(options: ContentThreadOptions): ContentThreadController {
  const { scope, thread, newId } = options;
  const api = scope.api.threads;
  const listeners = new Set<() => void>();
  let state: ContentThreadState = emptyState;
  let catchUpCursor: string | undefined;
  let olderCursor: string | undefined;
  let readThrough = 0;
  let active = false;
  let syncing: Promise<void> | undefined;
  let syncAgain = false;
  let marking = false;
  let respondIntent: { readonly response: 'join' | 'decline'; readonly commandId: string } | undefined;

  function publish(patch: Partial<ContentThreadState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  /** Drops bubbles whose message has arrived in order. */
  function settle(messages: readonly ThreadMessage[]): readonly OutgoingThreadMessage[] {
    const have = new Set(messages.map((message) => message.sequence));
    return state.outgoing.filter((entry) => entry.sequence === undefined || !have.has(entry.sequence));
  }

  function failed(error: unknown): void {
    const kind = talkFailure(error);
    if (kind === 'ended') return;
    if (kind === 'unavailable') publish({ phase: 'unavailable' });
    else if (state.phase === 'loading') publish({ phase: 'failed', offline: kind === 'offline' });
    else publish({ offline: true });
  }

  async function load(): Promise<void> {
    try {
      const view = await api.read({ version: VERSION, readId: newId(), thread, limit: SNAPSHOT_LIMIT });
      if (view.status === 'unavailable') {
        publish({ phase: 'unavailable' });
        return;
      }
      if (view.status === 'invitation') {
        publish({
          phase: 'invitation',
          name: view.name,
          root: view.root,
          invitedBy: view.invitedBy,
          offline: false,
        });
        return;
      }
      catchUpCursor = view.catchUpCursor;
      olderCursor = view.history.kind === 'more' ? view.history.cursor : undefined;
      readThrough = view.own.readThroughSequence;
      const messages = mergeMessages(state.messages, view.messages);
      publish({
        phase: 'ready',
        name: view.name,
        root: view.root,
        participants: view.participants,
        sequence: view.sequence.kind,
        episodes: view.episodes,
        messages,
        outgoing: settle(messages),
        hasOlder: olderCursor !== undefined,
        offline: false,
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
          thread,
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
        publish({ messages, outgoing: settle(messages), offline: false });
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
      const accepted = await api.markRead({ version: VERSION, commandId: newId(), thread, throughSequence: latest });
      readThrough = Math.max(readThrough, accepted.acceptedThroughSequence);
    } catch {
      // Reading position is a convenience; the next refresh tries again.
    } finally {
      marking = false;
    }
  }

  const setOutgoing = (commandId: string, patch: Partial<OutgoingThreadMessage>) =>
    publish({
      outgoing: state.outgoing.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry)),
    });

  async function attempt(commandId: string, body: SendThreadBody): Promise<void> {
    setOutgoing(commandId, { status: 'sending' });
    try {
      const accepted = await api.send({ version: VERSION, commandId, thread, body });
      setOutgoing(commandId, { status: 'accepted', sequence: accepted.messageSequence });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      setOutgoing(commandId, { status: kind === 'offline' ? 'unconfirmed' : 'not_sent' });
      // A refusal may mean the place ended (removed, friendship ended): read again to find out.
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
        const page = await api.history({ version: VERSION, readId: newId(), thread, limit: SNAPSHOT_LIMIT, cursor });
        if (page.status !== 'ready') {
          publish({ loadingOlder: false });
          if (page.status === 'unavailable') publish({ phase: 'unavailable' });
          return;
        }
        olderCursor = page.continuation.kind === 'more' ? page.continuation.cursor : undefined;
        publish({
          messages: mergeMessages(state.messages, page.messages),
          hasOlder: olderCursor !== undefined,
          loadingOlder: false,
        });
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
    async respond(response) {
      if (state.responding) return false;
      publish({ responding: true });
      // The command ID is kept for each intent: after an unknown outcome the retry is the same command.
      const intent = respondIntent?.response === response ? respondIntent : { response, commandId: newId() };
      respondIntent = intent;
      try {
        await api.respond({ version: VERSION, commandId: intent.commandId, thread, response });
        respondIntent = undefined;
        publish({ responding: false });
        if (response === 'join') await load();
        else publish({ phase: 'unavailable' });
        return true;
      } catch (error) {
        publish({ responding: false });
        // A refusal means the invitation changed meanwhile; reading says how.
        if (talkFailure(error) === 'unavailable') {
          respondIntent = undefined;
          await load();
        } else failed(error);
        return false;
      }
    },
    async leave() {
      try {
        await api.leave({ version: VERSION, commandId: newId(), thread });
        publish({ phase: 'unavailable' });
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },
  };
}
