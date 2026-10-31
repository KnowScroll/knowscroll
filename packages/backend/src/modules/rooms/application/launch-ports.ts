/**
 * The rows of the Launch (migration 0086, D-178) as the use cases read them. The store that reads and writes them is `LaunchStore` in
 * `ports.ts`, with the room's other stores.
 */

export interface LaunchRow {
  readonly launchId: string;
  /** The approved deck this Launch was made from; a deck is played once. */
  readonly deckRitualId: string;
  /** The frozen questions as stored; the use case parses them before trusting them. */
  readonly questions: unknown;
  /** When the first question opens. */
  readonly startsAt: Date;
  /** When the Launch was started: the start of its lobby. */
  readonly createdAt: Date;
  readonly state: 'live' | 'finished';
  readonly finishedAt: Date | null;
  /** How many people answered at least once, and whether the room earned a star. Set once, when it finished. */
  readonly played: number | null;
  readonly star: boolean | null;
}

/** An approved deck nobody has played yet. */
export interface ReadyDeck {
  readonly ritualId: string;
  readonly payload: unknown;
}

export interface StoredAnswer {
  readonly accountId: string;
  readonly round: number;
  readonly choice: number;
  readonly correct: boolean;
  readonly elapsedMs: number;
}
