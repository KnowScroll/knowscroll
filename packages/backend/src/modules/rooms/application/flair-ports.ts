import type { FlairActs, FlairChoice } from '../domain/flair.js';

/**
 * The rows flair and the sky's star moments read (migration 0102, D-341). The stores that read them are `FlairStore` and
 * `SkyStore` in `ports.ts`. Nothing here is stored as flair: it is the acts counted from rows that exist, and the member's own choice.
 */

/** A current member of the room as flair sees them: what they did here and what they chose to show. */
export interface FlairMember {
  readonly accountId: string;
  readonly choice: FlairChoice;
  readonly acts: FlairActs;
}

/** What the sky needs of a message that earned a star to say who wrote it and where it is. */
export interface AnswerSource {
  readonly messageId: string;
  readonly discussionId: string;
  /** The message is still shown to members: not removed, not a tombstone. */
  readonly shown: boolean;
  /** Null once the author's account was deleted. */
  readonly authorAccountId: string | null;
}

/** The room's own rows that a star of each act points at. */
export interface StarSources {
  readonly answers: ReadonlyMap<string, AnswerSource>;
  /** How many people answered a finished Launch, by Launch. */
  readonly launches: ReadonlyMap<string, number>;
}
