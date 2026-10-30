import type { MessageQuote, MessageReactionKind, PublicPersonRef } from '@knowscroll/contracts';

/** What both a direct message and a thread message look like to the parts of Talk that quote and react to them. */
export type QuotableMessage =
  | {
      readonly status: 'available';
      readonly messageId: string;
      readonly sequence: number;
      readonly author: PublicPersonRef;
      readonly recordedAt: string;
      readonly body:
        | { readonly kind: 'text'; readonly text: string }
        | { readonly kind: 'content' | 'snippet'; readonly note?: string };
      readonly replyTo?: MessageQuote | undefined;
      readonly reactions?:
        | readonly {
            readonly kind: MessageReactionKind;
            readonly mine: boolean;
            readonly people: readonly PublicPersonRef[];
          }[]
        | undefined;
    }
  | { readonly status: 'unavailable'; readonly messageId: string; readonly sequence: number };

/** The most characters of an original shown in a quote or above the message box. */
const PREVIEW_LENGTH = 120;

/** The first words of a message: its text, or a card's note, or nothing for a card with none. */
export function messagePreview(message: QuotableMessage): string {
  if (message.status === 'unavailable') return '';
  const words = (message.body.kind === 'text' ? message.body.text : (message.body.note ?? ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const letters = [...words];
  return letters.length <= PREVIEW_LENGTH ? words : `${letters.slice(0, PREVIEW_LENGTH - 1).join('')}…`;
}

/** What a reply's quote strip shows: who said it and the first words, or that the original is gone. */
export interface QuoteView {
  readonly messageId: string;
  readonly sequence: number;
  /** Undefined when the original was removed: the strip says so and does not jump. */
  readonly author: string | undefined;
  readonly preview: string;
}

/**
 * The quote of a reply. The reader's own copy of the original wins over the words the server sent with
 * the reply, because the copy is newer: an original removed after the reply was read stops being
 * quoted as soon as its tombstone arrives. When the original is not loaded (it is older than the
 * page) the server's words stand.
 */
export function quoteView(replyTo: MessageQuote, loaded: readonly QuotableMessage[]): QuoteView {
  const own = loaded.find((candidate) => candidate.sequence === replyTo.sequence);
  if (own?.status === 'unavailable')
    return { messageId: replyTo.messageId, sequence: replyTo.sequence, author: undefined, preview: '' };
  if (own?.status === 'available')
    return {
      messageId: own.messageId,
      sequence: own.sequence,
      author: own.author.displayName,
      preview: messagePreview(own),
    };
  return replyTo.original.status === 'available'
    ? {
        messageId: replyTo.messageId,
        sequence: replyTo.sequence,
        author: replyTo.original.author.displayName,
        preview: replyTo.original.preview,
      }
    : { messageId: replyTo.messageId, sequence: replyTo.sequence, author: undefined, preview: '' };
}

/** The reactions the reader has put on a message. */
export function heldReactions(message: QuotableMessage): ReadonlySet<MessageReactionKind> {
  const held = message.status === 'available' ? (message.reactions ?? []).filter((r) => r.mine) : [];
  return new Set(held.map((reaction) => reaction.kind));
}

/**
 * Who reacted, for the list a pill opens: "You" first, then the others by name. `ownPersonId` is the
 * reader's own public person ID; without it nobody is called "You".
 */
export function reactorNames(people: readonly PublicPersonRef[], ownPersonId: string | undefined): string[] {
  const own = people.filter((person) => person.personId === ownPersonId).map(() => 'You');
  const others = people
    .filter((person) => person.personId !== ownPersonId)
    .map((person) => person.displayName)
    .sort((a, b) => a.localeCompare(b));
  return [...own, ...others];
}

/**
 * The message a waiting reply answers, unless the reader's own copy shows it was removed meanwhile: then there is
 * nothing left to answer and the reply chip goes. A message not loaded (older than the page) is taken as it is.
 */
export function liveReplyTarget<M extends QuotableMessage>(
  target: M | undefined,
  loaded: readonly QuotableMessage[],
): M | undefined {
  if (target === undefined) return undefined;
  return loaded.find((candidate) => candidate.sequence === target.sequence)?.status === 'unavailable'
    ? undefined
    : target;
}
