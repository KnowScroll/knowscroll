import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { activityContextEffect } from '@knowscroll/backend/modules/personal-context/nest-providers';
import type { PersonalAuthority } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { coverage, dwell, event, openActive } from '../support/observations.js';

describe('incremental personal context (real PostgreSQL, authored CI fixtures only)', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  let first: { assetId: string; revision: number }, twin: typeof first, blocks: string[];
  const unit = `ci-context-unit-${randomUUID()}`,
    topicA = `ci.context.a.${randomUUID()}`,
    topicB = `ci.context.b.${randomUUID()}`;
  const evaluation = new Date(Date.now() + 3600000);
  const encounterTime = new Date(evaluation.getTime() - 90 * 60000);
  beforeAll(async () => {
    database = await createTestDatabase<Database>('personal_context');
    c = await scrollUseCases(database, { activityNow: () => evaluation });
    async function asset() {
      const src = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      src.assetId = randomUUID();
      src.publication.explanationUnitId = unit;
      const r = await c.importScroll(src);
      if (r.kind !== 'imported')
        throw new Error(`authored CI fixture refused: ${r.reason}/${r.issues.map((i) => i.path).join(',')}`);
      await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', r.assetId).execute();
      await database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: r.assetId, asset_revision: r.revision, topic_id: topicA, role: 'primary', weight: 1 })
        .execute();
      return { assetId: r.assetId, revision: r.revision };
    }
    first = await asset();
    twin = await asset();
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', first.assetId)
      .executeTakeFirstOrThrow();
    blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  const job = (p: FixturePerson, exposureId: string) => ({
    v: 1 as const,
    universeId: p.universeId,
    privacyEpoch: 1,
    exposureId,
  });
  async function snapshot(p: FixturePerson) {
    const r = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readExploration(s, {
        evaluatedAt: evaluation.toISOString(),
        topicIds: [topicA, topicB],
        candidates: [{ explanationUnitId: unit, facets: ['fixture-metadata-tag'] }],
      }),
    );
    if (r.kind !== 'entered') throw new Error('CI fixture scope refused');
    return r.value;
  }
  async function read(p: FixturePerson, asset = first) {
    const exposure = await openActive(c, p, asset);
    // Exact same activation time makes this correction fixture's twins carry identical decay
    // weights. Keep exact reversible assertions without changing Evidence's floating arithmetic.
    await database.db
      .updateTable('experience.exposures')
      .set({ opened_at: new Date(encounterTime.getTime() - 60000), activated_at: encounterTime })
      .where('id', '=', exposure.exposureId)
      .execute();
    await c.projectActivity(job(p, exposure.exposureId));
    const events = [event(exposure, coverage(blocks, 4000)), event(exposure, dwell([0, 68000]))];
    await c.ingestObservations(p.authority, { instrumentationVersion: 1, events });
    return { exposure, events };
  }
  async function qualify(p: FixturePerson, exposureId: string) {
    expect(await c.projectScrollReading(job(p, exposureId))).toMatchObject({
      kind: 'applied',
      qualification: 'qualified',
    });
    expect(await c.projectActivity(job(p, exposureId))).toMatchObject({ kind: 'applied' });
  }
  it('keeps pending observations separate, then incrementally consumes real qualification without metadata facet invention', async () => {
    const p = await seedPerson(database.db),
      r = await read(p);
    const pending = await snapshot(p);
    expect(pending.provisional).toMatchObject({ purpose: 'routing_only', hasMore: false });
    expect(pending.provisional.entries.map((e) => e.eventId).sort()).toEqual(r.events.map((e) => e.eventId).sort());
    expect(pending.topics[0]).toMatchObject({ qualifiedExplanationUnits: 0, coveredFacets: 0 });
    await qualify(p, r.exposure.exposureId);
    const s = await snapshot(p);
    expect(s).toMatchObject({
      version: 'exploration-snapshot.v0',
      coverageAvailability: 'unavailable',
      completeness: 'not_asserted',
      provisional: { entries: [] },
    });
    expect(s.topics[0]).toMatchObject({
      qualifiedExplanationUnits: 1,
      coveredFacets: 0,
      formats: [
        { kind: 'reel', measured: 0, qualified: 0, fit: 0.5 },
        { kind: 'scroll', measured: 1, qualified: 1, fit: 2 / 3 },
      ],
    });
    expect(s.topics[0]?.interest).toBeCloseTo((s.topics[0]?.activity ?? 0) / (1 + (s.topics[0]?.activity ?? 0)));
    expect(s.qualified[0]).toMatchObject({
      topicIds: [topicA],
      facets: [{ facetId: 'fixture-metadata-tag', topicIds: [] }],
    });
    expect(s.supportingEvidence[0]).toMatchObject({
      exposureId: r.exposure.exposureId,
      qualified: true,
      coveredFacets: [],
      input: { qualificationRevision: 1, projectionPolicy: 'personal-context.v0' },
    });
    const before = s.revision;
    expect(await c.projectActivity(job(p, r.exposure.exposureId))).toMatchObject({
      kind: 'skipped',
      reason: 'already_applied',
    });
    expect((await snapshot(p)).revision).toBe(before);
  });
  it('counts two actual encounters of one unit once; reversible topic corrections preserve source Q/O and activity at the same evaluation time', async () => {
    const p = await seedPerson(database.db),
      a = await read(p),
      b = await read(p, twin);
    await qualify(p, a.exposure.exposureId);
    await qualify(p, b.exposure.exposureId);
    const original = await snapshot(p);
    expect(original.topics[0]).toMatchObject({
      qualifiedExplanationUnits: 1,
      formats: [{ measured: 0 }, { measured: 2, qualified: 2 }],
    });
    for (const asset of [first, twin])
      await database.db
        .updateTable('content.encounter_topics')
        .set({ topic_id: topicB })
        .where('asset_id', '=', asset.assetId)
        .execute();
    await c.projectActivity(job(p, a.exposure.exposureId));
    await c.projectActivity(job(p, b.exposure.exposureId));
    const corrected = await snapshot(p);
    expect(corrected.topics[0]).toMatchObject({ qualifiedExplanationUnits: 0, activity: 0 });
    expect(corrected.topics[1]).toMatchObject({
      qualifiedExplanationUnits: 1,
      formats: [{ measured: 0 }, { measured: 2, qualified: 2 }],
    });
    for (const asset of [first, twin])
      await database.db
        .updateTable('content.encounter_topics')
        .set({ topic_id: topicA })
        .where('asset_id', '=', asset.assetId)
        .execute();
    await c.projectActivity(job(p, a.exposure.exposureId));
    await c.projectActivity(job(p, b.exposure.exposureId));
    const restored = await snapshot(p);
    expect(restored.topics[0]).toEqual(original.topics[0]);
    expect(restored.topics[1]).toMatchObject({ qualifiedExplanationUnits: 0, activity: 0 });
    expect(restored.revision).toBeGreaterThan(corrected.revision);
  });
  it('rolls Evidence, derived support and revision back together when the required context effect fails', async () => {
    const p = await seedPerson(database.db),
      exposure = await openActive(c, p, first);
    const failing = await scrollUseCases(database, {
      activityNow: () => evaluation,
      activityDerived: {
        isCurrent: activityContextEffect.isCurrent,
        apply: async (s, x) => {
          await activityContextEffect.apply(s, x);
          throw new Error('CI_FIXTURE_CONTEXT_FAILURE');
        },
      },
    });
    try {
      await expect(failing.projectActivity(job(p, exposure.exposureId))).rejects.toThrow('CI_FIXTURE_CONTEXT_FAILURE');
    } finally {
      await failing.close();
    }
    expect(
      await database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('personal_context.contributions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect((await snapshot(p)).revision).toBe(0);
  });
  it('bounds recent-topic discovery by indexed projection recency and stable topic tie, independently of stored activity', async () => {
    const p = await seedPerson(database.db);
    // Explicit prepared-row fixtures for selection policy, not an encounter or runtime claim.
    await database.db
      .insertInto('evidence.topic_context')
      .values(
        Array.from({ length: 102 }, (_, i) => ({
          universe_id: p.universeId,
          privacy_epoch: 1,
          topic_id: `ci.selection.${String(i).padStart(3, '0')}`,
          channel_values: { q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 },
          activity: i === 101 ? 999 : 1,
          evaluated_at: new Date(evaluation.getTime() - (i === 101 ? 1000 : 0)),
        })),
      )
      .execute();
    const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readRecentTopics(s, { limit: 100 }),
    );
    expect(result).toMatchObject({
      kind: 'entered',
      value: { policyVersion: 'recent_projected_topics.v0', hasMore: true },
    });
    if (result.kind !== 'entered') throw new Error('fixture scope refused');
    expect(result.value.topicIds).toHaveLength(100);
    expect(result.value.topicIds[0]).toBe('ci.selection.000');
    expect(result.value.topicIds).not.toContain('ci.selection.101');
  });
  it('reconciles context missing from a previously projected exposure and erases every epoch while stale work stays fenced', async () => {
    const p = await seedPerson(database.db),
      r = await read(p);
    await qualify(p, r.exposure.exposureId);
    // Explicit rollout fixture: remove only PC's state as an old release would lack it.
    const pc = personalStores.find((m) => m.module === 'personal-context');
    if (!pc) throw new Error('context eraser missing');
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) => pc.erase(s));
    const reconciled = await c.reconcileActivity(p.authority, { limit: 100 });
    expect(reconciled.kind).toBe('entered');
    if (reconciled.kind !== 'entered') throw new Error('fixture scope refused');
    expect(reconciled.value.queued + reconciled.value.pending).toBe(1);
    const activityRows = await database.db
      .selectFrom('evidence.activity_revisions')
      .select('id')
      .where('universe_id', '=', p.universeId)
      .orderBy('revision')
      .execute();
    const current = await database.db
      .selectFrom('evidence.activity_current')
      .select('activity_id')
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', r.exposure.exposureId)
      .executeTakeFirstOrThrow();
    expect(await c.projectActivity(job(p, r.exposure.exposureId))).toMatchObject({
      kind: 'applied',
      activityId: current.activity_id,
    });
    expect(
      await database.db
        .selectFrom('evidence.activity_revisions')
        .select('id')
        .where('universe_id', '=', p.universeId)
        .orderBy('revision')
        .execute(),
    ).toEqual(activityRows);
    expect((await snapshot(p)).topics[0]?.qualifiedExplanationUnits).toBe(1);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    expect(await c.projectActivity(job(p, r.exposure.exposureId))).toMatchObject({
      kind: 'skipped',
      reason: 'epoch_changed',
    });
    const authority: PersonalAuthority = { ...p.authority, privacyEpoch: 2 };
    const erased = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(authority, (s) =>
      eraseUniverse(s, personalStores),
    );
    expect(erased.kind).toBe('entered');
    expect(
      await database.db
        .selectFrom('personal_context.contributions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('personal_context.supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('personal_context.state')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
  });
});
