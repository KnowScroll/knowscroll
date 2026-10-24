import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReasoningSettings } from '@knowscroll/backend/infrastructure/config';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { produceScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import {
  guardedModelPort,
  harnessSettings,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureAuthored, fixtureResearchFor } from '../support/generated-scroll.js';
import {
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  signal,
  silent,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';

const cap = (requestsPerDay: number) => ({ requestsPerDay, tokensPerDay: 1_000_000_000 });
/** One request a day for a person, two for the production scope, and the global and role caps out of the way. */
const reasoning: ReasoningSettings = {
  provider: 'none',
  productionEnabled: true,
  caps: { global: cap(10_000), scope: cap(1), productionScope: cap(2), roleDefault: cap(10_000) },
  backgroundSharePercent: 100,
  maxRequestBytes: 262_144,
  requestRetentionSeconds: 3_600,
};

/** CI fixture model and real PostgreSQL: which cap bounds which scope. */
describe('the production scope has its own daily cap (D-037)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('production_caps');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  it('bounds a production run by the production cap, not the per-person cap, and pauses it instead of rejecting it', async () => {
    const fixture = fixtureModel(() => ({ kind: 'success', text: JSON.stringify(fixtureAuthored('diagram')) }), {
      label: 'production-caps-CI-fixture',
    });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const produce = produceScrollUseCase({
      db: database.db,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope,
      harness: makeProductionReasoningHarness(
        postgresProductionHarnessPorts({
          db: database.db,
          withProductionScope: withScope,
          enabled: true,
          model,
          logEvent: silent,
          settings: productionHarnessSettings(reasoning, 'ci'),
        }),
      ),
      model: model.model,
      research: (url) => Promise.resolve(fixtureResearchFor(url)),
    });
    // The person cap is one request; the production scope gets through two writers.
    expect(await produce('seasons', false, signal())).toMatchObject({ outcome: 'published' });
    expect(await produce('tides', false, signal())).toMatchObject({ outcome: 'published' });
    const third = await produce('greenhouse-radiation', false, signal());
    expect(third).toMatchObject({ outcome: 'paused', codes: ['budget_scope_requests'] });
    expect(fixture.calls).toHaveLength(2);
    // Paused is not a verdict: the job is open at the writer stage, and a send on a later day resumes it.
    expect(
      await database.db
        .selectFrom('content.scroll_production_runs')
        .select('state')
        .where('topic', '=', 'greenhouse-radiation')
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'writer' });
  });

  it('keeps the per-person cap for personal scopes, whatever production has spent', async () => {
    const model = fixtureModel();
    const { harness } = fixtureHarness(database.db, { model, settings: harnessSettings(reasoning, 'ci') });
    const person = await seedPerson(database.db);
    const other = await seedPerson(database.db);
    const propose = (universeId: string) =>
      harness.propose(
        { run: fixtureRun(systemAuthority(universeId), randomUUID()), role: echoRole, context: fixtureContext },
        signal(),
      );
    // Production already used two requests today, more than the person cap, and a person still gets theirs.
    expect(await propose(person.universeId)).toMatchObject({ kind: 'proposed' });
    expect(await propose(person.universeId)).toMatchObject({
      kind: 'budget_exhausted',
      dimension: 'scope',
      limit: 'requests',
    });
    expect(await propose(other.universeId)).toMatchObject({ kind: 'proposed' });
  });
});
