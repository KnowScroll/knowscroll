import type { ContentThreadRef, ThreadMessage, ThreadSummary } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { formatRange } from './thread-snippets';

const VERSION = 'content-thread.v1' as const;
const LIMIT = 50;

/** The person's open threads, joined and invited, newest activity first (at most 50). A failed request throws; `talkFailure` classifies it. */
export async function readThreadSummaries(scope: AccountScope, newId: () => string): Promise<readonly ThreadSummary[]> {
  const inbox = await scope.api.threads.inbox({ version: VERSION, readId: newId(), limit: LIMIT });
  return inbox.items;
}

/**
 * The person's own reference to a thread they know only by its ID (a link into a thread), found
 * in their own thread list; `undefined` when it is not there, which a screen shows as unavailable.
 */
export async function findThread(
  scope: AccountScope,
  newId: () => string,
  threadId: string,
): Promise<ContentThreadRef | undefined> {
  return (await readThreadSummaries(scope, newId)).find((item) => item.thread.threadId === threadId)?.thread;
}

const kindWord = (kind: 'reel' | 'scroll') => (kind === 'reel' ? 'Reel' : 'Scroll');

/** A snippet as one line of words: "a moment of a Reel · 0:18–0:31", "a passage of a Scroll". */
function describeSnippet(message: Extract<ThreadMessage, { status: 'available' }>): string {
  if (message.body.kind !== 'snippet') return '';
  const snippet = message.body.snippet;
  switch (snippet.kind) {
    case 'reel_range':
      return `a moment of a Reel · ${formatRange(snippet.startMs, snippet.endMs)}`;
    case 'scroll_passage':
      return 'a passage of a Scroll';
    case 'scroll_block':
      return snippet.settings.included ? 'a part of a Scroll, as they set it' : 'a part of a Scroll';
  }
}

/** The one-line description of a thread message, from the reader's point of view. */
export function describeThreadMessage(message: ThreadMessage, ownPersonId: string): string {
  if (message.status === 'unavailable') return 'Message removed';
  const mine = message.author.personId === ownPersonId;
  const who = mine ? 'You' : message.author.displayName;
  if (message.body.kind === 'text') return `${who}: ${message.body.text}`;
  return `${who} shared ${describeSnippet(message)}`;
}

/** What a Talk row for a thread shows: plain words only, never a count of people or a score. */
export interface ThreadRowView {
  readonly title: string;
  readonly subtitle: string;
  readonly invited: boolean;
  /** A message the person has not read is waiting (never a count). */
  readonly unread: boolean;
  readonly at: Date;
}

function titleOf(item: ThreadSummary): string {
  if (item.name !== undefined) return item.name;
  if (item.root.status === 'available') return item.root.metadata.title;
  if (item.root.status === 'corrected') return item.root.current.metadata.title;
  return 'Shared thread';
}

export function threadRowView(item: ThreadSummary): ThreadRowView {
  const invited = item.state === 'invited';
  const inviter = item.people[0]?.displayName ?? 'A friend';
  const content =
    item.root.status === 'available' || item.root.status === 'corrected'
      ? kindWord((item.root.status === 'available' ? item.root.metadata : item.root.current.metadata).kind)
      : 'content';
  const subtitle = invited
    ? `${inviter} invited you to explore a ${content}`
    : item.lastMessage === undefined
      ? 'No messages yet'
      : describeThreadMessage(item.lastMessage, item.ownPersonId);
  const last = item.lastMessage;
  const mine = last?.status === 'available' && last.author.personId === item.ownPersonId;
  return {
    title: titleOf(item),
    subtitle,
    invited,
    unread: invited || (!mine && item.latestMessageSequence > item.own.readThroughSequence),
    at: new Date(item.lastActivityAt),
  };
}
