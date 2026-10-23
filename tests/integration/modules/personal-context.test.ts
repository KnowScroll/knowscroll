import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  advanceScopeRevision,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import type { RecordingActivityDerivedInput } from '@knowscroll/backend/modules/evidence';
import { activityContextEffect } from '@knowscroll/backend/modules/personal-context/nest-providers';
import type { PersonalAuthority } from '@knowscroll/backend/modules/identity';
import { recordingPolicyFor, accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';
import { coverage, dwell, event, openActive } from '../support/observations.js';
import { recordingPerson } from '../support/recording-person.js';

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
    c = await scrollUseCases(database, { recording: true, activityNow: () => evaluation });
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
    await database.db
      .updateTable('experience.encounter_lineage')
      .set({ activated_at: encounterTime })
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', exposure.exposureId)
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
  it('projects the actual richer recording exposure into only the strict PC contribution identity and replays unchanged', async () => {
    const p = await recordingPerson(database),
      r = await read(p);
    await qualify(p, r.exposure.exposureId);
    const stored = await database.db
      .selectFrom('personal_context.recording_exposure_contributions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', r.exposure.exposureId)
      .executeTakeFirstOrThrow();
    const payload = stored.payload as { contribution: Record<string, unknown> };
    expect(Object.keys(payload.contribution).sort()).toEqual(
      [
        'version',
        'exposureId',
        'assetId',
        'assetRevision',
        'activatedAt',
        'explanationUnitId',
        'qualified',
        'coveredFacets',
        'topics',
        'input',
      ].sort(),
    );
    expect(payload.contribution).toMatchObject({
      version: 'personal-contribution.v0',
      exposureId: r.exposure.exposureId,
      assetId: first.assetId,
      assetRevision: first.revision,
      activatedAt: encounterTime.toISOString(),
      explanationUnitId: unit,
      qualified: true,
      coveredFacets: [],
      topics: [{ topicId: topicA, role: 'primary' }],
    });
    const before = await database.db
      .selectFrom('personal_context.state')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(await c.projectActivity(job(p, r.exposure.exposureId))).toEqual({
      kind: 'skipped',
      reason: 'already_applied',
    });
    expect(
      await database.db
        .selectFrom('personal_context.recording_exposure_contributions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', r.exposure.exposureId)
        .executeTakeFirstOrThrow(),
    ).toEqual(stored);
    expect(
      await database.db
        .selectFrom('personal_context.state')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect((await snapshot(p)).topics[0]?.qualifiedExplanationUnits).toBe(1);
  });
  it('does not fill absent committed PC support from carried qualified Evidence in an action-only segment', async () => {
    // Explicit owner-port fixture: real activated exposure/audit/root capability; only the
    // carried aggregate is authored true to exercise the forbidden cross-owner shortcut.
    const p = await seedPerson(database.db),
      e = await openActive(c, p, first);
    // Activation alone has no factual activity source. Accept a real nonqualifying observation
    // before asking the real projector for the audit used by this explicit owner-port case.
    expect(await c.projectActivity(job(p, e.exposureId))).toMatchObject({
      kind: 'skipped',
      reason: 'no_current_source',
    });
    expect(
      await c.ingestObservations(p.authority, { instrumentationVersion: 1, events: [event(e, dwell([0, 1]))] }),
    ).toMatchObject({ kind: 'ingested', accepted: 1 });
    await c.projectScrollReading(job(p, e.exposureId));
    expect(await c.projectActivity(job(p, e.exposureId))).toMatchObject({ kind: 'applied' });
    const audit = await database.db
      .selectFrom('evidence.activity_revisions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', e.exposureId)
      .orderBy('revision', 'desc')
      .executeTakeFirstOrThrow();
    const exposure = await database.db
      .selectFrom('experience.exposures')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('id', '=', e.exposureId)
      .executeTakeFirstOrThrow();
    const input: RecordingActivityDerivedInput = {
      version: 'recording-activity.v1',
      recordingGeneration: 1,
      exposure: {
        exposureId: e.exposureId,
        assetId: first.assetId,
        assetRevision: first.revision,
        activatedAt: new Date(exposure.activated_at!).toISOString(),
      },
      metadata: { explanationUnitId: unit, topics: [{ topicId: topicA, role: 'primary', weight: 1 }] },
      inputVector: {
        qualificationRevision: 0,
        actionRevision: 0,
        navigationRevision: 0,
        attribution: 'ci-owned-absent-pc-base',
        policy: 'recording-credit.v1',
      },
      currentSegment: {
        activity: { id: audit.id, revision: audit.revision, recordingGeneration: 1 },
        qualification: null,
        measured: false,
        qualified: false,
      },
      evidenceEffective: {
        channels: { q: 1, L: false, B: false, S: 0, H: false, R: false },
        measured: true,
        qualified: true,
      },
    };
    const pc = personalStores.find((s) => s.module === 'personal-context');
    if (!pc) throw new Error('fixture_pc_owner_missing');
    const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      const own = await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope);
      if (own.kind !== 'active') throw new Error('fixture_own_account_gate_missing');
      await pc.erase(scope);
      const gate = await fencePersonalRecording(scope, 1);
      if (gate.kind !== 'recording') throw new Error('fixture_recording_capability_missing');
      await expect(
        c.activityContextEffect.applyRecording(gate.scope, {
          ...input,
          exposure: { ...input.exposure, assetRevision: 0 },
        }),
      ).rejects.toThrow();
      expect(await c.activityContextEffect.applyRecording(gate.scope, input)).toBe(true);
      expect(await c.activityContextEffect.applyRecording(gate.scope, input)).toBe(false);
      expect(await c.activityContextEffect.isRecordingCurrent(gate.scope, input)).toBe(true);
      await advanceScopeRevision(scope);
    });
    expect(result.kind).toBe('entered');
    expect(
      await database.db
        .selectFrom('personal_context.supports')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    const stored = await database.db
      .selectFrom('personal_context.recording_exposure_contributions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(stored.qualified).toBe(false);
    expect(stored.frozen_base).toEqual({ version: 'recording-personal-contribution.v1', contribution: null });
    expect((await snapshot(p)).topics[0]?.qualifiedExplanationUnits).toBe(0);
  });
  it.each([false, true])('resumes with only its own committed PC baseline (baseline present=%s)', async (committed) => {
    const p = await seedPerson(database.db),
      r = await read(p);
    await qualify(p, r.exposure.exposureId);
    const pc = personalStores.find((s) => s.module === 'personal-context');
    if (!pc) throw new Error('fixture_pc_owner_missing');
    const sealed = await database.db
      .selectFrom('personal_context.recording_segment_heads')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('recording_generation', '=', 1)
      .execute();
    const observations = await database.db
      .selectFrom('evidence.observations')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    if (!committed) await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) => pc.erase(s));
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      expect(
        await policy.set(p.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration,
          on,
        }),
      ).toMatchObject({ kind: 'ok' });
    const sessionId = randomUUID();
    expect(
      await c.activateExposure(p.authority, {
        commandId: sessionId,
        exposureId: r.exposure.exposureId,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'activated' });
    const currentJob = { ...job(p, r.exposure.exposureId), v: 2 as const, recordingGeneration: 3 };
    expect(await c.projectActivity(currentJob)).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
    expect(
      await database.db
        .selectFrom('personal_context.recording_segment_heads')
        .select('exposure_id')
        .where('universe_id', '=', p.universeId)
        .where('recording_generation', '=', 3)
        .execute(),
    ).toEqual([]);
    // One actual accepted current-session observation creates an unknown Q source. It cannot
    // requalify from generation1's raw events, and activation by itself still creates no head.
    const currentEvent = event(r.exposure, dwell([0, 1]), { sessionId });
    expect(
      await c.ingestObservations(p.authority, {
        version: 'observation-batch.v2',
        recordingGeneration: 3,
        instrumentationVersion: 1,
        events: [currentEvent],
      }),
    ).toMatchObject({ kind: 'ingested', accepted: 1 });
    expect(await c.projectScrollReading(currentJob)).toMatchObject({ kind: 'applied', qualification: 'unknown' });
    expect(await c.projectActivity(currentJob)).toMatchObject({ kind: 'applied' });
    const current = await database.db
      .selectFrom('personal_context.recording_segment_heads')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('recording_generation', '=', 3)
      .executeTakeFirstOrThrow();
    expect(current.qualification_id).toEqual(expect.any(String));
    expect(current.qualified).toBe(false);
    const effective = await database.db
      .selectFrom('personal_context.recording_exposure_contributions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(effective.qualified).toBe(committed);
    expect((await snapshot(p)).topics[0]?.qualifiedExplanationUnits).toBe(Number(committed));
    if (committed)
      expect(
        await database.db
          .selectFrom('personal_context.recording_segment_heads')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .where('recording_generation', '=', 1)
          .execute(),
      ).toEqual(sealed);
    expect(
      await database.db
        .selectFrom('evidence.observations')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual(expect.arrayContaining(observations));
    const allObservations = await database.db
      .selectFrom('evidence.observations')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(allObservations).toHaveLength(observations.length + 1);
    expect(
      allObservations.filter((row) => row.recording_generation === 1).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...observations].sort((a, b) => a.id.localeCompare(b.id)));
    expect(allObservations.filter((row) => row.recording_generation === 3)).toHaveLength(1);
  });
  it('keeps pending observations separate, then incrementally consumes real qualification without metadata facet invention', async () => {
    const p = await seedPerson(database.db),
      r = await read(p);
    const pending = await snapshot(p);
    expect(pending.provisional).toMatchObject({ purpose: 'routing_only', hasMore: false });
    expect(pending).toMatchObject({
      proofAvailability: 'available',
      proofReason: 'bounded',
      completeness: 'not_asserted',
    });
    expect(pending.provisional.entries.map((e) => e.eventId).sort()).toEqual(r.events.map((e) => e.eventId).sort());
    expect(pending.topics[0]).toMatchObject({
      qualifiedExplanationUnits: 0,
      coveredFacets: 0,
      activity: 0,
      statisticsAvailability: 'available',
    });
    expect(pending.topics[1]).toMatchObject({
      topicId: topicB,
      statisticsAvailability: 'not_observed',
      activity: 0,
      interest: 0,
    });
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
  it('keeps recording encounter attribution pinned when later Content topic metadata changes', async () => {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = unit;
    const asset = await c.importScroll(source);
    if (asset.kind !== 'imported') throw new Error('fixture_import_refused');
    await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', asset.assetId).execute();
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: asset.assetId, asset_revision: asset.revision, topic_id: topicA, role: 'primary', weight: 1 })
      .execute();
    const p = await seedPerson(database.db),
      r = await read(p, asset);
    await qualify(p, r.exposure.exposureId);
    const before = await snapshot(p),
      descriptor = await database.db
        .selectFrom('experience.recording_segments')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', r.exposure.exposureId)
        .where('recording_generation', '=', 1)
        .executeTakeFirstOrThrow();
    await database.db
      .updateTable('content.encounter_topics')
      .set({ topic_id: topicB })
      .where('asset_id', '=', asset.assetId)
      .execute();
    await c.projectActivity(job(p, r.exposure.exposureId));
    const after = await snapshot(p);
    expect(after.topics[0]).toEqual(before.topics[0]);
    expect(after.topics[1]).toMatchObject({
      qualifiedExplanationUnits: 0,
      activity: 0,
      statisticsAvailability: 'not_observed',
    });
    expect(
      await database.db
        .selectFrom('experience.recording_segments')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', r.exposure.exposureId)
        .where('recording_generation', '=', 1)
        .executeTakeFirstOrThrow(),
    ).toEqual(descriptor);
  });
  it('deduplicates actual encounters while pinning A→B→A metadata changes; only a new B encounter earns B support', async () => {
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
    expect(corrected.topics[0]).toEqual(original.topics[0]);
    expect(corrected.topics[1]).toMatchObject({
      qualifiedExplanationUnits: 0,
      activity: 0,
      statisticsAvailability: 'not_observed',
    });
    // A real newly activated encounter pins the new B attribution. Same explanation identity
    // contributes one unit per actual attributed topic, never two units for its A variants.
    const freshB = await read(p, first);
    await qualify(p, freshB.exposure.exposureId);
    const withB = await snapshot(p);
    expect(withB.topics[0]).toEqual(original.topics[0]);
    expect(withB.topics[1]).toMatchObject({
      qualifiedExplanationUnits: 1,
      formats: [{ measured: 0 }, { measured: 1, qualified: 1 }],
    });
    expect(withB.supportingEvidence.every((c) => c.explanationUnitId === unit)).toBe(true);
    for (const asset of [first, twin])
      await database.db
        .updateTable('content.encounter_topics')
        .set({ topic_id: topicA })
        .where('asset_id', '=', asset.assetId)
        .execute();
    for (const e of [a.exposure, b.exposure, freshB.exposure]) await c.projectActivity(job(p, e.exposureId));
    const restored = await snapshot(p);
    expect(restored.topics[0]).toEqual(original.topics[0]);
    expect(restored.topics[1]).toEqual(withB.topics[1]);
    expect(restored.revision).toBeGreaterThan(corrected.revision);
  });
  it('rolls Evidence, derived support and revision back together when the required context effect fails', async () => {
    const p = await seedPerson(database.db),
      exposure = await openActive(c, p, first);
    expect(
      await c.ingestObservations(p.authority, { instrumentationVersion: 1, events: [event(exposure, dwell([0, 1]))] }),
    ).toMatchObject({ kind: 'ingested', accepted: 1 });
    await c.projectScrollReading(job(p, exposure.exposureId));
    const failing = await scrollUseCases(database, {
      recording: true,
      activityNow: () => evaluation,
      activityDerived: {
        isRecordingCurrent: c.activityContextEffect.isRecordingCurrent,
        applyRecording: async (s, x) => {
          await c.activityContextEffect.applyRecording(s, x);
          throw new Error('CI_FIXTURE_CONTEXT_FAILURE');
        },
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
      .selectFrom('evidence.recording_segment_heads')
      .where('recording_generation', '=', 1)
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
