import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readJourneyFor } from '@knowscroll/backend/modules/operator/nest-providers';
import type { Journey } from '@knowscroll/backend/modules/operator';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import type { FixturePerson } from '../support/fixtures.js';
import { supplyWorld, validWriterAnswer, type SupplyWorld } from '../support/supply-world.js';

/**
 * The journey inspector over real records (#248, D-044): a request that was joined to a shared
 * group, produced, published and read; a production run whose writer's answer was refused; one
 * whose outcome is unknown. Evidence label: real PostgreSQL and pg-boss through the real use cases;
 * the Scroll writer and the matcher are labelled CI fixture models, not provider output.
 */
describe('journeys across modules (real PostgreSQL, CI fixture models)', () => {
  let world: SupplyWorld;
  let asker: FixturePerson;
  let joiner: FixturePerson;
  let requestId: string;
  let joinerRequestId: string;
  let askerExposureId: string;
  let joinerExposureId: string;
  const readJourney = () => readJourneyFor(world.database.db);

  async function journeyOf(id: string): Promise<Journey> {
    const outcome = await readJourney()(id);
    if (outcome.kind !== 'found') throw new Error(`no journey for ${id}`);
    return outcome.journey;
  }
  const stages = (journey: Journey) => journey.steps.map((step) => step.stage);
  const productionRunOf = async (recipe: string) =>
    (
      await world.database.db
        .selectFrom('ops.production_runs')
        .select('production_run_id')
        .where('recipe_key', '=', recipe)
        .executeTakeFirstOrThrow()
    ).production_run_id ?? '';

  beforeAll(async () => {
    world = await supplyWorld('operator_journeys');
    asker = await world.seedPerson();
    joiner = await world.seedPerson();
    requestId = await world.ask(asker, world.catalogueRequest('earth.seasons'));
    joinerRequestId = await world.ask(joiner, world.catalogueRequest('earth.seasons'));
    await world.runProduction('seasons');
    await world.resolveRequest(asker, requestId);
    await world.resolveRequest(joiner, joinerRequestId);
    askerExposureId = await world.meet(asker, TOPICS.seasons.assetId);
    joinerExposureId = await world.meet(joiner, TOPICS.seasons.assetId);

    // A recipe whose writer's answer is refused by the validator.
    world.answerWriterWith(() => ({ kind: 'success', text: 'not a Scroll document at all' }));
    await world.ask(await world.seedPerson(), world.catalogueRequest('earth.tides', 'earth.tides.forcing'));
    await world.runProduction('tides');
    // A recipe whose provider call timed out: the outcome is unknown.
    world.answerWriterWith(() => ({ kind: 'gateway_timeout' }));
    await world.ask(await world.seedPerson(), world.catalogueRequest('earth.greenhouse-effect'));
    await world.runProduction('greenhouse');
    world.answerWriterWith(validWriterAnswer);
  }, 120_000);
  afterAll(async () => {
    await world.close();
  });

  it('follows a request through the shared group, the production run, its model attempts and the published Scroll', async () => {
    const journey = await journeyOf(requestId);
    expect(journey.subject).toBe('request');
    expect(stages(journey)).toEqual(
      expect.arrayContaining([
        'supply.request',
        'supply.group',
        'content.production_run',
        'reasoning.production_run',
        'reasoning.production_attempt',
        'content.asset_admitted',
      ]),
    );
    const times = journey.steps.map((step) => step.at.getTime());
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(journey.steps.find((step) => step.stage === 'supply.request')).toMatchObject({
      scope: 'personal',
      state: 'ready',
      ref: requestId,
    });
    expect(journey.steps.find((step) => step.stage === 'content.production_run')).toMatchObject({
      scope: 'shared',
      state: 'published',
      label: expect.any(String) as unknown,
    });
    expect(journey.gaps).toEqual([]);
  });

  it("never shows another person's request, even though both waited on the same group", async () => {
    const journey = await journeyOf(requestId);
    expect(journey.steps.map((step) => step.ref)).not.toContain(joinerRequestId);
    expect(stages(journey).filter((stage) => stage === 'supply.request')).toHaveLength(1);
  });

  it('shows a production run as shared records only, with no request or person', async () => {
    const journey = await journeyOf(await productionRunOf('seasons'));
    expect(journey.subject).toBe('production_run');
    expect(new Set(journey.steps.map((step) => step.scope))).toEqual(new Set(['shared']));
    expect(stages(journey)).toEqual(
      expect.arrayContaining(['content.production_run', 'reasoning.production_attempt', 'content.asset_admitted']),
    );
    expect(stages(journey)).not.toContain('supply.request');
  });

  it('answers an asset ID with its shared steps only, never what people did with it', async () => {
    const journey = await journeyOf(TOPICS.seasons.assetId);
    expect(journey.subject).toBe('asset');
    expect(stages(journey)).toContain('content.asset_admitted');
    expect(stages(journey).filter((stage) => stage.startsWith('experience.'))).toEqual([]);
    expect(new Set(journey.steps.map((step) => step.scope))).toEqual(new Set(['shared']));
  });

  it("follows an exposure to the content's production and shows no other person's exposure", async () => {
    const journey = await journeyOf(askerExposureId);
    expect(journey.subject).toBe('exposure');
    expect(stages(journey)).toEqual(
      expect.arrayContaining(['experience.exposure_opened', 'experience.exposure_activated', 'content.asset_admitted']),
    );
    expect(journey.steps.map((step) => step.ref)).not.toContain(joinerExposureId);
  });

  it("gives a person's whole journey from their universe, and nobody else's", async () => {
    const journey = await journeyOf(asker.universeId);
    expect(journey.subject).toBe('universe');
    expect(stages(journey)).toEqual(expect.arrayContaining(['supply.request', 'experience.exposure_opened']));
    const refs = journey.steps.map((step) => step.ref);
    expect(refs).not.toContain(joinerRequestId);
    expect(refs).not.toContain(joinerExposureId);
  });

  it('names a model attempt and its reasoning run as such', async () => {
    const attempt = await world.database.db
      .selectFrom('ops.model_attempts')
      .select(['attempt_id', 'run_id'])
      .where('scope_kind', '=', 'production')
      .executeTakeFirstOrThrow();
    expect((await journeyOf(attempt.attempt_id ?? '')).subject).toBe('attempt');
    expect((await journeyOf(attempt.run_id ?? '')).subject).toBe('run');
  });

  it('shows a refused writer answer as a step with its verdict and the count of findings, never the answer', async () => {
    const journey = await journeyOf(await productionRunOf('tides'));
    const refused = journey.steps.find((step) => step.stage === 'reasoning.refused_answer');
    expect(refused).toBeDefined();
    expect(refused?.code).toEqual(expect.any(String));
    expect(JSON.stringify(journey)).not.toContain('not a Scroll document');
    expect(journey.steps.find((step) => step.stage === 'content.production_run')).toMatchObject({ state: 'rejected' });
  });

  it('shows an unknown outcome as a gap that is never sent again', async () => {
    const journey = await journeyOf(await productionRunOf('greenhouse'));
    expect(journey.gaps.map((gap) => gap.note).join(' ')).toMatch(/Outcome unknown/);
  });

  it('answers not_found for an ID no record carries', async () => {
    expect(await readJourney()(randomUUID())).toEqual({ kind: 'not_found' });
  });

  it('leaves what it read untouched: the journey is a read', async () => {
    const before = await sql<{ n: string }>`select count(*)::text as n from receipts.personal_commands`.execute(
      world.database.db,
    );
    await journeyOf(asker.universeId);
    const after = await sql<{ n: string }>`select count(*)::text as n from receipts.personal_commands`.execute(
      world.database.db,
    );
    expect(after.rows).toEqual(before.rows);
  });
});
