import type {
  DiscussionView,
  InhabitantId,
  RoomInhabitantStatus,
  RoomMessage,
  SendRoomBody,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;
const SNAPSHOT_LIMIT = 30;
const CHANGES_LIMIT = 50;

type Ready = Extract<DiscussionView, { status: 'ready' }>;
export type InhabitantStatus = RoomInhabitantStatus;

/**
 * A message the person has sent that the discussion has not yet read back in order.
 * - `sending`: the request is in flight.
 * - `accepted`: the server stored it; it leaves this list when its message arrives in the discussion.
 * - `unconfirmed`: no answer came. It may or may not have been stored; retrying sends the identical
 *   command, so it can never appear twice.
 * - `not_sent`: the server refused it.
 */
export interface OutgoingRoomMessage {
  readonly commandId: string;
  readonly body: SendRoomBody;
  readonly status: 'sending' | 'accepted' | 'unconfirmed' | 'not_sent';
  readonly sequence?: number;
}

/** A pointed ask: the resident is chosen by the kind (the Skeptic tests or argues the other side, the Explainer answers). */
export type PointedAsk = 'challenge' | 'other_side' | 'about';

/** What an ask of an AI inhabitant came to for the person, in the few ways the screen words differently. */
export type AskOutcome = 'asked' | 'resting' | 'unavailable' | 'failed';

export interface RoomDiscussionState {
  /** `unavailable`: not a member, removed, or no such discussion; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: Ready | undefined;
  /** Messages the server confirmed, oldest first; hidden and deleted ones stay as markers. */
  readonly messages: readonly RoomMessage[];
  readonly outgoing: readonly OutgoingRoomMessage[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The last read did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
  /** An ask of an inhabitant is in flight. */
  readonly asking: boolean;
}

export interface RoomDiscussionController {
  readonly getState: () => RoomDiscussionState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the discussion afresh: newest messages, content thread, and what the person may ask of the inhabitants. */
  readonly load: () => Promise<void>;
  /**
   * Reads the discussion afresh and replaces everything loaded, older pages too. For a change that catch-up
   * cannot carry: a block or unblock collapses or restores words that have no new change number.
   */
  readonly resnapshot: () => Promise<void>;
  /** Catches up from the last confirmed change; reads the discussion afresh while an inhabitant is preparing a reply. */
  readonly refresh: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
  /** Sends one message once; a failed one stays a single bubble until retried or dismissed. */
  readonly send: (body: SendRoomBody) => Promise<void>;
  readonly retry: (commandId: string) => Promise<void>;
  readonly dismiss: (commandId: string) => void;
  /** Asks a labelled AI inhabitant to contribute. Nothing is made unless a person chooses it. */
  readonly ask: (inhabitant: InhabitantId) => Promise<AskOutcome>;
  /** Challenges a message, asks for the other side, or asks about it (D-167); the kind chooses the resident. */
  readonly askAbout: (kind: PointedAsk, messageId: string) => Promise<AskOutcome>;
  /** Marks a message Useful, or takes the mark back. The message shows the change at once; returns whether the server accepted it. */
  readonly markUseful: (messageId: string, useful: boolean) => Promise<boolean>;
  /** Votes on a debate's side, or changes the vote until it closes. The discussion is read again; returns whether the server accepted it. */
  readonly voteDebate: (side: 'a' | 'b') => Promise<boolean>;
  /** Moderator: pin or unpin this discussion in the room. */
  readonly pin: (pinned: boolean) => Promise<boolean>;
  /** Moderator: remove a message from view, or restore it. */
  readonly hide: (messageId: string, hidden: boolean) => Promise<boolean>;
  /** Moderator: remove a member (named by a message's author) from the room. */
  readonly removeMember: (personId: string) => Promise<boolean>;
}

export interface RoomDiscussionOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly discussionId: string;
  readonly newId: () => string;
}

const emptyState: RoomDiscussionState = {
  phase: 'loading',
  view: undefined,
  messages: [],
  outgoing: [],
  hasOlder: false,
  loadingOlder: false,
  offline: false,
  asking: false,
};

/**
 * Newer states replace older ones by sequence, so a moderator's hide and restore reach everyone's
 * screen. A deleted account's marker (`unavailable`) is final: no later copy of the message brings
 * its words back.
 */
export function mergeRoomMessages(
  existing: readonly RoomMessage[],
  incoming: readonly RoomMessage[],
): readonly RoomMessage[] {
  const bySequence = new Map<number, RoomMessage>();
  for (const message of existing) bySequence.set(message.sequence, message);
  for (const message of incoming) {
    if (bySequence.get(message.sequence)?.status === 'unavailable' && message.status !== 'unavailable') continue;
    bySequence.set(message.sequence, message);
  }
  return [...bySequence.values()].sort((first, second) => first.sequence - second.sequence);
}

/** Drops bubbles whose message has arrived in order. */
function settleOutgoing(
  outgoing: readonly OutgoingRoomMessage[],
  messages: readonly RoomMessage[],
): readonly OutgoingRoomMessage[] {
  const have = new Set(messages.map((message) => message.sequence));
  return outgoing.filter((entry) => entry.sequence === undefined || !have.has(entry.sequence));
}

/**
 * One room discussion's client state. The server owns the messages, the episodes and what the person
 * may ask of an inhabitant; this keeps what the person has read so far, asks for what is missing from
 * its last confirmed position, and holds the bubbles it is still sending. Which episode is selected,
 * and where in it, is the person's own and lives on the device (the screen), never here.
 *
 * Nothing depends on a live hint: focus, reconnects and a slow poll all call `refresh`, and a refresh
 * is "read from my cursor", so a missed update only delays one. A cursor the server calls stale starts
 * over from a fresh snapshot.
 */
export function createRoomDiscussion(options: RoomDiscussionOptions): RoomDiscussionController {
  const { scope, roomId, discussionId, newId } = options;
  const listeners = new Set<() => void>();
  const ids = { roomId, discussionId };
  let state = emptyState;
  let catchUpCursor: string | undefined;
  let olderCursor: string | undefined;
  let syncing: Promise<void> | undefined;
  let syncAgain = false;
  const intents = new Map<string, string>();

  const publish = (patch: Partial<RoomDiscussionState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const failed = (error: unknown): void => {
    const kind = talkFailure(error);
    if (kind === 'ended') return;
    if (kind === 'unavailable') publish({ phase: 'unavailable' });
    else if (state.phase === 'loading') publish({ phase: 'failed', offline: kind === 'offline' });
    else publish({ offline: true });
  };

  function applySnapshot(view: Ready, replace: boolean): void {
    catchUpCursor = view.catchUpCursor;
    olderCursor = view.history.kind === 'more' ? view.history.cursor : undefined;
    const messages = replace ? view.messages : mergeRoomMessages(state.messages, view.messages);
    publish({
      phase: 'ready',
      view,
      messages,
      outgoing: settleOutgoing(state.outgoing, messages),
      hasOlder: olderCursor !== undefined,
      offline: false,
    });
  }

  async function load(replace = false): Promise<void> {
    try {
      const view = await scope.api.rooms.readDiscussion({
        version: VERSION,
        readId: newId(),
        ...ids,
        limit: SNAPSHOT_LIMIT,
      });
      if (view.status === 'unavailable') publish({ phase: 'unavailable' });
      else applySnapshot(view, replace);
    } catch (error) {
      failed(error);
    }
  }

  /** Reads from the last confirmed change until caught up; a cursor the server calls stale starts over. */
  async function catchUpOnce(): Promise<void> {
    try {
      while (catchUpCursor !== undefined) {
        const page = await scope.api.rooms.changes({
          version: VERSION,
          readId: newId(),
          ...ids,
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
        const messages = mergeRoomMessages(
          state.messages,
          page.changes.map((change) => change.message),
        );
        catchUpCursor = page.continuation.cursor;
        publish({ messages, outgoing: settleOutgoing(state.outgoing, messages), offline: false });
        if (page.continuation.kind === 'caught_up') break;
      }
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

  const preparing = (): boolean => state.view?.inhabitants.some((entry) => entry.ask === 'preparing') === true;

  /** One moderator command under an intent's command ID, retired by any definitive answer. */
  async function moderate<T>(intent: string, run: (commandId: string) => Promise<T>): Promise<T | undefined> {
    const commandId = intents.get(intent) ?? newId();
    intents.set(intent, commandId);
    try {
      const accepted = await run(commandId);
      intents.delete(intent);
      return accepted;
    } catch (error) {
      const kind = talkFailure(error);
      if (kind !== 'offline') intents.delete(intent);
      if (kind === 'unavailable') await load();
      else if (kind !== 'ended') publish({ offline: kind === 'offline' || state.offline });
      return undefined;
    }
  }

  /** One ask under an intent's command ID, retired by any definitive answer; the reply arrives later as a message. */
  async function requestAsk(
    intent: string,
    target:
      | { readonly inhabitant: InhabitantId }
      | { readonly about: { readonly kind: PointedAsk; readonly messageId: string } },
  ): Promise<AskOutcome> {
    if (state.asking) return 'unavailable';
    publish({ asking: true });
    const commandId = intents.get(intent) ?? newId();
    intents.set(intent, commandId);
    try {
      await scope.api.rooms.askInhabitant({ version: VERSION, commandId, ...ids, ...target });
      intents.delete(intent);
      publish({ asking: false });
      // The reply arrives later; reading now shows that it is being prepared.
      await load();
      return 'asked';
    } catch (error) {
      publish({ asking: false });
      const kind = talkFailure(error);
      if (kind === 'ended') return 'failed';
      if (kind !== 'offline') intents.delete(intent);
      if (apiProblem(error)?.code === 'TOO_MANY_REQUESTS') {
        await load();
        return 'resting';
      }
      if (kind === 'unavailable') {
        await load();
        return 'unavailable';
      }
      return 'failed';
    }
  }

  async function attempt(commandId: string, body: SendRoomBody): Promise<void> {
    setOutgoing(commandId, { status: 'sending' });
    try {
      const accepted = await scope.api.rooms.send({ version: VERSION, commandId, ...ids, body });
      setOutgoing(commandId, { status: 'accepted', sequence: accepted.messageSequence });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      setOutgoing(commandId, { status: kind === 'offline' ? 'unconfirmed' : 'not_sent' });
      // A refusal may mean the place ended (removed, room paused): read again to find out.
      if (kind === 'unavailable') void load();
      return;
    }
    await catchUp();
  }

  function setOutgoing(commandId: string, patch: Partial<OutgoingRoomMessage>): void {
    publish({
      outgoing: state.outgoing.map((entry) => (entry.commandId === commandId ? { ...entry, ...patch } : entry)),
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load: () => load(),
    resnapshot: () => load(true),
    async refresh() {
      if (state.phase === 'unavailable') return;
      if (catchUpCursor === undefined) await load();
      else {
        await catchUp();
        // The contribution of an inhabitant that was preparing arrives as a message; its outcome and the room's
        // other state (pins, the bound) are only in a fresh read.
        if (preparing()) await load();
      }
    },
    async loadOlder() {
      const cursor = olderCursor;
      if (cursor === undefined || state.loadingOlder) return;
      publish({ loadingOlder: true });
      try {
        const page = await scope.api.rooms.history({
          version: VERSION,
          readId: newId(),
          ...ids,
          limit: SNAPSHOT_LIMIT,
          cursor,
        });
        if (page.status !== 'ready') {
          publish({ loadingOlder: false });
          if (page.status === 'unavailable') publish({ phase: 'unavailable' });
          return;
        }
        olderCursor = page.continuation.kind === 'more' ? page.continuation.cursor : undefined;
        publish({
          messages: mergeRoomMessages(state.messages, page.messages),
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
    ask: (inhabitant) => requestAsk(`ask:${inhabitant}`, { inhabitant }),
    askAbout: (kind, messageId) => requestAsk(`ask:${kind}:${messageId}`, { about: { kind, messageId } }),
    async markUseful(messageId, useful) {
      const accepted = await moderate(`useful:${messageId}:${String(useful)}`, (commandId) =>
        scope.api.rooms.markUseful({ version: VERSION, commandId, ...ids, messageId, useful }),
      );
      if (accepted === undefined) return false;
      // A mark changes no message's number, so catch-up cannot carry it: the message on screen is changed here.
      publish({
        messages: state.messages.map((message) => {
          if (message.messageId !== messageId || message.status !== 'available') return message;
          const { usefulByYou: _before, ...rest } = message;
          return useful ? { ...rest, usefulByYou: true as const } : rest;
        }),
      });
      return true;
    },
    async voteDebate(side) {
      const accepted = await moderate(`debate:${side}`, (commandId) =>
        scope.api.rooms.voteDebate({ version: VERSION, commandId, ...ids, side }),
      );
      if (accepted !== undefined) await load();
      return accepted !== undefined;
    },
    async pin(pinned) {
      const accepted = await moderate(`pin:${String(pinned)}`, (commandId) =>
        scope.api.rooms.pin({ version: VERSION, commandId, ...ids, pinned }),
      );
      if (accepted !== undefined) await load();
      return accepted !== undefined;
    },
    async hide(messageId, hidden) {
      const accepted = await moderate(`hide:${messageId}:${String(hidden)}`, (commandId) =>
        scope.api.rooms.hideMessage({ version: VERSION, commandId, ...ids, messageId, hidden }),
      );
      if (accepted !== undefined) await catchUp();
      return accepted !== undefined;
    },
    async removeMember(personId) {
      const accepted = await moderate(`remove:${personId}`, (commandId) =>
        scope.api.rooms.moderate({ version: VERSION, commandId, roomId, action: { kind: 'remove_member', personId } }),
      );
      return accepted !== undefined;
    },
  };
}
