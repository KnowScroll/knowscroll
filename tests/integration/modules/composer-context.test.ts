import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ComposerDecision } from '@knowscroll/backend/modules/composer';
import { READ_COMPOSER_CONTEXT } from '@knowscroll/backend/modules/personal-context';
import { READ_PREPARED_ACTIVITY } from '@knowscroll/backend/modules/evidence';
import { activityProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { navigationProviders, NAVIGATION_PORTS } from '@knowscroll/backend/modules/experience/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import type { FixturePerson } from '../support/fixtures.js';
import { recordingPerson, clearRecordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { buildFromProviders } from '../support/providers.js';

describe('navigation consumes the PC snapshot (real PostgreSQL, authored CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  const fixtures: { assetId: string; revision: number; unit: string; topic: string }[] = [];
  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer_context');
    c = await scrollUseCases(database, { recording: true, composerPolicy: 'v1' });
    for (const name of ['positive', 'zero', 'missing']) {
      const src = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      src.assetId = randomUUID();
      src.publication.explanationUnitId = `ci-context-${name}-${randomUUID()}`;
      const imported = await c.importScroll(src);
      if (imported.kind !== 'imported') throw new Error(`CI authored fixture refused: ${imported.reason}`);
      const topic = `ci.context.${name}.${randomUUID()}`;
      await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', imported.assetId).execute();
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: imported.assetId,
          asset_revision: imported.revision,
          topic_id: topic,
          role: 'primary',
          weight: 1,
        })
        .execute();
      fixtures.push({
        assetId: imported.assetId,
        revision: imported.revision,
        unit: src.publication.explanationUnitId,
        topic,
      });
    }
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  const query = () => ({
    evaluatedAt: new Date().toISOString(),
    topicIds: fixtures.map((f) => f.topic),
    candidates: fixtures.map((f) => ({ explanationUnitId: f.unit, facets: [] })),
    candidateAssetIds: fixtures.map((f) => f.assetId),
  });
  const discovery = () => ({
    commandId: randomUUID(),
    target: { kind: 'discover' as const },
    capabilities: textCapabilities,
  });
  async function seedActualContext(p: FixturePerson) {
    const positive = fixtures[0]!,
      zero = fixtures[1]!;
    const reading = await openActive(c, p, positive);
    await activatedAgo(database.db, reading.exposureId, 30);
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', positive.assetId)
      .where('revision', '=', positive.revision)
      .executeTakeFirstOrThrow();
    const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event(reading, coverage(blocks, 4000)), event(reading, dwell([0, 68000]))],
    });
    const payload = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, exposureId: reading.exposureId };
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    const unmeasured = await openActive(c, p, zero);
    const unknownPayload = { ...payload, exposureId: unmeasured.exposureId };
    expect(await c.projectActivity(unknownPayload)).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
    await c.ingestObservations(p.authority, { instrumentationVersion: 1, events: [event(unmeasured, dwell([0, 1]))] });
    expect(await c.projectScrollReading(unknownPayload)).toMatchObject({ kind: 'applied', qualification: 'unknown' });
    expect(await c.projectActivity(unknownPayload)).toMatchObject({
      kind: 'applied',
    });
  }
  async function scopeRevision(p: FixturePerson) {
    return (
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow()
    ).revision;
  }
  it('persists actual normal-navigation PC policy/watermarks, qualified activity and available-zero versus missing-neutral scoring', async () => {
    const p = await recordingPerson(database);
    await seedActualContext(p);
    const state = await database.db
      .selectFrom('personal_context.state')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const scope = await scopeRevision(p),
      command = discovery();
    const result = await c.navigate(p.authority, command);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted' || result.outcome.status !== 'ready')
      throw new Error('CI navigation expected ready');
    const row = await database.db
      .selectFrom('composer.decisions')
      .select('payload')
      .where('universe_id', '=', p.universeId)
      .where('command_id', '=', command.commandId)
      .executeTakeFirstOrThrow();
    const decision = row.payload as unknown as ComposerDecision,
      input = decision.input.evidence;
    if (!input) throw new Error('PC input missing from durable Composer decision');
    const watermark = `personal-context-composer.v0:${state.revision}:${scope}:${state.projected_scope_revision}:not_asserted`;
    expect(input).toMatchObject({
      universeId: p.universeId,
      privacyEpoch: 1,
      evaluatedAt: decision.evaluatedAt,
      policyVersion: 'personal-context.v0',
      watermark,
    });
    expect(decision.input.watermarks.context).toBe(watermark);
    expect(input.established?.watermark).toBe(watermark);
    expect(input.topics.map((t) => t.topicId).sort()).toEqual(
      fixtures
        .slice(0, 2)
        .map((f) => f.topic)
        .sort(),
    );
    const positive = input.topics.find((t) => t.topicId === fixtures[0]!.topic)!;
    expect(positive.activity).toBeGreaterThan(0);
    expect(positive.formats.find((f) => f.kind === 'scroll')).toEqual({ kind: 'scroll', measured: 1, qualified: 1 });
    // The reading was of a plain Scroll, so it is one qualified encounter in the plain cell as well (D-192). Under policy v1
    // the Format of a plain candidate is that cell shrunk toward the person's other levels, of which there are none
    // (even odds): (1 + 4 * 1/2) / (1 + 4).
    expect(positive.cells).toEqual([{ kind: 'scroll', level: 'plain', measured: 1, qualified: 1 }]);
    expect(decision.policyVersion).toBe('composer-policy.v1');
    expect(decision.evaluations.find((e) => e.assetId === fixtures[0]!.assetId)?.features.format).toBeCloseTo(0.6, 12);
    expect(decision.evaluations.find((e) => e.assetId === fixtures[0]!.assetId)?.features.interest).toBeCloseTo(
      positive.activity / (1 + positive.activity),
      12,
    );
    expect(input.topics.find((t) => t.topicId === fixtures[1]!.topic)?.activity).toBe(0);
    expect(decision.evaluations.find((e) => e.assetId === fixtures[1]!.assetId)?.features).toMatchObject({
      interest: 0,
      format: 0.5,
    });
    expect(decision.evaluations.find((e) => e.assetId === fixtures[2]!.assetId)?.features).toMatchObject({
      interest: 0.5,
      format: 0.5,
    });
    expect(input).not.toHaveProperty('provisional');
    expect(input).not.toHaveProperty('qualified');
    expect(input.recent).toHaveLength(2);
    expect(input.established?.units).toHaveLength(3);
  });
  it('prepares under the existing scope without changing revisions and rejects an old epoch before preparing or committing a decision', async () => {
    const p = await recordingPerson(database);
    await seedActualContext(p);
    const before = await scopeRevision(p);
    const state = await database.db
      .selectFrom('personal_context.state')
      .select('revision')
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const prepared = await withScope(p.authority, (s) => c.readComposerContext(s, query()));
    expect(prepared).toMatchObject({ kind: 'entered', value: { policyVersion: 'personal-context.v0' } });
    expect(await scopeRevision(p)).toBe(before);
    expect(
      await database.db
        .selectFrom('personal_context.state')
        .select('revision')
        .where('universe_id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(state);
    expect(
      await database.db.selectFrom('composer.decisions').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    await clearRecordingPerson(database, c.boss, p);
    let entered = false;
    expect(
      await withScope(p.authority, (s) => {
        entered = true;
        return c.readComposerContext(s, query());
      }),
    ).toMatchObject({ kind: 'refused', refusal: { kind: 'epoch_changed' } });
    expect(entered).toBe(false);
    expect(await c.navigate(p.authority, discovery())).toMatchObject({
      kind: 'refused',
      code: 'PRIVACY_EPOCH_CHANGED',
    });
    expect(
      await database.db.selectFrom('composer.decisions').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
  });
  it('requires the PC binding even when a legacy Evidence reader exists, and omits legacy preparation from default shipped providers', () => {
    const t = { withPersonalScope: Symbol('fixture.scope'), enqueueJob: Symbol('fixture.enqueue') };
    expect(activityProviders(t).some((p) => p.provide === READ_PREPARED_ACTIVITY)).toBe(false);
    expect(
      activityProviders({ ...t, legacyPreparedRead: true }).some((p) => p.provide === READ_PREPARED_ACTIVITY),
    ).toBe(true);
    const providers = navigationProviders(t),
      port = providers.find((p) => p.provide === NAVIGATION_PORTS);
    if (!port) throw new Error('navigation ports missing');
    const values = new Map<symbol, unknown>(port.inject.map((token) => [token, () => undefined]));
    values.delete(READ_COMPOSER_CONTEXT);
    values.set(READ_PREPARED_ACTIVITY, () => undefined);
    expect(() => buildFromProviders(providers, NAVIGATION_PORTS, values)).toThrow(
      'No value for Symbol(personal-context.readComposerContext)',
    );
  });
});
