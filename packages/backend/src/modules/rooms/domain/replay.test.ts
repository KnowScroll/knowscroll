import { describe, expect, it } from 'vitest';
import { PLAY_MS, RESULTS_KEPT_DAYS, endsAt } from './launch.js';
import { playedBy, replayOffered, replayWindow, roundFigures, visibleTo, type RecordedAnswer } from './replay.js';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const DAY = 86_400_000;

const answer = (accountId: string, round: number, correct: boolean, elapsedMs: number): RecordedAnswer => ({
  accountId,
  round,
  correct,
  elapsedMs,
});

describe('when a Launch can be replayed (D-241)', () => {
  it('opens when the play time ends and closes when the answers are deleted, the same seven days the purge counts', () => {
    const { startedBefore, startedAfter } = replayWindow(NOW);
    // A Launch that started exactly one play time ago has just ended: its replay opens at that instant.
    expect(endsAt(startedBefore).getTime()).toBe(NOW.getTime());
    // One that ended exactly seven days ago is the last whose answers are kept.
    expect(NOW.getTime() - endsAt(startedAfter).getTime()).toBe(RESULTS_KEPT_DAYS * DAY);
    expect(startedBefore.getTime() - startedAfter.getTime()).toBe(RESULTS_KEPT_DAYS * DAY);
  });

  it('is not open for a Launch still being played', () => {
    const { startedBefore } = replayWindow(NOW);
    const running = new Date(NOW.getTime() - PLAY_MS + 1);
    expect(running.getTime() > startedBefore.getTime()).toBe(true);
  });
});

describe('who is offered it, and what they may see', () => {
  const recorded = [answer('ana', 1, true, 2_000), answer('ben', 1, false, 3_000)];

  it('offers a replay when somebody answered and the reader did not', () => {
    expect(replayOffered(recorded, new Set(), 'cat')).toBe(true);
  });

  it('does not offer a person the Launch they played: they would be played against themselves', () => {
    expect(replayOffered(recorded, new Set(), 'ana')).toBe(false);
  });

  it('offers nothing when nobody answered, or when everyone who did is a person the reader blocked', () => {
    expect(replayOffered([], new Set(), 'cat')).toBe(false);
    expect(replayOffered(recorded, new Set(['ana', 'ben']), 'cat')).toBe(false);
    expect(replayOffered(recorded, new Set(['ana']), 'cat')).toBe(true);
  });

  it('counts the people who answered, not the answers, and leaves out a blocked person', () => {
    const many = [...recorded, answer('ana', 2, true, 1_000)];
    expect(playedBy(many)).toBe(2);
    expect(playedBy(visibleTo(many, new Set(['ana'])))).toBe(1);
  });
});

describe('the figures of one question', () => {
  const recorded = [
    answer('ana', 1, true, 2_000),
    answer('ben', 1, true, 4_000),
    answer('cho', 1, false, 1_000),
    answer('ana', 2, false, 5_000),
  ];

  it('says how many answered, how many were right and who, quickest first', () => {
    expect(roundFigures(recorded, 1, undefined)).toEqual({
      locked: 3,
      right: 2,
      calledIt: ['ana', 'ben'],
      quicker: undefined,
    });
  });

  it('never lists the person who was wrong among those who got it right', () => {
    expect(roundFigures(recorded, 1, undefined).calledIt).not.toContain('cho');
  });

  it('counts how many right answers were quicker than the replayer, as a number and not a name', () => {
    expect(roundFigures(recorded, 1, 3_000).quicker).toBe(1);
    expect(roundFigures(recorded, 1, 1_500).quicker).toBe(0);
    expect(roundFigures(recorded, 1, 8_000).quicker).toBe(2);
    // A tie is not quicker: the same time beats nobody.
    expect(roundFigures(recorded, 1, 2_000).quicker).toBe(0);
  });

  it('says nothing about a question nobody answered', () => {
    expect(roundFigures(recorded, 5, 1_000)).toEqual({ locked: 0, right: 0, calledIt: [], quicker: 0 });
  });
});
