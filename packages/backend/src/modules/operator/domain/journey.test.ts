import { describe, expect, it } from 'vitest';
import {
  NO_KEYS,
  buildJourney,
  gapsOf,
  isEmptyKeys,
  subjectOf,
  titleOf,
  universesOf,
  unsearchedKeys,
  withKeys,
  withoutRunsBeforeTheirGroup,
  type JourneyEvent,
  type JourneyStep,
} from './journey.js';

const minute = 60_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 24, 10, 0, 0) + minutes * minute);

/** A fixture step; every key not named is absent. */
function event(overrides: Partial<JourneyEvent> & Pick<JourneyEvent, 'stage'>): JourneyEvent {
  return {
    startedAt: at(0),
    endedAt: null,
    state: null,
    code: null,
    label: null,
    count: null,
    universeId: null,
    requestId: null,
    workId: null,
    recipeKey: null,
    productionRunId: null,
    reasoningRunId: null,
    attemptId: null,
    exposureId: null,
    offerId: null,
    decisionId: null,
    assetId: null,
    reelOrderId: null,
    commandId: null,
    subjectId: null,
    ...overrides,
  };
}

describe('what an ID is', () => {
  it('is named by the key it matched, a request before the run that shares its ID', () => {
    const request = event({ stage: 'supply.request', requestId: 'r1', reasoningRunId: 'r1', universeId: 'u1' });
    expect(subjectOf('r1', [request])).toBe('request');
    expect(subjectOf('u1', [request])).toBe('universe');
    expect(subjectOf('nobody', [request])).toBeUndefined();
  });
});

describe('following keys', () => {
  const group = event({ stage: 'supply.group', workId: 'w1', recipeKey: 'seasons', startedAt: at(0) });
  const request = event({ stage: 'supply.request', requestId: 'r1', workId: 'w1', universeId: 'u1' });

  it('finds the keys of what was found, once, and names the recipes of groups only', () => {
    const first = unsearchedKeys([request, group], NO_KEYS);
    expect(first.workId).toEqual(['w1']);
    expect(first.recipeKeys).toEqual(['seasons']);
    const searched = withKeys(NO_KEYS, first);
    expect(isEmptyKeys(unsearchedKeys([request, group], searched))).toBe(true);
    expect(isEmptyKeys(first)).toBe(false);
    expect(isEmptyKeys(NO_KEYS)).toBe(true);
  });

  it('lists the universes a journey may read into, once each', () => {
    expect(universesOf([request, group, event({ stage: 'x', universeId: 'u1' })])).toEqual(['u1']);
  });

  it('drops a production run that began before the shared group of its recipe', () => {
    const early = event({
      stage: 'content.production_run',
      recipeKey: 'seasons',
      startedAt: at(-5),
      subjectId: 'early',
    });
    const later = event({
      stage: 'content.production_run',
      recipeKey: 'seasons',
      startedAt: at(5),
      subjectId: 'later',
    });
    const other = event({ stage: 'content.production_run', recipeKey: 'tides', startedAt: at(-5), subjectId: 'other' });
    expect(withoutRunsBeforeTheirGroup([group, early, later, other]).map((step) => step.subjectId)).toEqual([
      null,
      'later',
      'other',
    ]);
  });
});

describe('the timeline', () => {
  it('orders steps oldest first, shows a record once and marks whose record it is', () => {
    const second = event({ stage: 'supply.group', startedAt: at(1), subjectId: 'g' });
    const first = event({ stage: 'supply.request', startedAt: at(0), universeId: 'u1', subjectId: 'r' });
    const journey = buildJourney('request', 'r', [second, first, { ...first }], { now: at(2), truncated: false });
    expect(journey.steps.map((step) => [step.stage, step.scope, step.title])).toEqual([
      ['supply.request', 'personal', 'Request'],
      ['supply.group', 'shared', 'Shared group'],
    ]);
  });

  it('keeps the name of a stage it has no title for', () => {
    expect(titleOf('experience.offer')).toBe('Offered');
    expect(titleOf('something.new')).toBe('something.new');
  });
});

describe('gaps', () => {
  const step = (overrides: Partial<JourneyStep>): JourneyStep => ({
    at: at(0),
    endedAt: null,
    stage: 'reasoning.production_attempt',
    title: 'Model attempt (production)',
    state: 'dispatched',
    code: null,
    label: null,
    count: null,
    ref: 'a1',
    scope: 'shared',
    ...overrides,
  });

  it('reports an unknown outcome as never to be sent again', () => {
    const [gap] = gapsOf([step({ state: 'unknown' })], at(1));
    expect(gap?.note).toMatch(/never sent again/);
  });

  it('reports an unfinished step only once it is old enough to doubt', () => {
    expect(gapsOf([step({})], at(10))).toEqual([]);
    expect(gapsOf([step({})], at(45))).toEqual([
      { stage: 'reasoning.production_attempt', ref: 'a1', note: 'Started, and no completion has been recorded.' },
    ]);
  });

  it('does not call a finished step or a shared group in its normal state a gap', () => {
    expect(gapsOf([step({ endedAt: at(1), state: 'succeeded' })], at(90))).toEqual([]);
    expect(gapsOf([step({ stage: 'supply.group', state: 'active' })], at(90))).toEqual([]);
  });
});
