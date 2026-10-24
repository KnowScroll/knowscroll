import { describe, expect, it } from 'vitest';
import type { JourneyEvent, RelatedKeys } from '../domain/journey.js';
import type { JourneyStore } from './ports.js';
import { MAX_JOURNEY_STEPS, makeReadJourney } from './read-journey.js';

const base = Date.UTC(2026, 9, 24, 10, 0, 0);
function event(overrides: Partial<JourneyEvent> & Pick<JourneyEvent, 'stage'>): JourneyEvent {
  return {
    startedAt: new Date(base),
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

/** A store over fixture steps that answers like the view and records what it was asked. */
function fixtureStore(all: readonly JourneyEvent[]) {
  const asked: { keys: RelatedKeys; universeIds: readonly string[] }[] = [];
  const store: JourneyStore = {
    findById: (id, limit, includeUniverse) =>
      Promise.resolve(
        all
          .filter(
            (step) =>
              step.requestId === id || step.productionRunId === id || (includeUniverse && step.universeId === id),
          )
          .slice(0, limit),
      ),
    findRelated: (keys, universeIds, limit) => {
      asked.push({ keys, universeIds });
      return Promise.resolve(
        all
          .filter((step) => step.universeId === null || universeIds.includes(step.universeId))
          .filter(
            (step) =>
              (step.workId !== null && keys.workId.includes(step.workId)) ||
              (step.productionRunId !== null && keys.productionRunId.includes(step.productionRunId)) ||
              (step.reasoningRunId !== null && keys.reasoningRunId.includes(step.reasoningRunId)) ||
              (step.stage === 'content.production_run' &&
                step.recipeKey !== null &&
                keys.recipeKeys.includes(step.recipeKey)),
          )
          .slice(0, limit),
      );
    },
  };
  return { store, asked };
}

const now = () => new Date(base + 3_600_000);

describe('reading a journey', () => {
  const request = event({
    stage: 'supply.request',
    requestId: 'r1',
    workId: 'w1',
    universeId: 'u1',
    subjectId: 'r1',
    startedAt: new Date(base),
  });
  const group = event({
    stage: 'supply.group',
    workId: 'w1',
    recipeKey: 'seasons',
    subjectId: 'w1',
    startedAt: new Date(base + 1000),
  });
  const run = event({
    stage: 'content.production_run',
    recipeKey: 'seasons',
    productionRunId: 'p1',
    reasoningRunId: 'wr1',
    subjectId: 'p1',
    startedAt: new Date(base + 2000),
  });
  const attempt = event({
    stage: 'reasoning.production_attempt',
    reasoningRunId: 'wr1',
    attemptId: 'a1',
    subjectId: 'a1',
    startedAt: new Date(base + 3000),
  });
  const strangerRequest = event({
    stage: 'supply.request',
    requestId: 'r2',
    workId: 'w1',
    universeId: 'u2',
    subjectId: 'r2',
  });

  it('follows a request to its group, the production run it commissioned and the model attempts', async () => {
    const { store } = fixtureStore([request, group, run, attempt, strangerRequest]);
    const outcome = await makeReadJourney({ store, now })('r1');
    if (outcome.kind !== 'found') throw new Error('expected a journey');
    expect(outcome.journey.subject).toBe('request');
    expect(outcome.journey.steps.map((step) => step.stage)).toEqual([
      'supply.request',
      'supply.group',
      'content.production_run',
      'reasoning.production_attempt',
    ]);
  });

  it('never reads another person into a journey, even through the group they share', async () => {
    const { store, asked } = fixtureStore([request, group, run, attempt, strangerRequest]);
    const outcome = await makeReadJourney({ store, now })('r1');
    if (outcome.kind !== 'found') throw new Error('expected a journey');
    expect(outcome.journey.steps.map((step) => step.ref)).not.toContain('r2');
    expect(asked.every((ask) => ask.universeIds.length === 1 && ask.universeIds[0] === 'u1')).toBe(true);
  });

  it('reads shared records only for a production run, which names no one', async () => {
    const { store, asked } = fixtureStore([request, group, run, attempt]);
    const outcome = await makeReadJourney({ store, now })('p1');
    if (outcome.kind !== 'found') throw new Error('expected a journey');
    expect(outcome.journey.subject).toBe('production_run');
    expect(outcome.journey.steps.map((step) => step.scope)).not.toContain('personal');
    expect(asked.every((ask) => ask.universeIds.length === 0)).toBe(true);
  });

  it("opens a person's whole journey only when it is asked for, which the API never does", async () => {
    const { store } = fixtureStore([request, group]);
    expect(await makeReadJourney({ store, now })('u1')).toEqual({ kind: 'not_found' });
    expect((await makeReadJourney({ store, now })('u1', { allowPerson: false })).kind).toBe('not_found');
    expect((await makeReadJourney({ store, now })('u1', { allowPerson: true })).kind).toBe('found');
  });

  it('answers not_found when nothing carries the ID', async () => {
    const { store } = fixtureStore([request]);
    expect(await makeReadJourney({ store, now })('nothing')).toEqual({ kind: 'not_found' });
  });

  it('keeps the newest steps and says so when a journey is longer than it shows', async () => {
    const many = Array.from({ length: MAX_JOURNEY_STEPS + 20 }, (_, index) =>
      event({ stage: 'receipt.command', universeId: 'u1', commandId: `c${index}`, startedAt: new Date(base + index) }),
    );
    const { store } = fixtureStore(many);
    const outcome = await makeReadJourney({ store, now })('u1', { allowPerson: true });
    if (outcome.kind !== 'found') throw new Error('expected a journey');
    expect(outcome.journey.steps).toHaveLength(MAX_JOURNEY_STEPS);
    expect(outcome.journey.truncated).toBe(true);
    expect(outcome.journey.subject).toBe('universe');
  });
});
