import type {
  ConversationContentProjection,
  ContentThreadRef,
  ContentThreadView,
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
  const session = new ContentThreadSession(options);
  return {
    getState: () => session.getState(),
    subscribe: (listener) => session.subscribe(listener),
    load: () => session.load(),
    refresh: () => session.refresh(),
    loadOlder: () => session.loadOlder(),
    send: (body) => session.send(body),
    retry: (commandId) => session.retry(commandId),
    dismiss: (commandId) => session.dismiss(commandId),
    setActive: (active) => session.setActive(active),
    respond: (response) => session.respond(response),
    leave: () => session.leave(),
  };
}

type ReadyThreadView = Extract<ContentThreadView, { status: 'ready' }>;

/** Drops bubbles whose message has arrived in order. */
function settleOutgoing(
  outgoing: readonly OutgoingThreadMessage[],
  messages: readonly ThreadMessage[],
): readonly OutgoingThreadMessage[] {
  const have = new Set(messages.map((message) => message.sequence));
  return outgoing.filter((entry) => entry.sequence === undefined || !have.has(entry.sequence));
}

class ContentThreadSession {
  private state: ContentThreadState = emptyState;
  private readonly scope: AccountScope;
  private readonly thread: ContentThreadRef;
  private readonly newId: () => string;
  private readonly listeners = new Set<() => void>();
  /** Where the next catch-up starts, and where the next page of older messages starts. */
  private catchUpCursor: string | undefined;
  private olderCursor: string | undefined;
  private readThrough = 0;
  private active = false;
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private marking = false;
  private respondIntent: { readonly response: 'join' | 'decline'; readonly commandId: string } | undefined;

  constructor(options: ContentThreadOptions) {
    this.scope = options.scope;
    this.thread = options.thread;
    this.newId = options.newId;
  }

  private get api() {
    return this.scope.api.threads;
  }

  getState(): ContentThreadState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private publish(patch: Partial<ContentThreadState>): void {
    if (!this.scope.active) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private failed(error: unknown): void {
    const kind = talkFailure(error);
    if (kind === 'ended') return;
    if (kind === 'unavailable') this.publish({ phase: 'unavailable' });
    else if (this.state.phase === 'loading') this.publish({ phase: 'failed', offline: kind === 'offline' });
    else this.publish({ offline: true });
  }

  // --- Reading ---

  async load(): Promise<void> {
    try {
      const view = await this.api.read({
        version: VERSION,
        readId: this.newId(),
        thread: this.thread,
        limit: SNAPSHOT_LIMIT,
      });
      if (view.status === 'unavailable') this.publish({ phase: 'unavailable' });
      else if (view.status === 'invitation') {
        this.publish({
          phase: 'invitation',
          name: view.name,
          root: view.root,
          invitedBy: view.invitedBy,
          offline: false,
        });
      } else {
        this.applySnapshot(view);
        void this.markRead();
      }
    } catch (error) {
      this.failed(error);
    }
  }

  private applySnapshot(view: ReadyThreadView): void {
    this.catchUpCursor = view.catchUpCursor;
    this.olderCursor = view.history.kind === 'more' ? view.history.cursor : undefined;
    this.readThrough = view.own.readThroughSequence;
    const messages = mergeMessages(this.state.messages, view.messages);
    this.publish({
      phase: 'ready',
      name: view.name,
      root: view.root,
      participants: view.participants,
      sequence: view.sequence.kind,
      episodes: view.episodes,
      messages,
      outgoing: settleOutgoing(this.state.outgoing, messages),
      hasOlder: this.olderCursor !== undefined,
      offline: false,
    });
  }

  /** Reads from the last confirmed change until caught up; a cursor the server calls stale starts over. */
  private async catchUpOnce(): Promise<void> {
    try {
      while (this.catchUpCursor !== undefined) {
        const page = await this.api.changes({
          version: VERSION,
          readId: this.newId(),
          thread: this.thread,
          limit: CHANGES_LIMIT,
          cursor: this.catchUpCursor,
        });
        if (page.status === 'unavailable') {
          this.publish({ phase: 'unavailable' });
          return;
        }
        if (page.status === 'refresh_required') {
          await this.load();
          return;
        }
        const messages = mergeMessages(
          this.state.messages,
          page.changes.map((change) => change.message),
        );
        this.catchUpCursor = page.continuation.cursor;
        this.publish({ messages, outgoing: settleOutgoing(this.state.outgoing, messages), offline: false });
        if (page.continuation.kind === 'caught_up') break;
      }
      void this.markRead();
    } catch (error) {
      this.failed(error);
    }
  }

  /** One catch-up at a time; a request that arrives meanwhile asks for one more round afterwards. */
  private catchUp(): Promise<void> {
    if (this.syncing !== undefined) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = this.catchUpOnce().finally(() => {
      this.syncing = undefined;
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.catchUp();
      }
    });
    return this.syncing;
  }

  async refresh(): Promise<void> {
    if (this.state.phase === 'unavailable') return;
    if (this.catchUpCursor === undefined) await this.load();
    else await this.catchUp();
  }

  async loadOlder(): Promise<void> {
    const cursor = this.olderCursor;
    if (cursor === undefined || this.state.loadingOlder) return;
    this.publish({ loadingOlder: true });
    try {
      const page = await this.api.history({
        version: VERSION,
        readId: this.newId(),
        thread: this.thread,
        limit: SNAPSHOT_LIMIT,
        cursor,
      });
      if (page.status !== 'ready') {
        this.publish({ loadingOlder: false });
        if (page.status === 'unavailable') this.publish({ phase: 'unavailable' });
        return;
      }
      this.olderCursor = page.continuation.kind === 'more' ? page.continuation.cursor : undefined;
      this.publish({
        messages: mergeMessages(this.state.messages, page.messages),
        hasOlder: this.olderCursor !== undefined,
        loadingOlder: false,
      });
    } catch (error) {
      this.publish({ loadingOlder: false });
      this.failed(error);
    }
  }

  // --- Reading position ---

  setActive(next: boolean): void {
    this.active = next;
    if (next) void this.markRead();
  }

  private async markRead(): Promise<void> {
    const latest = this.state.messages.at(-1)?.sequence ?? 0;
    if (!this.active || this.marking || latest <= this.readThrough || this.state.phase !== 'ready') return;
    this.marking = true;
    try {
      const accepted = await this.api.markRead({
        version: VERSION,
        commandId: this.newId(),
        thread: this.thread,
        throughSequence: latest,
      });
      this.readThrough = Math.max(this.readThrough, accepted.acceptedThroughSequence);
    } catch {
      // Reading position is a convenience; the next refresh tries again.
    } finally {
      this.marking = false;
    }
  }

  // --- Sending ---

  async send(body: SendThreadBody): Promise<void> {
    const commandId = this.newId();
    this.publish({ outgoing: [...this.state.outgoing, { commandId, body, status: 'sending' }] });
    await this.attempt(commandId, body);
  }

  async retry(commandId: string): Promise<void> {
    const entry = this.state.outgoing.find((candidate) => candidate.commandId === commandId);
    if (entry && (entry.status === 'unconfirmed' || entry.status === 'not_sent'))
      await this.attempt(commandId, entry.body);
  }

  dismiss(commandId: string): void {
    this.publish({
      outgoing: this.state.outgoing.filter((entry) => entry.commandId !== commandId || entry.status !== 'not_sent'),
    });
  }

  private setOutgoing(commandId: string, patch: Partial<OutgoingThreadMessage>): void {
    this.publish({
      outgoing: this.state.outgoing.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry)),
    });
  }

  private async attempt(commandId: string, body: SendThreadBody): Promise<void> {
    this.setOutgoing(commandId, { status: 'sending' });
    try {
      const accepted = await this.api.send({ version: VERSION, commandId, thread: this.thread, body });
      this.setOutgoing(commandId, { status: 'accepted', sequence: accepted.messageSequence });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      this.setOutgoing(commandId, { status: kind === 'offline' ? 'unconfirmed' : 'not_sent' });
      // A refusal may mean the place ended (removed, friendship ended): read again to find out.
      if (kind === 'unavailable') void this.load();
      return;
    }
    await this.catchUp();
  }

  // --- Membership ---

  async respond(response: 'join' | 'decline'): Promise<boolean> {
    if (this.state.responding) return false;
    this.publish({ responding: true });
    // The command ID is kept for each intent: after an unknown outcome the retry is the same command.
    const intent =
      this.respondIntent?.response === response ? this.respondIntent : { response, commandId: this.newId() };
    this.respondIntent = intent;
    try {
      await this.api.respond({ version: VERSION, commandId: intent.commandId, thread: this.thread, response });
      this.respondIntent = undefined;
      this.publish({ responding: false });
      if (response === 'join') await this.load();
      else this.publish({ phase: 'unavailable' });
      return true;
    } catch (error) {
      this.publish({ responding: false });
      // A refusal means the invitation changed meanwhile; reading says how.
      if (talkFailure(error) === 'unavailable') {
        this.respondIntent = undefined;
        await this.load();
      } else this.failed(error);
      return false;
    }
  }

  async leave(): Promise<boolean> {
    try {
      await this.api.leave({ version: VERSION, commandId: this.newId(), thread: this.thread });
      this.publish({ phase: 'unavailable' });
      return true;
    } catch (error) {
      this.failed(error);
      return false;
    }
  }
}
