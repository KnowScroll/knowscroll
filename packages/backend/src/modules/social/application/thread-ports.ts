import type { PublicPersonRef } from '@knowscroll/contracts';
import type {
  ReadContentSequence,
  ResolveSnippetAnchor,
  StoredSnippetAnchor,
  ValidateSnippetAnchor,
} from '../../content/public.js';
import type { ReadVisitedAssets } from '../../experience/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
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

export interface ThreadPorts extends SocialPorts {
  conversations: ConversationStore;
  threads: ThreadStore;
  /** The thread a command lands on: derived from the starter and the command, so a retry finds it. */
  threadIdFor(accountId: string, commandId: string): string;
  readSequence: ReadContentSequence;
  readVisited: ReadVisitedAssets;
  validateSnippet: ValidateSnippetAnchor;
  resolveSnippet: ResolveSnippetAnchor;
}
