import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { fixtureComposerSnapshot } from '../support/composer.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { admitContinuity, makeAdmissionStore } from '@knowscroll/backend/modules/content/nest-providers';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { type NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { recordingPerson } from '../support/recording-person.js';
import { recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
function ready(result: Awaited<ReturnType<Cases['navigate']>>): Extract<NavigationOutcome, { status: 'ready' }> {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}
async function fixtureAsset(c: Cases, unit = `fixture-nav-${randomUUID()}`) {
  const src = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
  src.assetId = randomUUID();
  src.publication.explanationUnitId = unit;
  const x = await c.importScroll(src);
  if (x.kind !== 'imported') throw new Error('fixture admission refused');
  return { assetId: x.assetId, assetRevision: x.revision, unit };
}
const discovery = () => ({
  commandId: randomUUID(),
  target: { kind: 'discover' as const },
  capabilities: textCapabilities,
});
const activation = (o: Extract<NavigationOutcome, { status: 'ready' }>, commandId = randomUUID()) => ({
  commandId,
  target: {
    kind: 'offer' as const,
    sessionId: o.sessionId,
    offerId: o.offer.offerId,
    expectedIntentRevision: o.intentRevision,
  },
});
const job = (universeId: string, exposureId: string) => ({ v: 1 as const, universeId, privacyEpoch: 1, exposureId });
describe('Experience navigation and actual routing activity (real PostgreSQL CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases, current: Cases;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('navigation_activity');
    c = await scrollUseCases(database);
    current = await scrollUseCases(database, { recording: true });
  });
  afterAll(async () => {
    await c.close();
    await current.close();
    await database.drop();
  });
  it('creates offers without encounters; concurrent same-key commands replay one committed decision and activation binds one exposure', async () => {
    const c = current;
    const p = await recordingPerson(database);
    await fixtureAsset(c);
    await fixtureAsset(c);
    const command = discovery();
    const pair = await Promise.all([c.navigate(p.authority, command), c.navigate(p.authority, command)]);
    const a = ready(pair[0]),
      b = ready(pair[1]);
    expect(a.offer).toEqual(b.offer);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.bufferedOffers.length).toBeLessThanOrEqual(2);
    expect(
      await database.db
        .selectFrom('experience.exposures')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('experience.encounter_lineage')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    const cmd = activation(a);
    const acts = await Promise.all([c.activateOffer(p.authority, cmd), c.activateOffer(p.authority, activation(a))]);
    expect(acts[0]).toMatchObject({ kind: 'accepted' });
    expect(acts[1]).toMatchObject({ kind: 'accepted' });
    if (acts[0]?.kind !== 'accepted' || acts[1]?.kind !== 'accepted') throw new Error('activation refused');
    const id = acts[0].outcome.exposureId;
    expect(acts[1].outcome.exposureId).toBe(id);
    expect(
      await database.db
        .selectFrom('experience.exposures')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(1);
    const payload = job(p.universeId, id);
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event({ exposureId: id, assetId: a.offer.assetId, assetRevision: a.offer.assetRevision }, dwell([0, 1])),
      ],
    });
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'unknown' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'skipped', reason: 'already_applied' });
    const rev = await database.db
      .selectFrom('evidence.activity_revisions')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ channels: { q: null, L: false, B: false, S: 0, H: false, R: false }, activity: 0 });
    // Progress changes new commands' authority; completed replay remains immutable after TTL/progression.
    const next = ready(
      await c.navigate(p.authority, {
        commandId: randomUUID(),
        sessionId: a.sessionId,
        expectedIntentRevision: a.intentRevision,
        from: { offerId: a.offer.offerId, exposureId: id },
        intent: { mode: 'vertical', direction: 'next' },
      }),
    );
    await database.db
      .updateTable('experience.offers')
      .set({ expires_at: new Date(Date.now() - 2 * 60000), created_at: new Date(Date.now() - 16 * 60000) })
      .where('universe_id', '=', p.universeId)
      .where('id', '=', a.offer.offerId)
      .execute();
    expect(await c.activateOffer(p.authority, cmd)).toMatchObject({
      kind: 'accepted',
      outcome: { exposureId: id, replayed: true },
    });
    expect(await c.activateOffer(p.authority, activation(a))).toMatchObject({
      kind: 'refused',
      code: 'INTENT_REVISION_STALE',
    });
    expect(await c.readContext(p.authority, id)).toMatchObject({
      kind: 'read',
      context: { session: { sessionId: a.sessionId, intentRevision: next.intentRevision } },
    });
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', a.offer.assetId)
      .execute();
    expect(await c.activateOffer(p.authority, cmd)).toMatchObject({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
  });
  it('accepts any activated parked same-session member at latest intent, rejects stale/cross-session lineage, and serializes simultaneous intents', async () => {
    const p = await seedPerson(database.db);
    await fixtureAsset(c);
    const a = ready(await c.navigate(p.authority, discovery()));
    const active = await c.activateOffer(p.authority, activation(a));
    if (active.kind !== 'accepted') throw new Error('fixture activation');
    const from = { offerId: a.offer.offerId, exposureId: active.outcome.exposureId };
    const request = {
      commandId: randomUUID(),
      sessionId: a.sessionId,
      expectedIntentRevision: 0,
      from,
      intent: { mode: 'vertical' as const, direction: 'next' as const },
    };
    const results = await Promise.all([
      c.navigate(p.authority, request),
      c.navigate(p.authority, { ...request, commandId: randomUUID() }),
    ]);
    expect(results.filter((r) => r.kind === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'refused')).toEqual([{ kind: 'refused', code: 'INTENT_REVISION_STALE' }]);
    const parked = await c.navigate(p.authority, { ...request, commandId: randomUUID(), expectedIntentRevision: 1 });
    expect(parked.kind).toBe('accepted');
    const other = ready(await c.navigate(p.authority, discovery()));
    expect(
      await c.navigate(p.authority, { ...request, commandId: randomUUID(), sessionId: other.sessionId }),
    ).toMatchObject({ kind: 'refused', code: 'OFFER_UNAVAILABLE' });
  });
  it('expired unactivated offers refuse; action correction follows original exposure; unknown measurement stays unknown; exact Saved survives correction and withdrawal for removal', async () => {
    const c = current;
    const p = await recordingPerson(database),
      asset = await fixtureAsset(c);
    const open = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: asset.assetId, assetRevision: asset.assetRevision },
      }),
    );
    await database.db
      .updateTable('experience.offers')
      .set({ expires_at: new Date(Date.now() - 2 * 60000), created_at: new Date(Date.now() - 16 * 60000) })
      .where('universe_id', '=', p.universeId)
      .where('id', '=', open.offer.offerId)
      .execute();
    expect(await c.activateOffer(p.authority, activation(open))).toMatchObject({
      kind: 'refused',
      code: 'OFFER_UNAVAILABLE',
    });
    const o = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: asset.assetId, assetRevision: asset.assetRevision },
      }),
    );
    const a = await c.activateOffer(p.authority, activation(o));
    if (a.kind !== 'accepted') throw new Error('fixture activation');
    const exposureId = a.outcome.exposureId;
    const target = { assetId: asset.assetId, assetRevision: asset.assetRevision };
    for (const kind of ['like', 'save'] as const)
      expect(
        await c.applyEncounterAction(p.authority, { commandId: randomUUID(), kind, target, exposureId }),
      ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
    await c.projectActivity(job(p.universeId, exposureId));
    const again = ready(await c.navigate(p.authority, { ...discovery(), target: { kind: 'return', ...target } }));
    const second = await c.activateOffer(p.authority, activation(again));
    if (second.kind !== 'accepted') throw new Error('fixture activation');
    expect(
      await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'unlike',
        target,
        exposureId: second.outcome.exposureId,
      }),
    ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
    await c.projectActivity(job(p.universeId, exposureId));
    const original = await database.db
      .selectFrom('evidence.activity_revisions')
      .select(['channels', 'activity'])
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', exposureId)
      .orderBy('revision', 'desc')
      .executeTakeFirst();
    expect(original).toMatchObject({ channels: { q: null, L: false, B: true }, activity: 1.5 });
    expect(
      await database.db
        .selectFrom('evidence.encounter_evidence')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    const unknown = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readPrepared(s, {
        evaluatedAt: new Date().toISOString(),
        topicIds: [],
        candidates: [{ explanationUnitId: asset.unit, facets: [] }],
        candidateAssetIds: [asset.assetId],
      }),
    );
    expect(unknown).toMatchObject({
      kind: 'entered',
      value: { topics: [], established: { units: [{ encountered: true }] } },
    });
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', asset.assetId)
      .execute();
    expect(await c.listSaved(p.authority, 100)).toMatchObject({
      kind: 'read',
      items: [{ assetId: asset.assetId, assetRevision: 1, availability: 'withdrawn' }],
    });
    expect(
      await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'unsave',
        target,
        exposureId: second.outcome.exposureId,
      }),
    ).toMatchObject({ kind: 'applied', outcome: { changed: true, saved: false } });
    await c.projectActivity(job(p.universeId, exposureId));
    expect(
      await database.db
        .selectFrom('evidence.activity_revisions')
        .select('channels')
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', exposureId)
        .orderBy('revision', 'desc')
        .executeTakeFirst(),
    ).toMatchObject({ channels: { q: null, L: false, B: false } });
  });
  it('credits deliberate activated continuation to its exact SOURCE once; historical return needs actual separated encounters', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c),
      b = await fixtureAsset(c),
      linkId = randomUUID();
    await makeAdmissionStore(database.db).inAdmission((tx) =>
      admitContinuity(tx, {
        authorityReference: 'ci.explicit.related',
        series: [],
        links: [
          {
            linkId,
            revision: 1,
            source: { assetId: a.assetId, assetRevision: 1 },
            target: { assetId: b.assetId, assetRevision: 1 },
            direction: 'related',
            relation: { kind: 'related_move', label: 'CI related perspective' },
            strength: 1,
            authorityReference: 'ci.explicit.related',
          },
        ],
      }),
    );
    const o = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
      }),
    );
    const active = await c.activateOffer(p.authority, activation(o));
    if (active.kind !== 'accepted') throw new Error('fixture');
    const request = {
      commandId: randomUUID(),
      sessionId: o.sessionId,
      expectedIntentRevision: 0,
      from: { offerId: o.offer.offerId, exposureId: active.outcome.exposureId },
      intent: { mode: 'related' as const, expectedContinuation: { linkId, assetId: b.assetId, assetRevision: 1 } },
    };
    const dest = ready(await c.navigate(p.authority, request));
    expect(
      await database.db
        .selectFrom('experience.encounter_activity_inputs')
        .select('horizontal')
        .where('exposure_id', '=', active.outcome.exposureId)
        .executeTakeFirst(),
    ).toEqual({ horizontal: false });
    const activated = await c.activateOffer(p.authority, activation(dest));
    expect(activated.kind).toBe('accepted');
    await c.activateOffer(p.authority, activation(dest));
    const source = await database.db
      .selectFrom('experience.encounter_activity_inputs')
      .select(['horizontal', 'navigation_revision'])
      .where('exposure_id', '=', active.outcome.exposureId)
      .executeTakeFirst();
    expect(source).toEqual({ horizontal: true, navigation_revision: 1 });
    if (activated.kind !== 'accepted') throw new Error('fixture');
    expect(
      await database.db
        .selectFrom('experience.encounter_activity_inputs')
        .select(['horizontal', 'returned'])
        .where('exposure_id', '=', activated.outcome.exposureId)
        .executeTakeFirst(),
    ).toEqual({ horizontal: false, returned: false });
    // This is an explicit CI clock fixture, never an invented runtime encounter.
    await activatedAgo(database.db, active.outcome.exposureId, 31);
    await sql`update experience.encounter_lineage set activated_at=now()-interval '31 minutes' where exposure_id=${active.outcome.exposureId}::uuid`.execute(
      database.db,
    );
    const ret = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
      }),
    );
    const returned = await c.activateOffer(p.authority, activation(ret));
    if (returned.kind !== 'accepted') throw new Error('fixture');
    expect(
      await database.db
        .selectFrom('experience.encounter_activity_inputs')
        .select('returned')
        .where('exposure_id', '=', returned.outcome.exposureId)
        .executeTakeFirst(),
    ).toEqual({ returned: true });
    const ctx = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readPrepared(s, {
        evaluatedAt: new Date().toISOString(),
        topicIds: [],
        candidates: [{ explanationUnitId: a.unit, facets: [] }],
        candidateAssetIds: [],
      }),
    );
    expect(ctx).toMatchObject({ kind: 'entered', value: { established: { units: [{ encountered: true }] } } });
  });
  it('activity.v1: a deliberate continuation credits its source only when the source was read (D-191)', async () => {
    const c = current;
    const p = await recordingPerson(database),
      source = await fixtureAsset(c),
      target = await fixtureAsset(c),
      linkId = randomUUID(),
      topic = `ci.topic.${randomUUID()}`;
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: source.assetId, asset_revision: 1, topic_id: topic, role: 'primary', weight: 1 })
      .execute();
    await makeAdmissionStore(database.db).inAdmission((tx) =>
      admitContinuity(tx, {
        authorityReference: 'ci.explicit.related',
        series: [],
        links: [
          {
            linkId,
            revision: 1,
            source: { assetId: source.assetId, assetRevision: 1 },
            target: { assetId: target.assetId, assetRevision: 1 },
            direction: 'related',
            relation: { kind: 'related_move', label: 'CI related perspective' },
            strength: 1,
            authorityReference: 'ci.explicit.related',
          },
        ],
      }),
    );
    const first = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: source.assetId, assetRevision: 1 },
      }),
    );
    const active = await c.activateOffer(p.authority, activation(first));
    if (active.kind !== 'accepted') throw new Error('fixture');
    const exposureId = active.outcome.exposureId;
    const swiped = ready(
      await c.navigate(p.authority, {
        commandId: randomUUID(),
        sessionId: first.sessionId,
        expectedIntentRevision: 0,
        from: { offerId: first.offer.offerId, exposureId },
        intent: {
          mode: 'related' as const,
          expectedContinuation: { linkId, assetId: target.assetId, assetRevision: 1 },
        },
      }),
    );
    expect((await c.activateOffer(p.authority, activation(swiped))).kind).toBe('accepted');
    const flag = await database.db
      .selectFrom('experience.recording_segment_inputs')
      .select('horizontal')
      .where('exposure_id', '=', exposureId)
      .executeTakeFirst();
    expect(flag).toEqual({ horizontal: true });

    const latest = async () =>
      database.db
        .selectFrom('evidence.activity_revisions')
        .select(['channels', 'activity', 'policy_version'])
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', exposureId)
        .orderBy('revision', 'desc')
        .executeTakeFirstOrThrow();
    const topicActivity = async () =>
      (
        await database.db
          .selectFrom('evidence.topic_context')
          .select('channel_values')
          .where('universe_id', '=', p.universeId)
          .where('topic_id', '=', topic)
          .executeTakeFirstOrThrow()
      ).channel_values as { H: number };
    const payload = job(p.universeId, exposureId);
    const factsRow = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', source.assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const facts = factsRow.reading_facts as { blocks: { id: string }[]; estimatedReadingMs: number };
    const blockIds = facts.blocks.map((block) => block.id);
    const opened = { exposureId, assetId: source.assetId, assetRevision: 1 };
    await activatedAgo(database.db, exposureId, 30);

    // Swiped on with nothing read: the move happened, and it credits nothing.
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    expect(await latest()).toMatchObject({ channels: { H: false }, activity: 0, policy_version: 'activity.v1' });
    expect((await topicActivity()).H).toBe(0);

    // A glance at two blocks: not enough to count, so still nothing for the move.
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event(opened, coverage(blockIds.slice(0, 2), 3000)), event(opened, dwell([0, 6000]))],
    });
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    expect(await latest()).toMatchObject({ channels: { H: false }, policy_version: 'activity.v1' });
    expect((await topicActivity()).H).toBe(0);

    // Read through: the same move now credits the part it left.
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event(opened, coverage(blockIds, 4000, 6000)),
        event(opened, dwell([0, 6000 + 4000 * blockIds.length + facts.estimatedReadingMs])),
      ],
    });
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    const read = await latest();
    expect(read).toMatchObject({ channels: { H: true }, policy_version: 'activity.v1' });
    expect(read.activity).toBeGreaterThan(1.5);
    // The channel is the move itself (1, weighted by the topic); the +1.5 is applied by the activity sum.
    expect((await topicActivity()).H).toBeGreaterThan(0.9);

    // What Composer is handed for its next move: the topics of the encounter just left (for the recent-topic penalty,
    // D-190) and the play-level cell the reading was counted in (D-192).
    const context = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      c.readPrepared(s, {
        evaluatedAt: new Date().toISOString(),
        topicIds: [topic],
        candidates: [{ explanationUnitId: source.unit, facets: [] }],
        candidateAssetIds: [],
      }),
    );
    expect(context).toMatchObject({
      kind: 'entered',
      value: {
        recent: expect.arrayContaining([
          expect.objectContaining({ explanationUnitId: source.unit, topicIds: [topic] }),
        ]) as unknown,
        topics: [{ topicId: topic, cells: [{ kind: 'scroll', level: 'plain', measured: 1, qualified: 1 }] }],
      },
    });
  });
  it('replaces late qualification/action/attribution deltas, excludes unknown Q/O, preserves topic weight bounds and scoped candidate Hide', async () => {
    const c = current;
    const p = await recordingPerson(database),
      a = await fixtureAsset(c),
      topic = `ci.topic.${randomUUID()}`;
    // Explicit CI admitted-metadata fixture; production authority is tested by content's importer tests.
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: a.assetId, asset_revision: 1, topic_id: topic, role: 'primary', weight: 0.7 })
      .execute();
    const o = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
      }),
    );
    const active = await c.activateOffer(p.authority, activation(o));
    if (active.kind !== 'accepted') throw new Error('fixture');
    const exposureId = active.outcome.exposureId;
    const payload = job(p.universeId, exposureId);
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [event({ exposureId, assetId: a.assetId, assetRevision: 1 }, dwell([0, 1]))],
    });
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'unknown' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    expect(
      await database.db
        .selectFrom('evidence.topic_context')
        .select(['scroll_measured', 'scroll_qualified'])
        .where('universe_id', '=', p.universeId)
        .where('topic_id', '=', topic)
        .executeTakeFirst(),
    ).toEqual({ scroll_measured: 0, scroll_qualified: 0 });
    await activatedAgo(database.db, exposureId, 30);
    await c.ingestObservations(p.authority, {
      instrumentationVersion: 1,
      events: [
        event(
          { exposureId, assetId: a.assetId, assetRevision: 1 },
          coverage(['intro-look-up', 'intro-short-version', 'sunlight-prism'], 3000),
        ),
        event({ exposureId, assetId: a.assetId, assetRevision: 1 }, dwell([0, 9000])),
      ],
    });
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    const before = await database.db
      .selectFrom('evidence.topic_context')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('topic_id', '=', topic)
      .executeTakeFirstOrThrow();
    expect(before.scroll_measured).toBe(1);
    await c.applyEncounterAction(p.authority, {
      commandId: randomUUID(),
      kind: 'save',
      target: { assetId: a.assetId, assetRevision: 1 },
      exposureId,
    });
    await c.projectActivity(payload);
    await c.projectActivity(payload);
    const after = await database.db
      .selectFrom('evidence.topic_context')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('topic_id', '=', topic)
      .executeTakeFirstOrThrow();
    expect(after.scroll_measured).toBe(1);
    expect(after.activity).toBeGreaterThan(before.activity);
    await c.applyEncounterAction(p.authority, {
      commandId: randomUUID(),
      kind: 'unsave',
      target: { assetId: a.assetId, assetRevision: 1 },
    });
    await c.projectActivity(payload);
    const corrected = await database.db
      .selectFrom('evidence.topic_context')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('topic_id', '=', topic)
      .executeTakeFirstOrThrow();
    expect(corrected.activity).toBeCloseTo(before.activity, 4);
    expect(corrected.scroll_measured).toBe(1);
    await c.applyEncounterAction(p.authority, {
      commandId: randomUUID(),
      kind: 'hide',
      target: { assetId: a.assetId, assetRevision: 1 },
    });
    const scoped = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const query = {
      evaluatedAt: new Date().toISOString(),
      topicIds: [topic],
      candidates: [{ explanationUnitId: a.unit, facets: [] }],
      candidateAssetIds: [a.assetId],
    };
    expect(await scoped(p.authority, (s) => c.readPrepared(s, query))).toMatchObject({
      kind: 'entered',
      value: {
        hiddenAssetIds: [a.assetId],
        topics: [
          {
            formats: [
              { kind: 'reel', measured: 0, qualified: 0 },
              { kind: 'scroll', measured: 1 },
            ],
          },
        ],
      },
    });
    const other = await seedPerson(database.db);
    expect(await scoped(other.authority, (s) => c.readPrepared(s, query))).toMatchObject({
      kind: 'entered',
      value: { hiddenAssetIds: [], topics: [] },
    });
    await expect(
      scoped(p.authority, (s) => c.readPrepared(s, { ...query, candidateAssetIds: [a.assetId, a.assetId] })),
    ).rejects.toThrow('ACTIVITY_CONTEXT_QUERY_INVALID');
    expect(await c.projectActivity({ ...payload, privacyEpoch: 2 })).toMatchObject({
      kind: 'skipped',
      reason: 'epoch_changed',
    });
    expect(await c.reconcileActivity(p.authority, { limit: 1 })).toMatchObject({
      kind: 'entered',
      value: { examined: 1, queued: 0, metadataGaps: 0 },
    });
  });
  it('rolls receipt, exposure, binding and required job back together on enqueue failure', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c);
    const broken = await scrollUseCases(database, {
      wrapEnqueue: (enqueue) => async (scope, queue, payload) => {
        await enqueue(scope, queue, payload);
        throw new Error('CI_REQUIRED_ENQUEUE_FAILURE');
      },
    });
    try {
      const o = ready(
          await broken.navigate(p.authority, {
            ...discovery(),
            target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
          }),
        ),
        cmd = activation(o);
      await expect(broken.activateOffer(p.authority, cmd)).rejects.toThrow('CI_REQUIRED_ENQUEUE_FAILURE');
      expect(
        await database.db
          .selectFrom('experience.exposures')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database.db
          .selectFrom('experience.offer_activations')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database.db
          .selectFrom('receipts.personal_commands')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .where('command_id', '=', cmd.commandId)
          .execute(),
      ).toHaveLength(0);
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pgboss.job where data->>'universeId'=${p.universeId}`.execute(database.db)
        ).rows[0]?.n,
      ).toBe(0);
      expect(await c.activateOffer(p.authority, cmd)).toMatchObject({ kind: 'accepted', outcome: { replayed: false } });
    } finally {
      await broken.close();
    }
  });
  it('rechecks selected current eligibility after snapshot and performs only one bounded rerank', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c);
    let transactions = 0,
      armed = true;
    const racing = await scrollUseCases(database, {
      wrapScope: (scope) => async (authority, fn) => {
        const result = await scope(authority, fn);
        if (armed) {
          transactions++;
          if (transactions === 1) {
            await database.db
              .updateTable('content.assets')
              .set({ status: 'withdrawn' })
              .where('id', '=', a.assetId)
              .execute();
          }
        }
        return result;
      },
    });
    try {
      const result = await racing.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
      });
      armed = false;
      expect(result).toMatchObject({
        kind: 'accepted',
        outcome: { status: 'exhausted', reason: 'return_unavailable' },
      });
      expect(transactions).toBe(4);
      expect(
        await database.db
          .selectFrom('experience.exposures')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database.db
          .selectFrom('composer.decisions')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await racing.close();
    }
  });

  it('retains expired referenced decisions unreadable, prunes only expired unreferenced own decisions, then fully erases offers and decisions', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c),
      scope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 }),
      store = makeComposerStore({ isOperator: () => true });
    const o = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: a.assetId, assetRevision: 1 },
      }),
    );
    const unreferenced = randomUUID();
    await scope(p.authority, (s) =>
      store.persistComposerDecision(
        s,
        { decisionId: unreferenced, commandId: randomUUID() },
        composeEncounter(fixtureComposerSnapshot(p.authority)),
      ),
    );
    await sql`update composer.decisions set recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' where universe_id=${p.universeId}::uuid`.execute(
      database.db,
    );
    expect(await scope(p.authority, (s) => store.pruneComposerDecisions(s, 100))).toMatchObject({
      kind: 'entered',
      value: 1,
    });
    expect(await scope(p.authority, (s) => store.readComposerDecision(s, o.decisionId))).toMatchObject({
      kind: 'entered',
      value: undefined,
    });
    expect(
      await database.db.selectFrom('composer.decisions').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toEqual([{ id: o.decisionId }]);
    await scope(p.authority, (s) => eraseUniverse(s, personalStores));
    expect(
      await database.db.selectFrom('composer.decisions').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db.selectFrom('experience.offers').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
  });
  it('persists each new receipt operation with identical replay and reused-key refusal under unchanged receipt grammar', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c),
      cmd = { ...discovery(), target: { kind: 'return' as const, assetId: a.assetId, assetRevision: 1 } };
    const o = ready(await c.navigate(p.authority, cmd));
    expect(ready(await c.navigate(p.authority, cmd))).toMatchObject({ ...o, replayed: true });
    expect(await c.navigate(p.authority, { ...cmd, target: { kind: 'discover' } })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    const ac = activation(o),
      active = await c.activateOffer(p.authority, ac);
    if (active.kind !== 'accepted') throw new Error('fixture activation');
    expect(await c.activateOffer(p.authority, ac)).toMatchObject({
      kind: 'accepted',
      outcome: { ...active.outcome, replayed: true },
    });
    expect(await c.activateOffer(p.authority, { ...ac, target: { ...ac.target, expectedIntentRevision: 1 } })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    const action = {
      commandId: randomUUID(),
      kind: 'like' as const,
      target: { assetId: a.assetId, assetRevision: 1 },
      exposureId: active.outcome.exposureId,
    };
    const liked = await c.applyEncounterAction(p.authority, action);
    expect(liked.kind).toBe('applied');
    expect(await c.applyEncounterAction(p.authority, action)).toMatchObject({
      kind: 'applied',
      outcome: { replayed: true, changed: true },
    });
    expect(await c.applyEncounterAction(p.authority, { ...action, kind: 'unlike' })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    const nav = {
      commandId: randomUUID(),
      sessionId: o.sessionId,
      expectedIntentRevision: o.intentRevision,
      from: { offerId: o.offer.offerId, exposureId: active.outcome.exposureId },
      intent: { mode: 'variant' as const, to: 'reel' as const },
    };
    const unavailable = await c.navigate(p.authority, nav);
    expect(unavailable).toMatchObject({
      kind: 'accepted',
      outcome: { status: 'exhausted', reason: 'variant_unavailable' },
    });
    expect(await c.navigate(p.authority, nav)).toMatchObject({
      kind: 'accepted',
      outcome: { status: 'exhausted', replayed: true },
    });
    expect(await c.navigate(p.authority, { ...nav, intent: { mode: 'variant', to: 'scroll' } })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .select(['operation', 'outcome_version'])
        .where('universe_id', '=', p.universeId)
        .orderBy('operation')
        .execute(),
    ).toEqual(
      ['activate-offer', 'compose-open', 'encounter-action', 'navigate'].map((op) => ({
        operation: `experience.${op}-v0`,
        outcome_version: 1,
      })),
    );
  });
  it('replays all three exact long multibyte descriptors through a bounded immutable private receipt and stored offer.v0', async () => {
    const p = await seedPerson(database.db),
      ids: string[] = [];
    // CI fixtures supply varied valid admitted metadata. Each chosen descriptor can exceed the
    // original arbitrary8KiB offer cap while the small private receipt retains all three IDs.
    for (let n = 0; n < 3; n++) {
      const a = await fixtureAsset(c);
      ids.push(a.assetId);
      const summary = Array.from({ length: 2000 }, (_, i) =>
        i % 2 === 0 ? String.fromCodePoint(0x4e00 + ((i + n * 97) % 20000)) : '\u0001',
      ).join('');
      await database.db
        .updateTable('content.discovery_revisions')
        .set({ summary })
        .where('asset_id', '=', a.assetId)
        .execute();
    }
    // Constrain this fixture's discovery inventory via actual scoped Hide preferences, rather
    // than assuming other cases in the shared CI database have no admitted rows.
    const others = await database.db
      .selectFrom('content.assets')
      .select(['id', 'revision'])
      .where('status', '=', 'admitted')
      .where('id', 'not in', ids)
      .execute();
    for (const a of others)
      await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'hide',
        target: { assetId: a.id, assetRevision: a.revision },
      });
    const cmd = discovery(),
      o = ready(await c.navigate(p.authority, cmd));
    expect(o.bufferedOffers).toHaveLength(2);
    const all = [o.offer, ...o.bufferedOffers];
    expect(all.map((x) => x.assetId).sort()).toEqual(ids.sort());
    expect(Buffer.byteLength(JSON.stringify(o), 'utf8')).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(o.offer), 'utf8')).toBeGreaterThan(8192);
    const stored = (
      await sql<{
        bytes: number;
        textbytes: number;
        outcome: unknown;
      }>`select pg_column_size(outcome) bytes,octet_length(outcome::text) textbytes,outcome from receipts.personal_commands where universe_id=${p.universeId}::uuid and command_id=${cmd.commandId}::uuid`.execute(
        database.db,
      )
    ).rows[0]!;
    expect(stored.bytes).toBeLessThanOrEqual(8192);
    expect(stored.textbytes).toBeLessThanOrEqual(8192);
    expect(stored.outcome).toMatchObject({
      version: 'navigation-receipt.v0',
      offerId: o.offer.offerId,
      bufferedOfferIds: o.bufferedOffers.map((x) => x.offerId),
    });
    const rows = await database.db
      .selectFrom('experience.offers')
      .select(['id', 'policy_version', 'descriptor'])
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.policy_version === 'offer.v0')).toBe(true);
    // JSONB object-key order differs from JS insertion order; bind exact descriptor comparison
    // by its immutable ID. The replay assertion below separately preserves chosen/buffer order.
    for (const descriptor of all)
      expect(rows.find((row) => row.id === descriptor.offerId)?.descriptor).toEqual(descriptor);
    // Replay must use the committed immutable descriptor even after metadata and TTL change.
    await database.db
      .updateTable('content.discovery_revisions')
      .set({ summary: 'CI later correction' })
      .where('asset_id', 'in', ids)
      .execute();
    await database.db
      .updateTable('experience.offers')
      .set({ expires_at: new Date(Date.now() - 2 * 60000), created_at: new Date(Date.now() - 16 * 60000) })
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(ready(await c.navigate(p.authority, cmd))).toEqual({ ...o, replayed: true });
    await expect(
      sql`update experience.offers set descriptor=jsonb_set(descriptor,'{metadata,summary}','"tampered"'::jsonb) where universe_id=${p.universeId}::uuid`.execute(
        database.db,
      ),
    ).rejects.toThrow('OFFER_IMMUTABLE');
  });
  it('pins accepted encounter attribution through A->B->A, deduplicates units, and permits only a new B encounter to support B', async () => {
    const p = await recordingPerson(database),
      asset = await fixtureAsset(current),
      tA = `ci-a-${randomUUID()}`,
      tB = `ci-b-${randomUUID()}`,
      at = new Date(Date.now() + 86400000);
    const projected = await scrollUseCases(database, { recording: true, activityNow: () => at });
    const topics = () =>
      database.db
        .selectFrom('evidence.topic_context')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .orderBy('topic_id')
        .execute();
    const revisions = () =>
      database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .orderBy('exposure_id')
        .orderBy('revision')
        .execute();
    const heads = () =>
      database.db
        .selectFrom('evidence.recording_segment_heads')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .orderBy('exposure_id')
        .execute();
    async function attributedEncounter() {
      // Actual direct encounters avoid asking real-now navigation to read this fixture's
      // fixed future evaluation snapshot. No production clock/decay guard is changed.
      const opened = await openActive(current, p, { assetId: asset.assetId, revision: asset.assetRevision });
      const exposureId = opened.exposureId,
        payload = job(p.universeId, exposureId);
      await activatedAgo(database.db, exposureId, 30);
      expect(await projected.projectActivity(payload)).toMatchObject({ kind: 'skipped', reason: 'no_current_source' });
      const facts = await database.db
        .selectFrom('content.asset_revisions')
        .select('reading_facts')
        .where('asset_id', '=', asset.assetId)
        .where('revision', '=', 1)
        .executeTakeFirstOrThrow();
      const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((block) => block.id);
      expect(
        await projected.ingestObservations(p.authority, {
          instrumentationVersion: 1,
          events: [
            event({ exposureId, assetId: asset.assetId, assetRevision: 1 }, coverage(blocks, 4000)),
            event({ exposureId, assetId: asset.assetId, assetRevision: 1 }, dwell([0, 68000])),
          ],
        }),
      ).toMatchObject({ kind: 'ingested', accepted: 2 });
      expect(await projected.projectScrollReading(payload)).toMatchObject({
        kind: 'applied',
        qualification: 'qualified',
      });
      expect(await projected.projectActivity(payload)).toMatchObject({ kind: 'applied' });
      return payload;
    }
    try {
      await database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: asset.assetId, asset_revision: 1, topic_id: tA, role: 'primary', weight: 0.7 })
        .execute();
      const first = await attributedEncounter(),
        twin = await attributedEncounter();
      expect(
        await projected.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          recordingGeneration: 1,
          kind: 'like',
          target: { assetId: asset.assetId, assetRevision: 1 },
          exposureId: first.exposureId,
        }),
      ).toMatchObject({ kind: 'applied' });
      expect(await projected.projectActivity(first)).toMatchObject({ kind: 'skipped', reason: 'already_applied' });
      const initial = await topics(),
        originalRevisions = await revisions(),
        originalHeads = await heads();
      expect(initial.find((t) => t.topic_id === tA)?.scroll_measured).toBe(2);
      expect(
        await database.db
          .selectFrom('personal_context.topics')
          .select('qualified_units')
          .where('universe_id', '=', p.universeId)
          .where('topic_id', '=', tA)
          .executeTakeFirstOrThrow(),
      ).toEqual({ qualified_units: 1 });
      // Replaces the obsolete transfer/revision[1..3] expectation: metadata correction cannot
      // mutate either frozen accepted source or move its committed weight to another topic.
      for (const topic of [tB, tA]) {
        await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', asset.assetId).execute();
        await database.db
          .insertInto('content.encounter_topics')
          .values({
            asset_id: asset.assetId,
            asset_revision: 1,
            topic_id: topic,
            role: 'primary',
            weight: topic === tA ? 0.7 : 0.4,
          })
          .execute();
        for (const payload of [first, twin])
          expect(await projected.projectActivity(payload)).toMatchObject({
            kind: 'skipped',
            reason: 'already_applied',
          });
        expect(await topics()).toEqual(initial);
        expect(await revisions()).toEqual(originalRevisions);
        expect(await heads()).toEqual(originalHeads);
      }
      await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', asset.assetId).execute();
      await database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: asset.assetId, asset_revision: 1, topic_id: tB, role: 'primary', weight: 0.4 })
        .execute();
      const fresh = await attributedEncounter(),
        withB = await topics();
      expect(withB.find((t) => t.topic_id === tA)).toEqual(initial.find((t) => t.topic_id === tA));
      expect(withB.find((t) => t.topic_id === tB)).toMatchObject({ scroll_measured: 1 });
      expect(withB.find((t) => t.topic_id === tB)!.activity).toBeGreaterThan(0);
      expect(
        await database.db
          .selectFrom('personal_context.topics')
          .select(['topic_id', 'qualified_units'])
          .where('universe_id', '=', p.universeId)
          .where('topic_id', 'in', [tA, tB])
          .execute(),
      ).toEqual(
        expect.arrayContaining([
          { topic_id: tA, qualified_units: 1 },
          { topic_id: tB, qualified_units: 1 },
        ]),
      );
      expect(await projected.projectActivity(fresh)).toMatchObject({ kind: 'skipped', reason: 'already_applied' });
      const qualifications = await database.db
        .selectFrom('evidence.encounter_evidence')
        .select(['exposure_id', 'revision'])
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(qualifications).toHaveLength(3);
      expect(qualifications).toEqual(
        expect.arrayContaining(
          [first, twin, fresh].map((payload) => ({ exposure_id: payload.exposureId, revision: 1 })),
        ),
      );
      await expect(
        database.db
          .updateTable('evidence.activity_revisions')
          .set({ activity: 0 })
          .where('id', '=', originalRevisions[0]!.id)
          .execute(),
      ).rejects.toThrow('ACTIVITY_REVISION_IMMUTABLE');
    } finally {
      await projected.close();
    }
  });

  it('rolls the private receipt and every session/offer/decision effect back when completion fails', async () => {
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c),
      command = { ...discovery(), target: { kind: 'return' as const, assetId: a.assetId, assetRevision: 1 } };
    await sql`create function receipts.ci_fail_navigation_receipt() returns trigger language plpgsql as $$ begin raise exception 'CI_RECEIPT_WRITE_FAILURE'; end $$`.execute(
      database.db,
    );
    await sql`create trigger ci_fail_navigation_receipt before update of outcome on receipts.personal_commands for each row execute function receipts.ci_fail_navigation_receipt()`.execute(
      database.db,
    );
    try {
      await expect(c.navigate(p.authority, command)).rejects.toThrow('CI_RECEIPT_WRITE_FAILURE');
    } finally {
      await sql`drop trigger ci_fail_navigation_receipt on receipts.personal_commands`.execute(database.db);
      await sql`drop function receipts.ci_fail_navigation_receipt()`.execute(database.db);
    }
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db.selectFrom('experience.sessions').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db.selectFrom('experience.offers').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db.selectFrom('composer.decisions').selectAll().where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(ready(await c.navigate(p.authority, command)).replayed).toBe(false);
  });
  it('keeps paused navigation/activation necessary, preserves original disposition through replay and does not revive H/R', async () => {
    const p = await seedPerson(database.db);
    await fixtureAsset(c);
    await sql`update identity.universes set recording_on=false,recording_generation=2 where id=${p.universeId}::uuid`.execute(
      database.db,
    );
    const request = { ...discovery(), recordingGeneration: 2 };
    const selected = ready(await c.navigate(p.authority, request));
    const command = { ...activation(selected), recordingGeneration: 2 };
    const first = await c.activateOffer(p.authority, command);
    expect(first).toMatchObject({ kind: 'accepted', outcome: { replayed: false } });
    const origin = await sql<{
      eligible_generation: number | null;
    }>`select eligible_generation from experience.recording_offer_origins where universe_id=${p.universeId}::uuid and offer_id=${selected.offer.offerId}::uuid`.execute(
      database.db,
    );
    expect(origin.rows[0]?.eligible_generation).toBeNull();
    const flags = await database.db
      .selectFrom('experience.encounter_activity_inputs')
      .select(['horizontal', 'returned'])
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(flags.every((x) => !x.horizontal && !x.returned)).toBe(true);
    await sql`update identity.universes set recording_on=true,recording_generation=3 where id=${p.universeId}::uuid`.execute(
      database.db,
    );
    expect(await c.activateOffer(p.authority, command)).toMatchObject({
      kind: 'accepted',
      outcome: { replayed: true },
    });
    expect(await c.activateOffer(p.authority, { ...command, recordingGeneration: 3 })).toMatchObject({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    const durable = await sql<{
      n: number;
    }>`select count(*)::int as n from evidence.recording_sessions where universe_id=${p.universeId}::uuid`.execute(
      database.db,
    );
    expect(durable.rows[0]?.n).toBe(0);
    const jobs = await sql<{
      n: number;
    }>`select count(*)::int as n from pgboss.job where name='evidence.project-encounter-activity' and data->>'universeId'=${p.universeId}`.execute(
      database.db,
    );
    expect(jobs.rows[0]?.n).toBe(0);
  });
  it('installs the fresh-schema cross-generation routing indexes with actual-activation predicates', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }>`select indexname,indexdef from pg_indexes
      where schemaname='experience' and tablename='recording_segments'
      and indexname in('recording_routing_recent','recording_routing_unit','recording_routing_facets') order by indexname`.execute(
      database.db,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      'recording_routing_facets',
      'recording_routing_recent',
      'recording_routing_unit',
    ]);
    for (const row of indexes.rows) expect(row.indexdef).toContain('WHERE (first_eligible_activation_at IS NOT NULL)');
    expect(indexes.rows[0]?.indexdef).toContain('USING gin');
    expect(indexes.rows[0]?.indexdef).toContain("attribution_payload -> 'facets'::text");
    expect(indexes.rows[0]?.indexdef).toContain('jsonb_path_ops');
    expect(indexes.rows[1]?.indexdef).toContain(
      '(universe_id, privacy_epoch, first_eligible_activation_at DESC, exposure_id, recording_generation)',
    );
    expect(indexes.rows[2]?.indexdef).toContain(
      '(universe_id, privacy_epoch, explanation_unit_id, first_eligible_activation_at DESC, exposure_id, recording_generation)',
    );
  });
  it('reads actual recording encounters without qualification, preserves old generations while paused, and excludes correction-only descriptors', async () => {
    const p = await recordingPerson(database),
      a = await fixtureAsset(current),
      facet = `ci.routing.${randomUUID()}`;
    // Authored Content metadata precedes actual encounter attribution; this is not evidence.
    await database.db
      .updateTable('content.discovery_revisions')
      .set({ facets: [facet] })
      .where('asset_id', '=', a.assetId)
      .where('asset_revision', '=', a.assetRevision)
      .execute();
    const x = await openActive(current, p, { assetId: a.assetId, revision: a.assetRevision });
    const query = {
      evaluatedAt: new Date(Date.now() + 60000).toISOString(),
      topicIds: [],
      candidates: [
        { explanationUnitId: a.unit, facets: [] },
        { explanationUnitId: `unseen-${randomUUID()}`, facets: [facet] },
      ],
      candidateAssetIds: [],
    };
    const scoped = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const read = async () => {
      const result = await scoped(p.authority, (scope) => current.readPrepared(scope, query));
      if (result.kind !== 'entered' || !result.value?.established) throw new Error('CI routing scope refused');
      return { ...result.value, established: result.value.established };
    };
    const first = await read();
    expect(first.recent).toEqual([
      expect.objectContaining({ exposureId: x.exposureId, explanationUnitId: a.unit, facets: [facet] }),
    ]);
    expect(first.established.units).toEqual([
      { explanationUnitId: a.unit, encountered: true, facets: [] },
      {
        explanationUnitId: query.candidates[1]!.explanationUnitId,
        encountered: false,
        facets: [{ facetId: facet, encountered: true }],
      },
    ]);
    expect(
      await database.db
        .selectFrom('experience.encounter_lineage')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('evidence.encounter_evidence')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('personal_context.recording_exposure_contributions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    const target = { assetId: a.assetId, assetRevision: a.assetRevision };
    expect(
      await current.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target,
        exposureId: x.exposureId,
        recordingGeneration: 1,
      }),
    ).toMatchObject({ kind: 'applied' });
    const toggle = async (g: number, on: boolean) => {
      expect(
        await recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(p.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration: g,
          on,
        }),
      ).toMatchObject({ kind: 'ok' });
    };
    await toggle(1, false);
    expect((await read()).recent).toEqual(first.recent);
    const paused = await current.openExposure(p.authority, {
      commandId: randomUUID(),
      target: { kind: 'scroll', assetId: a.assetId },
      origin: { kind: 'direct' },
      capabilities: textCapabilities,
    });
    if (paused.kind !== 'opened') throw new Error('CI paused open refused');
    expect(
      await current.activateExposure(p.authority, {
        commandId: randomUUID(),
        exposureId: paused.outcome.exposureId,
        recordingGeneration: 2,
      }),
    ).toMatchObject({ kind: 'activated' });
    expect((await read()).recent).toEqual(first.recent);
    await toggle(2, true);
    expect(
      await current.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'unsave',
        target,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'applied' });
    const correction = await database.db
      .selectFrom('experience.recording_segments')
      .select(['first_eligible_activation_at', 'first_eligible_activation_command_id'])
      .where('universe_id', '=', p.universeId)
      .where('exposure_id', '=', x.exposureId)
      .where('recording_generation', '=', 3)
      .executeTakeFirstOrThrow();
    expect(correction).toEqual({ first_eligible_activation_at: null, first_eligible_activation_command_id: null });
    expect((await read()).recent).toEqual(first.recent);
    // A genuinely new eligible activation, not the correction, adds the paused exposure at g3.
    expect(
      await current.activateExposure(p.authority, {
        commandId: randomUUID(),
        exposureId: paused.outcome.exposureId,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'activated' });
    expect((await read()).recent.map((r) => r.exposureId).sort()).toEqual(
      [x.exposureId, paused.outcome.exposureId].sort(),
    );
    const other = await recordingPerson(database);
    expect(await scoped(other.authority, (scope) => current.readPrepared(scope, query))).toMatchObject({
      kind: 'entered',
      value: {
        recent: [],
        established: { units: [{ encountered: false }, { encountered: false, facets: [{ encountered: false }] }] },
      },
    });
    const historical = await read();
    expect(historical.recent).toHaveLength(2);
    expect(
      await scoped(p.authority, (scope) =>
        current.readPrepared(scope, { ...query, evaluatedAt: new Date(Date.now() + 25 * 3600000).toISOString() }),
      ),
    ).toMatchObject({
      kind: 'entered',
      value: {
        recent: [],
        established: { units: [{ encountered: true }, { encountered: false, facets: [{ encountered: true }] }] },
      },
    });
    expect(
      await scoped(p.authority, (scope) =>
        current.readPrepared(scope, { ...query, evaluatedAt: new Date(0).toISOString() }),
      ),
    ).toMatchObject({
      kind: 'entered',
      value: { recent: [], established: { units: [{ encountered: false }, { encountered: false }] } },
    });
  });
  it('caps the raw recording lane before exposure deduplication without refilling older encounters', async () => {
    const p = await recordingPerson(database),
      a = await fixtureAsset(current);
    const old = await openActive(current, p, { assetId: a.assetId, revision: a.assetRevision });
    const repeated = await openActive(current, p, { assetId: a.assetId, revision: a.assetRevision });
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (let g = 1; g < 41; g += 2) {
      for (const [expected, on] of [
        [g, false],
        [g + 1, true],
      ] as const)
        expect(
          await policy.set(p.authority, {
            version: 'recording-policy.v1',
            commandId: randomUUID(),
            expectedPrivacyEpoch: 1,
            expectedRecordingGeneration: expected,
            on,
          }),
        ).toMatchObject({ kind: 'ok' });
      expect(
        await current.activateExposure(p.authority, {
          commandId: randomUUID(),
          exposureId: repeated.exposureId,
          recordingGeneration: g + 2,
        }),
      ).toMatchObject({ kind: 'activated' });
    }
    const rows = await database.db
      .selectFrom('experience.recording_segments')
      .select(['exposure_id', 'recording_generation'])
      .where('universe_id', '=', p.universeId)
      .where('first_eligible_activation_at', 'is not', null)
      .orderBy('first_eligible_activation_at', 'desc')
      .orderBy('exposure_id')
      .orderBy('recording_generation')
      .execute();
    expect(rows).toHaveLength(22);
    expect(rows.slice(0, 20).every((r) => r.exposure_id === repeated.exposureId)).toBe(true);
    const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
      current.readPrepared(scope, {
        evaluatedAt: new Date(Date.now() + 60000).toISOString(),
        topicIds: [],
        candidates: [{ explanationUnitId: a.unit, facets: [] }],
        candidateAssetIds: [],
      }),
    );
    expect(result).toMatchObject({
      kind: 'entered',
      value: { recent: [{ exposureId: repeated.exposureId }], established: { units: [{ encountered: true }] } },
    });
    if (result.kind !== 'entered' || !result.value?.established) throw new Error('CI routing scope refused');
    expect(result.value.recent).toHaveLength(1);
    expect(result.value.recent.some((r) => r.exposureId === old.exposureId)).toBe(false);
    expect(
      await database.db
        .selectFrom('experience.encounter_lineage')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
  });
  it('merges the two actual initial1 routing lanes, deduplicates a repeated exposure and returns at most20', async () => {
    // Explicit legacy compatibility account, not a fabricated fresh lifecycle witness.
    const p = await seedPerson(database.db),
      a = await fixtureAsset(c),
      exposures: string[] = [];
    for (let n = 0; n < 21; n++)
      exposures.push((await openActive(c, p, { assetId: a.assetId, revision: a.assetRevision })).exposureId);
    for (const exposureId of [exposures[0]!, exposures[20]!])
      expect(
        await current.activateExposure(p.authority, { commandId: randomUUID(), exposureId, recordingGeneration: 1 }),
      ).toMatchObject({ kind: 'activated' });
    const added = await openActive(current, p, { assetId: a.assetId, revision: a.assetRevision });
    expect(
      await database.db
        .selectFrom('experience.encounter_lineage')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(21);
    expect(
      await database.db
        .selectFrom('experience.recording_segments')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(3);
    const result = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
      current.readPrepared(scope, {
        evaluatedAt: new Date(Date.now() + 60000).toISOString(),
        topicIds: [],
        candidates: [{ explanationUnitId: a.unit, facets: [] }],
        candidateAssetIds: [],
      }),
    );
    if (result.kind !== 'entered' || !result.value?.established) throw new Error('CI routing scope refused');
    expect(result.value.recent).toHaveLength(20);
    const ids = result.value.recent.map((r) => r.exposureId);
    expect(new Set(ids).size).toBe(20);
    expect(ids).toContain(added.exposureId);
    expect(ids).toContain(exposures[0]);
    expect(ids.filter((id) => id === exposures[20])).toHaveLength(1);
    expect(result.value.established.units).toMatchObject([{ encountered: true }]);
    expect(
      await database.db
        .selectFrom('evidence.encounter_evidence')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
  });
});
