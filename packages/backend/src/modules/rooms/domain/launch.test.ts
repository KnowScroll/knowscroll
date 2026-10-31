import { LAUNCH_ANSWER_SECONDS, LAUNCH_PODIUM_PLACES, LAUNCH_QUESTIONS } from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_MS,
  LOBBY_MS,
  PLAY_MS,
  PODIUM_PLACES,
  QUESTIONS,
  REVEAL_MS,
  ROUND_MS,
  answerTiming,
  earliestDeckDay,
  earnsStar,
  endsAt,
  phaseAt,
  playedCount,
  podiumOf,
  podiumReadable,
  resultsOf,
  roundOpensAt,
  startsAtFrom,
  type ScoredAnswer,
  type ScoredPlayer,
} from './launch.js';

const START = new Date('2026-10-31T21:30:00.000Z');
const at = (ms: number) => new Date(START.getTime() + ms);

describe('the clock of a Launch (D-178)', () => {
  it('agrees with the contract on the shape of a game', () => {
    expect(QUESTIONS).toBe(LAUNCH_QUESTIONS);
    expect(ANSWER_MS).toBe(LAUNCH_ANSWER_SECONDS * 1000);
    expect(PODIUM_PLACES).toBe(LAUNCH_PODIUM_PLACES);
    expect(PLAY_MS).toBe(QUESTIONS * (ANSWER_MS + REVEAL_MS));
  });

  it('opens the first question after the lobby and each later one a round after', () => {
    const started = new Date('2026-10-31T21:29:40.000Z');
    expect(startsAtFrom(started).toISOString()).toBe(START.toISOString());
    expect(LOBBY_MS).toBe(20_000);
    expect(roundOpensAt(START, 1).getTime()).toBe(START.getTime());
    expect(roundOpensAt(START, 3).getTime()).toBe(START.getTime() + 2 * ROUND_MS);
    expect(endsAt(START).getTime()).toBe(START.getTime() + PLAY_MS);
  });

  it('says what is happening at each instant, as time left on the server clock', () => {
    expect(phaseAt(START, at(-5_000))).toEqual({ kind: 'lobby', startsInMs: 5_000 });
    expect(phaseAt(START, at(0))).toEqual({ kind: 'open', round: 1, closesInMs: ANSWER_MS });
    expect(phaseAt(START, at(3_000))).toEqual({ kind: 'open', round: 1, closesInMs: ANSWER_MS - 3_000 });
    expect(phaseAt(START, at(ANSWER_MS - 1))).toEqual({ kind: 'open', round: 1, closesInMs: 1 });
    // The answer shows from the instant the question closes.
    expect(phaseAt(START, at(ANSWER_MS))).toEqual({ kind: 'reveal', round: 1, nextInMs: REVEAL_MS, last: false });
    expect(phaseAt(START, at(ROUND_MS - 1))).toEqual({ kind: 'reveal', round: 1, nextInMs: 1, last: false });
    expect(phaseAt(START, at(ROUND_MS))).toEqual({ kind: 'open', round: 2, closesInMs: ANSWER_MS });
    expect(phaseAt(START, at(4 * ROUND_MS + ANSWER_MS))).toEqual({
      kind: 'reveal',
      round: 5,
      nextInMs: REVEAL_MS,
      last: true,
    });
    expect(phaseAt(START, at(PLAY_MS - 1)).kind).toBe('reveal');
    expect(phaseAt(START, at(PLAY_MS))).toEqual({ kind: 'over' });
  });

  it('judges an answer by the server clock alone, for the open round only', () => {
    expect(answerTiming(START, 1, at(0))).toEqual({ elapsedMs: 0 });
    expect(answerTiming(START, 1, at(2_345))).toEqual({ elapsedMs: 2_345 });
    expect(answerTiming(START, 1, at(ANSWER_MS - 1))).toEqual({ elapsedMs: ANSWER_MS - 1 });
    // Too late, before it began, and for a round that is not open: nothing is accepted, whatever a device says.
    expect(answerTiming(START, 1, at(ANSWER_MS))).toBeUndefined();
    expect(answerTiming(START, 1, at(-1))).toBeUndefined();
    expect(answerTiming(START, 2, at(1_000))).toBeUndefined();
    expect(answerTiming(START, 1, at(ROUND_MS + 1_000))).toBeUndefined();
    expect(answerTiming(START, 2, at(ROUND_MS + 1_000))).toEqual({ elapsedMs: 1_000 });
    expect(answerTiming(START, 5, at(PLAY_MS))).toBeUndefined();
  });

  it('measures from the same opening whoever answers, so a slow device only loses its own time', () => {
    const quick = answerTiming(START, 3, at(2 * ROUND_MS + 900));
    const slow = answerTiming(START, 3, at(2 * ROUND_MS + 4_100));
    expect(quick?.elapsedMs).toBe(900);
    expect(slow?.elapsedMs).toBe(4_100);
  });
});

const player = (id: string, joinedMs = 0): ScoredPlayer => ({ accountId: id, joinedAt: at(joinedMs) });
const right = (accountId: string, round: number, elapsedMs: number): ScoredAnswer => ({
  accountId,
  round,
  correct: true,
  elapsedMs,
});
const wrong = (accountId: string, round: number, elapsedMs: number): ScoredAnswer => ({
  accountId,
  round,
  correct: false,
  elapsedMs,
});

describe('scoring and the podium (D-178)', () => {
  it('scores right answers, then breaks a tie by the total time of the right ones', () => {
    const results = resultsOf(
      [player('ash'), player('kenji'), player('ravi')],
      [
        right('ash', 1, 2_000),
        right('ash', 2, 2_000),
        right('kenji', 1, 1_000),
        right('kenji', 2, 1_500),
        // A wrong answer is neither a point nor time held against anyone.
        wrong('kenji', 3, 100),
        right('ravi', 1, 500),
      ],
    );
    expect(results.map((result) => [result.accountId, result.score, result.totalMs])).toEqual([
      ['kenji', 2, 2_500],
      ['ash', 2, 4_000],
      ['ravi', 1, 500],
    ]);
  });

  it('breaks a tie of score and time by who joined first, and the same way every time', () => {
    const answers = [right('a', 1, 1_000), right('b', 1, 1_000)];
    const first = resultsOf([player('b', 2_000), player('a', 1_000)], answers);
    expect(first.map((result) => result.accountId)).toEqual(['a', 'b']);
    expect(resultsOf([player('a', 1_000), player('b', 2_000)], answers).map((result) => result.accountId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('draws one square per question that says right or not and never what was picked', () => {
    const [result] = resultsOf([player('ash')], [right('ash', 1, 1), wrong('ash', 2, 1), right('ash', 5, 1)]);
    expect(result?.squares).toEqual([true, false, false, false, true]);
    expect(result?.squares).toHaveLength(LAUNCH_QUESTIONS);
    expect(JSON.stringify(result?.squares)).not.toMatch(/choice|option/);
  });

  it('lists the top three with a right answer and nobody below them or with nothing', () => {
    const players = ['a', 'b', 'c', 'd', 'e'].map((id) => player(id));
    const results = resultsOf(players, [
      right('a', 1, 100),
      right('b', 1, 200),
      right('c', 1, 300),
      right('d', 1, 400),
      wrong('e', 1, 50),
    ]);
    const podium = podiumOf(results);
    expect(podium.map((entry) => [entry.place, entry.accountId])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    // A person who answered and got nothing right is a player who is not on the podium, and nobody is shamed by it.
    expect(playedCount(results)).toBe(5);
    expect(podiumOf(resultsOf([player('e')], [wrong('e', 1, 50)]))).toEqual([]);
  });

  it('counts a player who only joined as not having played', () => {
    expect(playedCount(resultsOf([player('a'), player('b')], [right('a', 1, 1)]))).toBe(1);
  });

  it('earns the room a star only when two different people played', () => {
    expect(earnsStar(0)).toBe(false);
    expect(earnsStar(1)).toBe(false);
    expect(earnsStar(2)).toBe(true);
  });
});

describe('what a deck and a podium last for', () => {
  it('plays the deck of today or of yesterday', () => {
    expect(earliestDeckDay(new Date('2026-10-31T23:59:00Z'))).toBe('2026-10-30');
    expect(earliestDeckDay(new Date('2026-11-01T00:00:00Z'))).toBe('2026-10-31');
  });

  it('is read for a day after the Launch and then gone', () => {
    const finished = new Date('2026-10-31T22:40:00Z');
    expect(podiumReadable(finished, new Date('2026-11-01T22:39:59Z'))).toBe(true);
    expect(podiumReadable(finished, new Date('2026-11-01T22:40:00Z'))).toBe(false);
  });
});
