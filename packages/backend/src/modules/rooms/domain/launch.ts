/**
 * The Launch's rules (R3 E, D-178 to D-179): when each round is open, whether an answer arrived in time, how a player scores, and
 * who stands on the podium. Pure: the clock is an argument and nothing is read or written here. The server's own clock decides
 * every question of time, so a slow or fast device changes nothing but its own network delay.
 */

/** Questions in one Launch. The contract's `LAUNCH_QUESTIONS` is the same number. */
export const QUESTIONS = 5;
/** How long people have to join before the first question opens. */
export const LOBBY_MS = 20_000;
/** How long a question is open. */
export const ANSWER_MS = 8_000;
/** How long the answer is shown before the next question opens. */
export const REVEAL_MS = 5_000;
/** One round: the question, then its answer. */
export const ROUND_MS = ANSWER_MS + REVEAL_MS;
/** From the first question's opening to the end of the last round's answer. */
export const PLAY_MS = QUESTIONS * ROUND_MS;

/** The podium has three steps, for this Launch only. */
export const PODIUM_PLACES = 3;
/** The podium is read for a day after the Launch, then it is gone (R3 E: "gone after tonight"). */
export const PODIUM_LIFE_MS = 24 * 3_600_000;
/** The rest between the start of one Launch and the next in a room, in minutes, unless a world configures another (R3: one live quiz per two hours). */
export const LAUNCH_GAP_MINUTES_DEFAULT = 120;
/** A room gets a star for a Launch only when at least this many different people answered: a Launch played alone is not a room's act. */
export const MIN_PLAYERS_FOR_STAR = 2;
/** A Launch starts only while at least this many members have the room open (R3: "start a quiz (2+ here)"). */
export const MIN_HERE_TO_START = 2;
/** A deck of today or of the day before may be played, so a night's deck is still there the next evening. */
export const DECK_DAYS = 2;
/** The players and answers of a Launch are kept this many days after its play time ended, then deleted by the room's first member command after that. */
export const RESULTS_KEPT_DAYS = 7;

/** When the first question opens, from when the Launch was started. */
export const startsAtFrom = (startedAt: Date): Date => new Date(startedAt.getTime() + LOBBY_MS);

/** When round `round` (1 to 5) opens. */
export const roundOpensAt = (startsAt: Date, round: number): Date =>
  new Date(startsAt.getTime() + (round - 1) * ROUND_MS);

/** When the last round's answer is gone and the Launch is over. */
export const endsAt = (startsAt: Date): Date => new Date(startsAt.getTime() + PLAY_MS);

/** What a Launch is doing at one instant. Round numbers are one-based. */
export type Phase =
  | { readonly kind: 'lobby'; readonly startsInMs: number }
  | { readonly kind: 'open'; readonly round: number; readonly closesInMs: number }
  | { readonly kind: 'reveal'; readonly round: number; readonly nextInMs: number; readonly last: boolean }
  | { readonly kind: 'over' };

/**
 * The phase at `now`. A question is open for `ANSWER_MS` from its opening, then its answer shows for `REVEAL_MS`, then the next
 * question opens. Every number is a time left on the server's clock, so a device that is told "8 000 ms" counts the same 8 seconds
 * whatever its own clock says.
 */
export function phaseAt(startsAt: Date, now: Date): Phase {
  const sinceStart = now.getTime() - startsAt.getTime();
  if (sinceStart < 0) return { kind: 'lobby', startsInMs: -sinceStart };
  if (sinceStart >= PLAY_MS) return { kind: 'over' };
  const round = Math.floor(sinceStart / ROUND_MS) + 1;
  const intoRound = sinceStart % ROUND_MS;
  if (intoRound < ANSWER_MS) return { kind: 'open', round, closesInMs: ANSWER_MS - intoRound };
  return { kind: 'reveal', round, nextInMs: ROUND_MS - intoRound, last: round === QUESTIONS };
}

/**
 * Whether an answer that reached the server at `now` is in time, and how long after the question opened it came. An answer is
 * judged for the round the phase says is open: a late one, one before the Launch begins and one for a round that is not the open
 * one have no time (`undefined`). The measure is the server's own from the question's opening, never a device's.
 */
export function answerTiming(startsAt: Date, round: number, now: Date): { readonly elapsedMs: number } | undefined {
  const phase = phaseAt(startsAt, now);
  if (phase.kind !== 'open' || phase.round !== round) return undefined;
  return { elapsedMs: ANSWER_MS - phase.closesInMs };
}

/** One answer as scoring reads it. */
export interface ScoredAnswer {
  readonly accountId: string;
  readonly round: number;
  readonly correct: boolean;
  readonly elapsedMs: number;
}

/** One person in a Launch as scoring reads it. */
export interface ScoredPlayer {
  readonly accountId: string;
  readonly joinedAt: Date;
}

/** What one player did: how many they got right, how long the right ones took, and a square for each question. */
export interface PlayerResult {
  readonly accountId: string;
  readonly joinedAt: Date;
  /** Right answers. */
  readonly score: number;
  /** Total time of the right answers, in milliseconds: the tie-break (D-178). */
  readonly totalMs: number;
  /** Whether they answered at least one question. */
  readonly answered: boolean;
  /** One entry per question: true for a right answer, false for a wrong one or none. Never which option was picked. */
  readonly squares: readonly boolean[];
}

/**
 * Every player's result, best first: more right answers, then less total time on the right ones, then who joined first, then the
 * account (only so the order is the same every time; two people never differ on it unless they tied on everything else).
 */
export function resultsOf(players: readonly ScoredPlayer[], answers: readonly ScoredAnswer[]): readonly PlayerResult[] {
  const results = players.map((player): PlayerResult => {
    const own = answers.filter((answer) => answer.accountId === player.accountId);
    const right = own.filter((answer) => answer.correct);
    return {
      accountId: player.accountId,
      joinedAt: player.joinedAt,
      score: right.length,
      totalMs: right.reduce((sum, answer) => sum + answer.elapsedMs, 0),
      answered: own.length > 0,
      squares: Array.from({ length: QUESTIONS }, (_, index) =>
        own.some((answer) => answer.round === index + 1 && answer.correct),
      ),
    };
  });
  return results.toSorted(
    (a, b) =>
      b.score - a.score ||
      a.totalMs - b.totalMs ||
      a.joinedAt.getTime() - b.joinedAt.getTime() ||
      a.accountId.localeCompare(b.accountId),
  );
}

/** How many people took part: answered at least once. A player who only joined did not play. */
export const playedCount = (results: readonly PlayerResult[]): number =>
  results.filter((result) => result.answered).length;

/**
 * The podium: the first three people with at least one right answer, best first. Nobody below third is listed, and nobody with no
 * right answer is, so the podium never names a person for getting nothing (T-minus "never shames a wrong answer").
 */
export function podiumOf(results: readonly PlayerResult[]): readonly (PlayerResult & { readonly place: number })[] {
  return results
    .filter((result) => result.score > 0)
    .slice(0, PODIUM_PLACES)
    .map((result, index) => ({ ...result, place: index + 1 }));
}

/** Whether a finished Launch earns the room a star: enough different people answered (D-174, D-219). */
export const earnsStar = (played: number): boolean => played >= MIN_PLAYERS_FOR_STAR;

/** The deck's day: a Launch plays the newest unplayed approved deck of today or the day before. */
export const earliestDeckDay = (now: Date): string =>
  new Date(now.getTime() - (DECK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

/** Whether the podium of a Launch that finished at `finishedAt` can still be read. */
export const podiumReadable = (finishedAt: Date, now: Date): boolean =>
  now.getTime() - finishedAt.getTime() < PODIUM_LIFE_MS;
