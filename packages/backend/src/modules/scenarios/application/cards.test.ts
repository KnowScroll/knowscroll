import { describe, expect, it } from 'vitest';
import type { StoredAnswer } from '../domain/answer-card.js';
import { cardOf, servableAnswerOf } from './cards.js';
import type { NodeRow } from './ports.js';

/** A branch as stored, invented for these tests. */
const node = (answer: NodeRow['answer']): NodeRow => ({
  nodeId: '11111111-1111-4111-8111-111111111111',
  threadId: '22222222-2222-4222-8222-222222222222',
  kind: 'what_if',
  origin: { kind: 'root' },
  title: 'What if gravity were stronger?',
  changes: [{ subject: 'Gravity', statement: 'Gravity is stronger than it is' }],
  kept: [],
  assumptions: [{ subject: 'Gravity', statement: 'Gravity is stronger than it is' }],
  hypothetical: true,
  speculative: false,
  semanticKey: 'a'.repeat(64),
  status: 'preparing',
  revision: 1,
  assetId: '33333333-3333-4333-8333-333333333333',
  createdAt: new Date('2026-10-24T10:00:00Z'),
  ...(answer === undefined ? {} : { answer }),
});
const settledAt = new Date('2026-10-24T10:00:30Z');
const stored = (...texts: string[]): StoredAnswer => ({
  version: 'scenario-answer.v1',
  assumption: 'We read “stronger” as a larger pull at the surface.',
  claims: texts.map((text) => ({ text, claimIds: ['claim-a'] })),
  numbers: [],
});

describe('a stored answer on its way to the thread', () => {
  it('is served when the contract accepts it', () => {
    const answer = servableAnswerOf({
      state: 'ready',
      settledAt,
      stored: stored('Gravity would likely be stronger.', 'Tides could well swell as a result.'),
    });
    expect(answer).toMatchObject({ status: 'ready', madeBy: 'knowscroll' });
  });

  it('is not served, and does not throw, when it is a single short claim the answer limit refuses', () => {
    expect(
      servableAnswerOf({ state: 'ready', settledAt, stored: stored('Gravity would likely be stronger.') }),
    ).toBeUndefined();
  });

  it('reads as "no short answer" on the card instead of failing the thread’s whole list', () => {
    const bad = node({ state: 'ready', settledAt, stored: stored('Gravity would likely be stronger.') });
    const card = cardOf(bad, new Map());
    expect(card.answer).toEqual({ status: 'unavailable' });
    expect(card.status).toBe('preparing');
  });

  it('leaves a branch without a short answer without one, and serves the waits as they are', () => {
    expect(cardOf(node(undefined), new Map())).not.toHaveProperty('answer');
    expect(cardOf(node({ state: 'making' }), new Map()).answer).toEqual({ status: 'making' });
    expect(cardOf(node({ state: 'unavailable', settledAt }), new Map()).answer).toEqual({ status: 'unavailable' });
  });
});
