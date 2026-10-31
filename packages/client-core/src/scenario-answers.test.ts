import { describe, expect, it } from 'vitest';
import type { ScenarioAnswer, ScenarioCard } from '@knowscroll/contracts';
import {
  THREAD_DAILY_BRANCH_CAP,
  WHAT_IF_MADE_BY,
  answerLabel,
  answerStage,
  answersKey,
  awaitingServer,
  branchesMadeToday,
  madeInSeconds,
  threadMadeAllToday,
} from './scenario-answers';

const ready: ScenarioAnswer = {
  status: 'ready',
  madeBy: 'knowscroll',
  assumption: 'We read “twice the size” as twice as wide, same rock.',
  answer: 'Tides would likely be much stronger, because a heavier moon pulls harder on the sea.',
  numbers: [],
  readyAt: '2026-10-24T10:00:26.400Z',
};
const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: '0199a000-0000-7000-8000-000000000001',
  kind: 'what_if',
  origin: 'root',
  title: 'What if the Moon were twice its current size?',
  changes: [{ subject: 'Moon', statement: 'The Moon is twice as wide' }],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [{ subject: 'Moon', statement: 'The Moon is twice as wide' }],
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  ...patch,
});
const at = (time: string) => new Date(`2026-10-24T${time}Z`);

describe('the stage a short answer is in', () => {
  it('is none for a perspective, an old branch and a removed one', () => {
    expect(answerStage(card(), at('10:00:05'))).toBe('none');
    expect(answerStage(card({ status: 'removed', answer: ready }), at('10:00:05'))).toBe('none');
  });

  it('waits honestly, and says it is taking longer once the wait has gone past the usual', () => {
    const making = card({ answer: { status: 'making' } });
    expect(answerStage(making, at('10:00:05'))).toBe('making');
    expect(answerStage(making, at('10:01:29'))).toBe('making');
    expect(answerStage(making, at('10:01:30'))).toBe('slow');
  });

  it('is ready or unavailable as the server says', () => {
    expect(answerStage(card({ answer: ready }), at('10:05:00'))).toBe('ready');
    expect(answerStage(card({ answer: { status: 'unavailable' } }), at('10:05:00'))).toBe('unavailable');
  });
});

describe('when the board is read again soon', () => {
  it('while a branch is preparing or an answer is being made, and not otherwise', () => {
    expect(awaitingServer([])).toBe(false);
    expect(awaitingServer([card({ status: 'ready' })])).toBe(false);
    expect(awaitingServer([card({ status: 'preparing' })])).toBe(true);
    expect(awaitingServer([card({ status: 'ready', answer: { status: 'making' } })])).toBe(true);
    expect(awaitingServer([card({ status: 'ready', answer: ready }), card({ status: 'failed' })])).toBe(false);
  });
});

describe('the key that keeps a reader at the end', () => {
  it('changes when an answer arrives or ends, and not while one is being made or on a branch with none', () => {
    const making = card({ answer: { status: 'making' } });
    expect(answersKey([making, card()])).toBe('0');
    expect(answersKey([card({ answer: ready }), making])).toBe('1');
    expect(answersKey([card({ answer: { status: 'unavailable' } }), card({ answer: ready })])).toBe('2');
  });
});

describe('how long it took', () => {
  it('is the seconds from choosing to ready, rounded, only for a ready answer', () => {
    expect(madeInSeconds(card({ answer: ready }))).toBe(26);
    expect(madeInSeconds(card({ answer: { status: 'making' } }))).toBeUndefined();
    expect(madeInSeconds(card())).toBeUndefined();
    expect(madeInSeconds(card({ answer: { ...ready, readyAt: '2026-10-24T09:59:00.000Z' } }))).toBe(0);
  });
});

describe('five a day', () => {
  const cardsOn = (day: string, count: number) =>
    Array.from({ length: count }, (_, index) => card({ createdAt: `${day}T0${String(index)}:00:00.000Z` }));

  it('counts the branches made since the start of the UTC day, removed ones included', () => {
    const cards = [
      ...cardsOn('2026-10-23', 4),
      ...cardsOn('2026-10-24', 3),
      card({ status: 'removed', createdAt: '2026-10-24T08:00:00.000Z' }),
    ];
    expect(branchesMadeToday(cards, at('12:00:00'))).toBe(4);
    expect(branchesMadeToday(cardsOn('2026-10-23', 4), new Date('2026-10-23T23:59:59Z'))).toBe(4);
    expect(branchesMadeToday(cardsOn('2026-10-23', 4), new Date('2026-10-24T00:00:00Z'))).toBe(0);
  });

  it('says the thread has made all it may at five, and not at four', () => {
    expect(THREAD_DAILY_BRANCH_CAP).toBe(5);
    expect(threadMadeAllToday(cardsOn('2026-10-24', 4), at('12:00:00'))).toBe(false);
    expect(threadMadeAllToday(cardsOn('2026-10-24', 5), at('12:00:00'))).toBe(true);
    // Five yesterday is not five today.
    expect(threadMadeAllToday(cardsOn('2026-10-23', 5), at('12:00:00'))).toBe(false);
  });
});

describe('the label', () => {
  it('names KnowScroll as the maker in the card’s accessible name, whatever state it is in', () => {
    expect(WHAT_IF_MADE_BY).toBe('What-if · made by KnowScroll');
    expect(answerLabel(card({ answer: ready }))).toBe(
      `${WHAT_IF_MADE_BY}: What if the Moon were twice its current size?, ready`,
    );
    expect(answerLabel(card({ answer: { status: 'making' } }))).toContain('being made');
    expect(answerLabel(card({ answer: { status: 'unavailable' } }))).toContain('no short answer');
  });
});
