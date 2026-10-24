import type { ContentThreadRef, PublicPersonRef } from '@knowscroll/contracts';
import type { StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { canTakePart } from '../domain/threads.js';
import type { InboxChange, MessageRow } from './conversation-ports.js';
import type { ReceiptKey } from './ports.js';
import { enterThread, enterThreadAsMember, threadRefOf, type EnteredThread } from './thread-gate.js';
import type { ThreadLock, ThreadMember, ThreadPorts } from './thread-ports.js';

declare const threadVisitBrand: unique symbol;

/**
 * A member's standing in one thread, valid while the transaction that entered it stays open. Another
 * module acts inside it (it holds the thread's lock), but cannot read or write Social's rows: it asks
 * for a bounded window of messages, records a receipt on the thread and tells the inboxes.
 */
export interface ThreadVisit {
  readonly [threadVisitBrand]: true;
  readonly threadId: string;
  /** The exact revision the thread started from. */
  readonly root: { readonly assetId: string; readonly assetRevision: number };
  readonly self: {
    readonly accountId: string;
    /** The member's own universe: the scope a worker acts in on their behalf. */
    readonly universeId: string;
    readonly privacyEpoch: number;
    readonly person: PublicPersonRef;
    readonly membership: ContentThreadRef;
  };
  /** Everyone who takes part now (joined, place standing), the visitor included. */
  readonly participants: readonly { readonly accountId: string; readonly person: PublicPersonRef }[];
}

/** A message as a model or a card may be told of it: its words, never its author's name. */
export interface ThreadContextMessage {
  readonly messageId: string;
  readonly sequence: number;
  /** The visitor wrote it. */
  readonly own: boolean;
  /** The text, or a snippet's note. */
  readonly text?: string;
  /** What a snippet points at, copied when it was sent. */
  readonly snippet?: {
    readonly kind: 'reel_range' | 'scroll_passage' | 'scroll_block';
    readonly quote?: string;
    readonly label?: string;
    readonly startMs?: number;
    readonly endMs?: number;
  };
}

export interface ThreadWindow {
  /** The newest messages that have a body, oldest first. */
  readonly recent: readonly ThreadContextMessage[];
  /** The message asked for, when it belongs to this thread and has a body. */
  readonly origin?: ThreadContextMessage;
}

export interface ThreadGuest {
  /**
   * Enters the thread for the caller's own request: the membership reference the client holds, the
   * caller's account gate and the thread's lock (`write` for commands, `read` for reads), in the lock
   * order of the blueprint. `undefined` for every refusal alike: not a member, a stale reference, a
   * place that no longer stands. A stranger never queues on the lock.
   */
  enter(scope: PersonalScopeTx, ref: ContentThreadRef, mode: 'write' | 'read'): Promise<ThreadVisit | undefined>;
  /** The same for a worker whose system scope acts for a member, by thread ID. */
  enterAsMember(scope: PersonalScopeTx, threadId: string, mode: 'write' | 'read'): Promise<ThreadVisit | undefined>;
  /** At most `limit` of the newest messages with a body, and one message of this thread by ID. */
  window(
    visit: ThreadVisit,
    query: { readonly limit: number; readonly originMessageId?: string },
  ): Promise<ThreadWindow>;
  /** Shared receipts on the thread, as every thread command keeps them. */
  readonly receipts: {
    find(
      visit: ThreadVisit,
      key: ReceiptKey,
    ): Promise<{ kind: 'new' } | { kind: 'replay'; outcome: unknown } | { kind: 'refused'; code: string }>;
    begin(visit: ThreadVisit, key: ReceiptKey): Promise<void>;
    complete(visit: ThreadVisit, key: ReceiptKey, outcome: object): Promise<void>;
  };
  /** Tells every participant's inbox that the thread changed. Hints go out after commit and carry no content. */
  announce(visit: ThreadVisit): Promise<void>;
}

/** What the guest needs beyond the thread ports: where a message of the thread sits in its sequence. */
export interface ThreadGuestPorts extends ThreadPorts {
  sequenceOf(lock: ThreadLock, messageId: string): Promise<number | undefined>;
}

type ContextSnippet = NonNullable<ThreadContextMessage['snippet']>;

const personOf = (member: ThreadMember) => ({ accountId: member.accountId, person: member.person });
const inboxOf = (member: ThreadMember): InboxChange => ({ accountId: member.accountId, universeId: member.universeId });

/**
 * The thread access another module needs (scenarios, later rooms): the same gates, lock and receipts
 * as Social's own thread commands, behind a small surface (blueprint §22 "Content-thread
 * implementation boundary"). It decides nothing new about who may take part.
 */
export function makeThreadGuest(p: ThreadGuestPorts): ThreadGuest {
  const entries = new WeakMap<ThreadVisit, EnteredThread>();

  function visitOf(entered: EnteredThread): ThreadVisit {
    const visit = {
      threadId: entered.thread.threadId,
      root: entered.thread.root,
      self: {
        accountId: entered.owner.accountId,
        universeId: entered.owner.universeId,
        privacyEpoch: entered.owner.privacyEpoch,
        person: entered.own.person,
        membership: threadRefOf(entered),
      },
      participants: entered.members.filter(canTakePart).map(personOf),
    } as unknown as ThreadVisit;
    entries.set(visit, entered);
    return visit;
  }
  const enteredBy = (visit: ThreadVisit): EnteredThread => {
    const entered = entries.get(visit);
    if (entered === undefined) throw new Error('SOCIAL_THREAD_VISIT_UNKNOWN');
    return entered;
  };

  function contextOf(
    entered: EnteredThread,
    row: MessageRow,
    snippets: ReadonlyMap<string, ContextSnippet>,
  ): ThreadContextMessage | undefined {
    if (row.author === null) return undefined;
    const text = row.text ?? row.note ?? undefined;
    const snippet = snippets.get(row.messageId);
    if (text === undefined && snippet === undefined) return undefined;
    return {
      messageId: row.messageId,
      sequence: row.sequence,
      own: row.author.personId === entered.own.person.personId,
      ...(text === undefined ? {} : { text }),
      ...(snippet === undefined ? {} : { snippet }),
    };
  }

  async function snippetsOf(entered: EnteredThread, rows: readonly MessageRow[]) {
    const ids = rows.filter((row) => row.content !== null).map((row) => row.messageId);
    const stored: ReadonlyMap<string, StoredSnippetAnchor> =
      ids.length === 0 ? new Map() : await p.threads.snippetsOf(entered.lock, ids);
    const out = new Map<string, ContextSnippet>();
    for (const [messageId, anchor] of stored) {
      out.set(
        messageId,
        anchor.kind === 'reel_range'
          ? { kind: anchor.kind, startMs: anchor.startMs, endMs: anchor.endMs }
          : anchor.kind === 'scroll_passage'
            ? { kind: anchor.kind, quote: anchor.quote }
            : { kind: anchor.kind, label: anchor.label },
      );
    }
    return out;
  }

  return {
    async enter(scope, ref, mode) {
      const entered = await enterThread(p, scope, ref, mode);
      return entered === undefined ? undefined : visitOf(entered);
    },
    async enterAsMember(scope, threadId, mode) {
      const entered = await enterThreadAsMember(p, scope, threadId, mode);
      return entered === undefined ? undefined : visitOf(entered);
    },
    async window(visit, query) {
      const entered = enteredBy(visit);
      const threadId = entered.thread.threadId;
      const rows = await p.conversations.messages(entered.lock, threadId, { limit: query.limit });
      const sequence =
        query.originMessageId === undefined ? undefined : await p.sequenceOf(entered.lock, query.originMessageId);
      const [originRow] =
        sequence === undefined
          ? []
          : await p.conversations.messages(entered.lock, threadId, { before: sequence + 1, limit: 1 });
      const snippets = await snippetsOf(entered, originRow === undefined ? rows : [...rows, originRow]);
      const recent = [...rows].reverse().flatMap((row) => contextOf(entered, row, snippets) ?? []);
      const origin = originRow === undefined ? undefined : contextOf(entered, originRow, snippets);
      return { recent, ...(origin === undefined ? {} : { origin }) };
    },
    receipts: {
      find: (visit, key) => p.store.findReceipt(enteredBy(visit).lock, key),
      begin: (visit, key) => p.store.beginReceipt(enteredBy(visit).lock, key),
      complete: (visit, key, outcome) => p.store.receipt(enteredBy(visit).lock, key, outcome),
    },
    async announce(visit) {
      const entered = enteredBy(visit);
      await p.conversations.announce(entered.lock, entered.members.filter(canTakePart).map(inboxOf), () => p.newId());
    },
  };
}
