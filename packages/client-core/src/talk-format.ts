import type { ConversationMessage, DirectConversationSummary } from '@knowscroll/contracts';

/** What an inbox row shows: plain text only, never a score or an internal state. */
export interface InboxRowView {
  readonly preview: string;
  /** The newest message is the peer's and the person has not read it. */
  readonly unread: boolean;
  readonly at: Date | undefined;
}

const kindWord = (kind: 'reel' | 'scroll') => (kind === 'reel' ? 'Reel' : 'Scroll');

/**
 * The one-line description of a message, from the point of view of the person reading it:
 * "You: …" for their own, a card as "Shared a Reel · Title", a removed message as plain text.
 */
export function describeMessage(message: ConversationMessage, peerPersonId: string): string {
  if (message.status === 'unavailable') return 'Message removed';
  const mine = message.author.personId !== peerPersonId;
  if (message.body.kind === 'text') return mine ? `You: ${message.body.text}` : message.body.text;
  const content = message.body.content;
  const shared = mine ? 'You shared' : 'Shared';
  if (content.status === 'unavailable') return `${shared} content · no longer available`;
  const metadata = content.status === 'available' ? content.metadata : content.current.metadata;
  return `${shared} a ${kindWord(metadata.kind)} · ${metadata.title}`;
}

export function inboxRowView(item: DirectConversationSummary): InboxRowView {
  const last = item.lastMessage;
  const mine = last?.status === 'available' && last.author.personId !== item.peer.personId;
  return {
    preview: last ? describeMessage(last, item.peer.personId) : '',
    unread: !mine && item.latestMessageSequence > item.own.readThroughSequence,
    at: last?.status === 'available' ? new Date(last.recordedAt) : undefined,
  };
}

/** Time in a list row: the clock time today, "Yesterday", a weekday within a week, else the date. */
export function listTime(at: Date, now: Date, locale?: string): string {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return at.toLocaleDateString(locale, { weekday: 'short' });
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** The divider above a day's messages: "Today", "Yesterday", else the date. */
export function dayLabel(at: Date, now: Date, locale?: string): string {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(days > 300 ? { year: 'numeric' } : {}) });
}

/**
 * The capsule above a day's messages (T3 kit): "Today", "Yesterday", then "Sun 26 Oct", with the year once the
 * day is not in this year. The type role draws it in capitals; the words stay as they are for a screen reader.
 */
export function capsuleLabel(at: Date, now: Date, locale?: string): string {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const weekday = at.toLocaleDateString(locale, { weekday: 'short' });
  const month = at.toLocaleDateString(locale, { month: 'short' });
  const date = `${weekday} ${String(at.getDate())} ${month}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date} ${String(at.getFullYear())}`;
}

/** The day a message belongs to, in the reader's own time zone, as a stable key for grouping. */
export function dayKey(at: Date): string {
  return `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;
}

/** The clock time shown under a run of messages, in the reader's own time zone. */
export function clockTime(at: Date, locale?: string): string {
  return at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** A pause this long between two messages by one author starts a new run. */
export const RUN_GAP_MS = 5 * 60_000;

/** One message as the grouping into runs sees it. */
export interface RunStep {
  readonly authorId: string;
  readonly at: Date;
}

/**
 * Whether a message is the last of its run, the one that carries the time: the next message is by
 * someone else, comes after a pause of five minutes or more, or falls on another day.
 */
export function endsRun(current: RunStep, next: RunStep | undefined): boolean {
  if (next === undefined) return true;
  if (next.authorId !== current.authorId) return true;
  if (dayKey(next.at) !== dayKey(current.at)) return true;
  return next.at.getTime() - current.at.getTime() >= RUN_GAP_MS;
}
