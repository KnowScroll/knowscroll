import type { ContentRequestStatus } from '@knowscroll/contracts';
import { canTryAgain, unavailableCopy, unavailableMessage } from './request-copy';

type Closed = Extract<ContentRequestStatus, { status: 'unavailable' }>;
const closed = (limit: Closed['limit']): Closed => ({
  version: 'content-request-status.v1',
  requestId: '0199a000-0000-7000-8000-000000000001',
  privacyEpoch: 1,
  requestRevision: 2,
  revision: 3,
  createdAt: '2026-11-03T08:00:00.000Z',
  updatedAt: '2026-11-03T08:01:00.000Z',
  status: 'unavailable',
  reason: 'budget_unavailable',
  ...(limit === undefined ? {} : { limit }),
});
const sameDay = new Date('2026-11-03T20:00:00.000Z');
const nextDay = new Date('2026-11-04T00:00:01.000Z');

describe('the words of a request closed by a daily limit (D-387)', () => {
  it('says today and tomorrow only on the UTC day the request closed', () => {
    expect(unavailableMessage(closed({ kind: 'person', perDay: 5 }), sameDay)).toMatch(
      /You've asked for 5 new explanations today.*ask again tomorrow/,
    );
    expect(unavailableMessage(closed({ kind: 'world' }), sameDay)).toMatch(/full for today.*ask again tomorrow/);
    expect(unavailableMessage(closed({ kind: 'off' }), sameDay)).toMatch(/switched off right now/);
  });

  it('tells the same cause without a time on a later day, and never names other people', () => {
    for (const limit of [{ kind: 'person', perDay: 1 }, { kind: 'world' }, { kind: 'off' }] as const) {
      const words = unavailableMessage(closed(limit), nextDay);
      expect(words).toMatch(/^This was closed because /);
      expect(words).not.toMatch(/today|tomorrow|right now|other people|everyone|anyone else/i);
      expect(words).toMatch(/Your request is closed/);
    }
    expect(unavailableMessage(closed({ kind: 'person', perDay: 1 }), nextDay)).toMatch(/1 new explanation that day/);
  });

  it('keeps the general words when no limit is named', () => {
    expect(unavailableMessage(closed(undefined), nextDay)).toMatch(/can't prepare new explanations right now/);
  });
});

describe('the words of a request that nothing can make', () => {
  const reasoned = (reason: 'no_production_path' | 'no_recipe_left'): Closed => ({ ...closed(undefined), reason });

  it('says what cannot be made, not that a budget is used up', () => {
    expect(unavailableMessage(reasoned('no_production_path'), nextDay)).toMatch(/new Reel, or another format/);
    expect(unavailableMessage(reasoned('no_recipe_left'), nextDay)).toMatch(/don't have an explanation of this ready/);
    for (const reason of ['no_production_path', 'no_recipe_left'] as const) {
      expect(unavailableCopy[reason]).not.toMatch(/budget|prepare new explanations|ask again/i);
      expect(unavailableCopy[reason]).toMatch(/Your request is closed, so nothing is waiting/);
    }
  });

  it('lets the person try again only where something may have changed', () => {
    expect(canTryAgain('could_not_prepare')).toBe(true);
    expect(canTryAgain('no_recipe_left')).toBe(true);
    for (const reason of [
      'no_production_path',
      'budget_unavailable',
      'unsupported_request',
      'no_compatible_supply',
      'not_permitted',
      'source_unavailable',
    ] as const)
      expect(canTryAgain(reason)).toBe(false);
    expect(unavailableCopy.no_recipe_left).toMatch(/try again later/);
    expect(unavailableCopy.no_production_path).not.toMatch(/try again/i);
  });
});
