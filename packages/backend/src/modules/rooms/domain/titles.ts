/** The longest discussion title, in characters. */
export const TITLE_MAX_CHARS = 80;

/**
 * A discussion title made from some words (a content title, a shared card): whitespace and control
 * characters collapsed into single spaces and cut on a character boundary with an ellipsis. `fallback` is used
 * when nothing is left.
 */
export function titleFrom(words: string, fallback: string): string {
  // Whitespace and control characters alike separate words, so none glues two of them together.
  const cleaned = words.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (cleaned === '') return fallback;
  const characters = [...cleaned];
  return characters.length <= TITLE_MAX_CHARS
    ? cleaned
    : `${characters
        .slice(0, TITLE_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}

/** What a topic is called in place of words that may not be read: a title made from a message that is gone. */
export const NEUTRAL_TOPIC_TITLE = 'A topic from a message';

/** What is known of the message a topic began from, for one reader. */
export interface TitleOrigin {
  /** The message is shown (not removed) and its author's account is not deleted. */
  readonly shown: boolean;
  /** The reader has blocked the message's author. */
  readonly authorBlocked: boolean;
}

/**
 * The title a reader is shown. A title typed by the starter is the starter's own and is always shown. A title made
 * from the first words of a message is another person's words: it is shown only while that message is shown and its
 * author is not blocked by the reader; otherwise the reader reads `NEUTRAL_TOPIC_TITLE` (D-168).
 */
export function shownTitle(
  discussion: { readonly title: string; readonly titleDerived: boolean },
  origin: TitleOrigin | undefined,
): string {
  if (!discussion.titleDerived) return discussion.title;
  return origin?.shown === true && !origin.authorBlocked ? discussion.title : NEUTRAL_TOPIC_TITLE;
}
