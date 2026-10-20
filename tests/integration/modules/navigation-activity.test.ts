import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { fixtureComposerSnapshot } from '../support/composer.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { admitContinuity, makeAdmissionStore } from '@knowscroll/backend/modules/content/nest-providers';
import { activatedAgo, coverage, dwell, event } from '../support/observations.js';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { type NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
function ready(result: Awaited<ReturnType<Cases['navigate']>>): Extract<NavigationOutcome, { status: 'ready' }> {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}
async function fixtureAsset(c: Cases, unit = `fixture.nav.${randomUUID()}`) {
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
  let database: TestDatabase<Database>, c: Cases;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('navigation_activity');
    c = await scrollUseCases(database);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  it('creates offers without encounters; concurrent same-key commands replay one committed decision and activation binds one exposure', async () => {
    const p = await seedPerson(database.db);
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
      .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 16 * 60000) })
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
    const p = await seedPerson(database.db),
      asset = await fixtureAsset(c);
    const open = ready(
      await c.navigate(p.authority, {
        ...discovery(),
        target: { kind: 'return', assetId: asset.assetId, assetRevision: asset.assetRevision },
      }),
    );
    await database.db
      .updateTable('experience.offers')
      .set({ expires_at: new Date(Date.now() - 1000), created_at: new Date(Date.now() - 16 * 60000) })
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
  it('replaces late qualification/action/attribution deltas, excludes unknown Q/O, preserves topic weight bounds and scoped candidate Hide', async () => {
    const p = await seedPerson(database.db),
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
    await c.projectActivity(payload);
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
});
