import type { RoomAskKind, RoomMessageAsk, RoomTopicTag } from '@knowscroll/contracts';

/** What a member asked of a resident, in a few words. Built from the kind the server names, never from model text. */
export const ASK_WORDS = {
  ask: 'Asked',
  challenge: 'Challenge',
  other_side: 'The other side',
  about: 'Asked about a message',
  mention: 'Named in a message',
} as const satisfies Record<RoomAskKind, string>;

/** A topic's tag, from the closed list (D-167). */
export const TAG_WORDS = {
  question: 'Question',
  debate: 'Debate',
  explainer: 'Explainer',
  share: 'Share',
} as const satisfies Record<RoomTopicTag, string>;

export const TAGS: readonly RoomTopicTag[] = ['question', 'debate', 'explainer', 'share'];

/**
 * The one line that says why a resident spoke when a member asked: who asked and what they asked. The asker is "you" when
 * it is the reader and absent when the reader blocked them or their account is gone.
 */
export function askedLine(ask: RoomMessageAsk, ownPersonId: string | undefined): string {
  const who = ask.by === undefined ? undefined : ask.by.personId === ownPersonId ? 'you' : ask.by.displayName;
  return who === undefined ? ASK_WORDS[ask.kind] : `Asked by ${who} · ${ASK_WORDS[ask.kind]}`;
}

/** The longest topic title the room accepts. */
export const TOPIC_TITLE_MAX = 80;

/**
 * A topic's title from the words it began with: whitespace collapsed and cut on a character boundary with an ellipsis, as
 * the server would, so what a person is shown to edit is what they get when they leave it.
 */
export function topicTitleFrom(words: string): string {
  const cleaned = words.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const characters = [...cleaned];
  return characters.length <= TOPIC_TITLE_MAX
    ? cleaned
    : `${characters
        .slice(0, TOPIC_TITLE_MAX - 1)
        .join('')
        .trimEnd()}…`;
}
