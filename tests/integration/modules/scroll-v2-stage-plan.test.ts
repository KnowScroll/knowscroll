import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { recapMonths, validateDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';

/**
 * Seasons Part 1 asks for orbit views at two months, the figures a cited passage states and a reveal on the first call (D-381 to D-383).
 * The model is a labelled CI fixture and the Scroll is the authored Orrin fixture over an invented planet: no provider, no product
 * content, and the page the figures come from is an invented one (it states Orrin's distances, not Earth's).
 */
const NEAR_FAR =
  'Orrin at its closest to Vael is 41 million kilometres from the star, and at its farthest it is 43 million kilometres away.';
const page = extractResearch(
  `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, NEAR_FAR].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
  TOPICS.seasons.pages[0] ?? '',
  '2026-10-20T00:00:00.000Z',
);

type Draft = { items: Record<string, unknown>[] };
const NEAREST = { slot: 'nearest', value: '41', magnitude: 'million', unit: 'kilometres' };
const FARTHEST = { slot: 'farthest', value: '43', magnitude: 'million', unit: 'kilometres' };
const UNSTATED = { slot: 'june-daylight', value: '14', unit: 'hours', place: 'Pell' };

/** The Orrin answer with an edit; the passage that states the distances is the ninth the writer is offered. */
function answered(edit: (draft: Draft) => void): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as Draft;
  edit(draft);
  return draft as unknown as AuthoredScrollV2;
}

/** The stop right after the first call, which turns the picture to the orbit in the recorded answer. */
const withFigures =
  (...figures: object[]) =>
  (draft: Draft) => {
    draft.items[2] = { ...draft.items[2], cites: ['e4', 'e9'], figures };
  };

describe('Seasons Part 1 and its stage plan (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  // A job is one per recipe, production version and take, so each test has a database of its own.
  beforeEach(async () => {
    database = await createTestDatabase<Database>('scroll_v2_stage_plan');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const revisionOf = (result: { readonly outcome: string; readonly revision?: number }): number => {
    if (result.outcome !== 'published' || result.revision === undefined)
      throw new Error('CI expected a published Scroll');
    return result.revision;
  };

  const storedDocument = async (assetId: string, revision: number): Promise<ScrollDocumentV2> => {
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', assetId)
      .where('revision', '=', revision)
      .executeTakeFirstOrThrow();
    const checked = validateDocumentV2(row.document);
    if (checked.kind !== 'valid') throw new Error('CI expected the stored document to be valid');
    return checked.document;
  };

  it('carries the plan, and publishes a Scroll that stands on the orbit at two months, turns the picture after the first call and shows only the figure a passage states', async () => {
    expect(TOPICS.seasons.scrollV2?.stagePlan).toEqual({
      orbitMonths: 2,
      figures: ['nearest', 'farthest', 'june-daylight', 'december-daylight'],
      reveal: true,
    });
    const production = fixtureProduction(
      database.db,
      () => answerWith(answered(withFigures(NEAREST, FARTHEST, UNSTATED))),
      () => page,
    );
    const result = await production.produce('seasons', false, signal());
    // One writer request and no repair: a figure no passage states is left out by code, it is not a reason to ask again.
    expect(result).toMatchObject({ outcome: 'published', held: true, assetId: TOPICS.seasons.assetId });
    expect(production.calls).toHaveLength(1);
    const request = production.calls[0]?.request;
    expect(request?.system).toContain('THE PICTURE GOES ROUND THE ORBIT');
    expect(request?.system).toContain('THE FIRST CALL TURNS THE PICTURE');

    const document = await storedDocument(TOPICS.seasons.assetId, revisionOf(result));
    const stage = document.stage;
    if (stage?.kit !== 'earth-sky.v1') throw new Error('CI expected an Earth & sky stage');
    const states = stage.states;
    expect(recapMonths(states.map((entry) => entry.state))).toHaveLength(2);
    const call = document.stops.find((stop) => stop.kind === 'call_it');
    expect(call).toMatchObject({ kind: 'call_it', revealStage: 's3' });
    const turnedTo = states.find((entry) => entry.stop === 's3');
    expect(turnedTo?.state).toMatchObject({
      view: 'orbit',
      figures: [
        { slot: 'nearest', value: 41_000_000, unit: 'kilometres' },
        { slot: 'farthest', value: 43_000_000, unit: 'kilometres' },
      ],
    });
    expect(turnedTo?.alt).toContain('At its nearest, Earth is 41,000,000 kilometres from the Sun.');
    // The daylight figure the page never states is nowhere in what a reader gets.
    expect(JSON.stringify(document)).not.toMatch(/daylight|Pell/u);

    const stored = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', TOPICS.seasons.assetId)
      .where('revision', '=', revisionOf(result))
      .executeTakeFirstOrThrow();
    const provenance = ScrollProvenanceV2.parse(stored.provenance);
    expect(provenance.checks.find((check) => check.name === 'stage-figures')).toMatchObject({
      reasonCodes: ['stage_figure_left_out'],
    });
  });

  it('asks the one repair, with fixed findings, of an answer that ignores the plan, and publishes the repaired answer', async () => {
    const ignoring = answered((draft) => {
      // One orbit month only, and no reveal on the first call.
      draft.items[3] = { ...draft.items[3], stage: { earthAt: 'jan', focus: 'axis' } };
      const { revealsNext: _removed, ...call } = draft.items[1] as Record<string, unknown>;
      draft.items[1] = call;
    });
    const production = fixtureProduction(
      database.db,
      (sequence) => answerWith(sequence === 1 ? ignoring : answered(() => undefined)),
      () => page,
    );
    const result = await production.produce('seasons', false, signal());
    expect(result).toMatchObject({ outcome: 'published', held: true });
    expect(production.calls).toHaveLength(2);
    const repair = production.calls[1]?.request;
    expect(repair?.system).toContain('stage_months_too_few');
    expect(repair?.system).toContain('call_reveal_missing');
    expect(repair?.system).toContain('two different months at least');
    expect(repair?.system).toContain('"revealsNext" to true');
  });

  it('leaves every other Seasons recipe as it was: no stage plan, so no orbit months, figures or reveal asked', () => {
    for (const key of ['seasons-hemispheres', 'seasons-limits', 'seasons-elsewhere'] as const)
      expect(TOPICS[key].scrollV2).not.toHaveProperty('stagePlan');
  });
});
