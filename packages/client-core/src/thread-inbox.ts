import type { ContentThreadRef, ThreadMessage, ThreadSummary } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';
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

/** What the invitation card in Talk shows: the people and content named in words, nothing of the conversation. */
export interface InvitationCardView {
  readonly heading: string;
  readonly detail: string;
  readonly kind: 'reel' | 'scroll' | undefined;
}

/**
 * C03's "new thread" card. An invitation names only who asked and what the thread is about; who else
 * is in it stays unseen until the person joins.
 */
export function invitationCardView(item: ThreadSummary): InvitationCardView {
  const inviter = item.people[0]?.displayName ?? 'A friend';
  const metadata =
    item.root.status === 'available'
      ? item.root.metadata
      : item.root.status === 'corrected'
        ? item.root.current.metadata
        : undefined;
  const title = item.name ?? metadata?.title;
  return {
    heading: title === undefined ? `${inviter} started a thread` : `${inviter} started a thread · ${title}`,
    detail: metadata === undefined ? 'with you' : `with you · ${kindWord(metadata.kind)}`,
    kind: metadata?.kind,
  };
}

/** How answering an invitation ended; `unavailable` means the invitation changed or ended meanwhile. */
export type InvitationAnswer = 'done' | 'unavailable' | 'offline' | 'failed' | 'ended';

/**
 * Joins or declines an invitation from Talk (C03: Join thread, Ignore). Ignoring is the same
 * `thread.respond` decline the thread's own screen sends: it ends the invitation for this person
 * only, and nobody else's list or notice changes. The caller keeps `commandId` for the intent, so a
 * retry after an unknown outcome is the same command.
 */
export async function answerThreadInvitation(
  scope: AccountScope,
  thread: ContentThreadRef,
  response: 'join' | 'decline',
  commandId: string,
): Promise<InvitationAnswer> {
  try {
    await scope.api.threads.respond({ version: VERSION, commandId, thread, response });
    return 'done';
  } catch (error) {
    const failure = talkFailure(error);
    return failure === 'stale' ? 'failed' : failure;
  }
}

/**
 * Who a thread composer addresses ("Message Ravi and Meera"): each person's first word. When two
 * people share a first word, each gets the first letter of the rest of the name ("Sam K."), and the
 * handle if even that is shared, so nobody is ever named the same as someone else in the line.
 * Nobody to address reads "everyone".
 */
export function composerAddressees(
  people: readonly { readonly displayName: string; readonly handle: string }[],
): string {
  const words = (person: { readonly displayName: string }) => person.displayName.trim().split(/\s+/);
  const firstWord = (person: { readonly displayName: string }) => words(person)[0] ?? '';
  const withInitial = (person: { readonly displayName: string }) => {
    const initial = words(person).slice(1).join(' ').charAt(0).toUpperCase();
    return initial === '' ? firstWord(person) : `${firstWord(person)} ${initial}.`;
  };
  const sameAs = (
    label: (person: { readonly displayName: string }) => string,
    person: { readonly displayName: string },
  ) => people.filter((other) => label(other).toLowerCase() === label(person).toLowerCase()).length > 1;
  const names = people.map((person) => {
    if (!sameAs(firstWord, person)) return firstWord(person);
    return sameAs(withInitial, person) ? `@${person.handle}` : withInitial(person);
  });
  if (names.length === 0) return 'everyone';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}
