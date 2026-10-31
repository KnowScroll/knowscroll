import type { PublicPersonRef } from '@knowscroll/contracts';
import type {
  ReadContentSequence,
  ReadScrollPlayFacts,
  ResolveSnippetAnchor,
  StoredSnippetAnchor,
  ValidateSnippetAnchor,
} from '../../content/public.js';
import type { ReadVisitedAssets } from '../../experience/public.js';
import type { FencePersonalRecording, PersonalScopeTx } from '../../identity/public.js';
import type { CallLockRow } from '../domain/calls.js';
import type { PlaceRow, StoredPlace } from '../domain/places.js';
import type { ContentRef, ConversationStore, MessageRow } from './conversation-ports.js';
import type { SharedLock, SocialPorts } from './ports.js';

/** A locked thread root: the thread's conversation row, held after the actor's personal root and account gate. */
export interface ThreadLock extends SharedLock {
  readonly threadId: string;
}

export interface ThreadRow {
  readonly threadId: string;
  readonly name: string | null;
  readonly root: ContentRef;
  /** Null once the starter's account was deleted. */
  readonly starterAccountId: string | null;
  readonly lastSequence: number;
  readonly lastChangeSequence: number;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
}

export interface ThreadMember {
  readonly accountId: string;
  /** The member's own universe, for the live inbox hint. */
  readonly universeId: string;
  readonly person: PublicPersonRef;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly pending: boolean;
  readonly left: boolean;
  /** Account active and, for an invited member, the inviting friendship still stands. */
  readonly stands: boolean;
  readonly readThroughSequence: number;
  readonly muted: boolean;
  /** The member's own "hide where I am" for this thread (D-065): while true they have no place. */
  readonly placeHidden: boolean;
  /** The friend whose invitation carried this member in; null for the starter and once that friend left or was deleted. */
  readonly inviterAccountId: string | null;
}

/** A thread with every member that has a row, read under the thread's lock. */
export interface LoadedThread {
  readonly thread: ThreadRow;
  readonly own: ThreadMember;
  readonly members: readonly ThreadMember[];
}

export interface NewThread {
  readonly threadId: string;
  readonly name: string | undefined;
  readonly root: ContentRef;
  readonly starter: { readonly accountId: string; readonly membershipId: string };
  readonly invited: readonly {
    readonly accountId: string;
    readonly membershipId: string;
    readonly lineage: string;
  }[];
  readonly now: Date;
}

/** A friend of the caller who can be invited, with the lineage of the friendship that carries the invitation. */
export interface FriendStanding {
  readonly personId: string;
  readonly accountId: string;
  /** The friend's own universe, for the live inbox hint. */
  readonly universeId: string;
  /** Null when the two are not friends (never, removed or blocked). */
  readonly lineage: string | null;
  readonly accountActive: boolean;
}

export interface ThreadInboxRow {
  readonly thread: ThreadRow;
  readonly own: ThreadMember;
  /** The people shown for the thread, the caller excluded; at most a few. */
  readonly people: readonly PublicPersonRef[];
  readonly inviter: PublicPersonRef | undefined;
  /** The newest message, none while the invitation is pending. */
  readonly lastMessage: MessageRow | undefined;
}

/**
 * Thread rows. Each method is one explicit query or write; none decides access. Writes and locked
 * reads take a `ThreadLock`, obtained by the use case after the actor's gates. Messages, counters
 * and inbox hints go through `ConversationStore`, which threads share with direct conversations.
 */
export interface ThreadStore {
  /** Whether the caller has a membership row, found without locks so a stranger never takes the lock. */
  isMember(scope: PersonalScopeTx, accountId: string, threadId: string): Promise<boolean>;
  exists(scope: PersonalScopeTx, threadId: string): Promise<boolean>;
  /**
   * Takes the thread's root lock: FOR UPDATE for commands, FOR SHARE for reads. `create` makes the
   * conversation row first, so the same command always lands on the same thread.
   */
  lock(
    scope: PersonalScopeTx,
    threadId: string,
    mode: 'write' | 'read' | { readonly create: Date },
  ): Promise<ThreadLock | undefined>;
  load(lock: ThreadLock, ownAccountId: string): Promise<LoadedThread | undefined>;
  create(lock: ThreadLock, thread: NewThread): Promise<void>;
  /** Joins or declines. The membership reference stays valid either way. */
  respond(lock: ThreadLock, accountId: string, response: 'join' | 'decline', now: Date): Promise<void>;
  /** Ends the caller's place. Members the leaver invited then stand on their own membership. */
  leave(lock: ThreadLock, accountId: string, now: Date): Promise<void>;
  saveSnippet(lock: ThreadLock, messageId: string, anchor: StoredSnippetAnchor): Promise<void>;
  snippetsOf(
    reader: ThreadLock | PersonalScopeTx,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredSnippetAnchor>>;
  /** The snippet of one message of this thread with the exact revision it points into; none for any other message. */
  snippetOfMessage(
    lock: ThreadLock,
    messageId: string,
  ): Promise<{ readonly target: ContentRef; readonly anchor: StoredSnippetAnchor } | undefined>;
  /** The caller's open threads (joined or invited), newest activity first. */
  inbox(scope: PersonalScopeTx, accountId: string, limit: number): Promise<readonly ThreadInboxRow[]>;
  /** Friend standing of each person, by public person ID; a person who does not exist or is hidden is absent. */
  friends(
    scope: PersonalScopeTx,
    ownAccountId: string,
    personIds: readonly string[],
  ): Promise<readonly FriendStanding[]>;
}

/**
 * Party places (D-065). Each method is one statement; none decides access. Writes and locked reads take
 * the thread's `ThreadLock`, obtained by the use case after the actor's gates. A place is only ever
 * written for the account that is acting, from that account's own command.
 */
export interface PlaceStore {
  /** Every stored place of the thread. The caller filters them with the pure rule `shownPlaces`. */
  list(lock: ThreadLock): Promise<readonly PlaceRow[]>;
  /** The account's own stored place, if it has one. */
  find(lock: ThreadLock, accountId: string): Promise<StoredPlace | undefined>;
  /** Stores the account's place, replacing the one it had. */
  save(lock: ThreadLock, accountId: string, place: StoredPlace): Promise<void>;
  /** Deletes the account's place in this thread; nothing is left to find. */
  remove(lock: ThreadLock, accountId: string): Promise<void>;
  setHidden(lock: ThreadLock, accountId: string, hidden: boolean): Promise<void>;
  /** Of these accounts, those the reader blocked or that blocked the reader. */
  blockedWith(lock: ThreadLock, readerAccountId: string, accountIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/** The call of one part: one stop of one exact Scroll revision. */
export interface CallKey {
  readonly assetId: string;
  readonly revision: number;
  readonly stopId: string;
}

/** A stored lock with the call it is for. */
export interface ThreadCallRow extends CallLockRow, CallKey {}

/**
 * Thread calls (D-155 to D-157). Each method is one statement; none decides access. Writes and locked reads take
 * the thread's `ThreadLock`, obtained by the use case after the actor's gates. A pick is only ever written for
 * the account that is acting, from that account's own command, and never carries whether it was right.
 */
export interface CallStore {
  /** Every lock in the thread. The caller picks a call's rows and filters them with the pure rule `viewCall`. */
  list(lock: ThreadLock): Promise<readonly ThreadCallRow[]>;
  /** Stores the account's first lock of a call. A call the account already locked is left as it was. */
  insert(lock: ThreadLock, accountId: string, call: CallKey, option: number, day: string): Promise<void>;
  /** Deletes every pick the account made in this thread; nothing is left to find. */
  removeOf(lock: ThreadLock, accountId: string): Promise<void>;
  /** The thread's calls that have revealed: a key and nothing else, never a person, a pick or a day (D-155). */
  reveals(lock: ThreadLock): Promise<readonly CallKey[]>;
  /** Records that a call revealed for the thread, once: a call already recorded is left as it was. */
  markRevealed(lock: ThreadLock, call: CallKey): Promise<void>;
}

export interface ThreadPorts extends SocialPorts {
  conversations: ConversationStore;
  threads: ThreadStore;
  places: PlaceStore;
  calls: CallStore;
  /** The thread a command lands on: derived from the starter and the command, so a retry finds it. */
  threadIdFor(accountId: string, commandId: string): string;
  readSequence: ReadContentSequence;
  readVisited: ReadVisitedAssets;
  validateSnippet: ValidateSnippetAnchor;
  resolveSnippet: ResolveSnippetAnchor;
}

/** The thread ports plus what the call commands need: the calls of a Scroll revision and the recording gate. */
export interface ThreadCallPorts extends ThreadPorts {
  /** The question, options, answer and reveal words of a Scroll revision (content's public read). */
  readCallFacts: ReadScrollPlayFacts;
  /** A pick is a play result, so it is stored only while recording is on (D-083). */
  fenceRecording: FencePersonalRecording;
}
