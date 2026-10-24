import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  contentProviders,
  lockCurrentEncounters,
  readExactEncounter,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  experienceEvidenceReadProviders,
  checkRequestSource,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { produceScrollQueue, SCROLL_PRODUCTION_VERSION } from '@knowscroll/backend/modules/content';
import { READ_EXPLORATION_SNAPSHOT } from '@knowscroll/backend/modules/personal-context';
import {
  CREATE_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  CANCEL_CONTENT_REQUEST,
  RESOLVE_CONTENT_REQUEST,
  resolveSupplyQueue,
  type CreateRequest,
  type ReadRequest,
  type CancelRequest,
  type ResolveRequest,
} from '@knowscroll/backend/modules/supply';
import {
  supplyProviders,
  SUPPLY_PORTS,
  makeCreateRequest,
  type SupplyPorts,
} from '@knowscroll/backend/modules/supply/nest-providers';
import { buildFromProviders } from '../support/providers.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';

/** CI fixtures only: actual PostgreSQL/pg-boss/admission/receipts, no provider or live content. */
describe('Supply private demand foundation (real PostgreSQL, authored CI content)', () => {
  let database: TestDatabase<Database>, content: Awaited<ReturnType<typeof scrollUseCases>>;
  let create: CreateRequest, read: ReadRequest, cancel: CancelRequest, resolve: ResolveRequest, ports: SupplyPorts;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply');
    content = await scrollUseCases(database);
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue'),
      CONFIG = Symbol('config');
    const providers = supplyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE, config: CONFIG });
    const values = new Map<symbol, unknown>([
      [SCOPE, withScope()],
      [ENQUEUE, makeEnqueueJob(content.boss)],
      [CONFIG, { supplyCreateDailyCap: 50, supplyPlannerCreateDailyCap: 5 }],
      [READ_EXPLORATION_SNAPSHOT, content.readExploration],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
      ...contentProviders().map((p) => [p.provide, p.useValue] as const),
      ...experienceEvidenceReadProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      const value = buildFromProviders(providers, token, values);
      values.set(token, value);
      return value as T;
    };
    ports = get<SupplyPorts>(SUPPLY_PORTS);
    create = get(CREATE_CONTENT_REQUEST);
    read = get(READ_CONTENT_REQUEST);
    cancel = get(CANCEL_CONTENT_REQUEST);
    resolve = get(RESOLVE_CONTENT_REQUEST);
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });
  function catalogue(topicId = 'earth.seasons', format: 'reel' | 'scroll' | 'either' = 'scroll'): CreateContentRequest {
    return {
      version: 'content-request.v1',
      commandId: randomUUID(),
      intent: {
        kind: 'topic',
        subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId },
        format,
      },
      language: 'en',
      capabilities,
    };
  }
  async function ask(p: FixturePerson, c: CreateContentRequest) {
    const r = await create(p.authority, c);
    if (r.kind !== 'ok') throw new Error(`CI fixture request refused: ${r.reason}`);
    return r.value;
  }
  async function status(p: FixturePerson, requestId: string) {
    const r = await read(p.authority, { requestId });
    if (r.kind !== 'ok') throw new Error('CI status refused');
    return r.value;
  }
  const job = (p: FixturePerson, requestId: string) => ({
    v: 1 as const,
    universeId: p.universeId,
    privacyEpoch: 1,
    requestId,
  });
  async function jobs(p: FixturePerson) {
    return (
      await sql<{
        data: unknown;
      }>`select data from pgboss.job where name=${resolveSupplyQueue.name} and data->>'universeId'=${p.universeId}`.execute(
        database.db,
      )
    ).rows;
  }
  async function produceJobs() {
    return (
      await sql<{ id: string }>`select id from pgboss.job where name=${produceScrollQueue.name}`.execute(database.db)
    ).rows;
  }
  async function admit(topicId = 'earth.greenhouse-effect') {
    const source = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    source.draft.title = 'Authored CI Supply fixture';
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-supply-${randomUUID()}`;
    const r = await content.importScroll(source);
    if (r.kind !== 'imported') throw new Error('CI fixture admission refused');
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: r.assetId, asset_revision: r.revision, topic_id: topicId, role: 'primary', weight: 1 })
      .execute();
    return { assetId: r.assetId, assetRevision: r.revision };
  }
  async function source(p: FixturePerson, asset: { assetId: string; assetRevision: number }) {
    const opened = await content.openExposure(p.authority, {
      commandId: randomUUID(),
      target: { kind: 'scroll', assetId: asset.assetId },
      origin: { kind: 'direct' },
      capabilities,
    });
    if (opened.kind !== 'opened') throw new Error('CI open refused');
    const activated = await content.activateExposure(p.authority, {
      commandId: randomUUID(),
      exposureId: opened.outcome.exposureId,
    });
    if (activated.kind !== 'activated') throw new Error('CI activation refused');
    return { ...asset, exposureId: opened.outcome.exposureId };
  }
  it('concurrent identical public keys create one active work and private waiters; cancel removes only its waiter', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db);
    const ca = catalogue('earth.tides', 'scroll'),
      cb = { ...ca, commandId: randomUUID() };
    const [ar, br] = await Promise.all([ask(a, ca), ask(b, cb)]);
    const requests = await database.db
      .selectFrom('supply.requests')
      .selectAll()
      .where('id', 'in', [ar.requestId, br.requestId])
      .execute();
    expect(new Set(requests.map((r) => r.work_id)).size).toBe(1);
    expect(requests.map((r) => r.decision).sort()).toEqual(['create', 'join']);
    const work = await database.db
      .selectFrom('supply.work')
      .selectAll()
      .where('id', '=', requests[0]!.work_id!)
      .executeTakeFirstOrThrow();
    expect(work.active).toBe(true);
    // Create started the group's one production job; the other person joined it.
    expect(work.production_recipe).toBe('tides');
    expect(await produceJobs()).toHaveLength(1);
    expect(JSON.stringify(work)).not.toContain(a.universeId);
    expect(JSON.stringify(work)).not.toContain(b.universeId);
    expect(await jobs(a)).toEqual([{ data: job(a, ar.requestId) }]);
    expect(await jobs(b)).toEqual([{ data: job(b, br.requestId) }]);
    expect(await read(b.authority, { requestId: ar.requestId })).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(
      await cancel(b.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: ar.requestId,
      }),
    ).toEqual({ kind: 'refused', reason: 'not_found' });
    const cancellation = {
      version: 'content-request-cancel.v1' as const,
      commandId: randomUUID(),
      requestId: ar.requestId,
    };
    const first = await cancel(a.authority, cancellation);
    expect(first).toMatchObject({ kind: 'ok', value: { outcome: 'cancelled' } });
    expect(await cancel(a.authority, cancellation)).toEqual(
      first.kind === 'ok' ? { kind: 'ok', value: { ...first.value, replayed: true } } : first,
    );
    expect(await cancel(a.authority, { ...cancellation, commandId: randomUUID() })).toMatchObject({
      kind: 'ok',
      value: { outcome: 'already_cancelled' },
    });
    await resolve(job(a, ar.requestId));
    expect((await status(a, ar.requestId)).status).toBe('cancelled');
    expect(await status(b, br.requestId)).toMatchObject({ status: 'preparing', phase: 'preparing' });
    // The production has not started: the waiter keeps waiting and changes nothing.
    await resolve(job(b, br.requestId));
    await resolve(job(b, br.requestId));
    expect(await status(b, br.requestId)).toMatchObject({ status: 'preparing', requestRevision: 1 });
    // Its production ended without a Scroll (a terminal job at this recipe version): the waiter closes honestly.
    await database.db
      .insertInto('content.scroll_production_runs')
      .values({
        id: randomUUID(),
        topic: 'tides',
        policy_version: SCROLL_PRODUCTION_VERSION,
        target_revision: 1,
        scope_generation: 1,
        state: 'rejected',
        writer_run_id: randomUUID(),
        completed_at: new Date(),
      })
      .execute();
    await resolve(job(b, br.requestId));
    expect(await status(b, br.requestId)).toMatchObject({
      status: 'unavailable',
      reason: 'could_not_prepare',
      requestRevision: 2,
    });
    expect(await database.db.selectFrom('reasoning.external_attempts').select('id').execute()).toHaveLength(0);
    expect(await ask(a, ca)).toEqual({ ...ar, replayed: true });
  });
  it('same-person concurrent retry retains one private ID/original receipt and conflicts on different input', async () => {
    const p = await seedPerson(database.db),
      c = catalogue('earth.seasons', 'scroll');
    const [a, b] = await Promise.all([ask(p, c), ask(p, c)]);
    expect(a.requestId).toBe(b.requestId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect({ ...a, replayed: false }).toEqual({ ...b, replayed: false });
    expect(await create(p.authority, { ...c, language: 'fr' })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    expect(await jobs(p)).toHaveLength(1);
  });
  it('closes unsupported asks at once and keeps a free-text ask private while it waits for its catalogue match', async () => {
    const p = await seedPerson(database.db);
    const text = (subjectText: string, overrides: Partial<CreateContentRequest> = {}): CreateContentRequest => ({
      ...catalogue(),
      intent: { kind: 'topic', subject: { kind: 'text', text: subjectText }, format: 'scroll' },
      ...overrides,
    });
    const before = await database.db.selectFrom('supply.work').select('id').execute();
    const producedBefore = await produceJobs();

    // A free-text ask waits as `matching`: no brief, no shared group, one resolver job and no production.
    const words = 'CI private ask that must never become a public brief';
    const free = await ask(p, text(words));
    expect(await status(p, free.requestId)).toMatchObject({ status: 'preparing', phase: 'requested' });
    expect(
      await database.db
        .selectFrom('supply.requests')
        .select(['state', 'decision', 'brief', 'work_id'])
        .where('id', '=', free.requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'matching', decision: 'pending', brief: null, work_id: null });
    expect(await jobs(p)).toEqual([{ data: job(p, free.requestId) }]);
    expect(await produceJobs()).toEqual(producedBefore);
    // Without a model the worker leaves it waiting: resolving changes nothing.
    await resolve(job(p, free.requestId));
    expect(await status(p, free.requestId)).toMatchObject({ status: 'preparing', requestRevision: 1 });
    // It can be cancelled while it waits, and then stays cancelled.
    expect(
      await cancel(p.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: free.requestId,
      }),
    ).toMatchObject({ kind: 'ok', value: { outcome: 'cancelled' } });
    await resolve(job(p, free.requestId));
    expect((await status(p, free.requestId)).status).toBe('cancelled');

    // Asks that no match can serve are closed on the spot, with no shared key and no queued work.
    // A free-text ask about this encounter carries meaning the catalogue match cannot admit.
    const contextRef = await source(p, await admit('earth.seasons'));
    const contextual = await ask(p, {
      ...text('More like this one'),
      intent: {
        kind: 'topic',
        subject: { kind: 'text', text: 'More like this one' },
        format: 'scroll',
        context: contextRef,
      },
    });
    const unknown = await ask(p, catalogue('not.a.catalogue.member'));
    const french = await ask(p, { ...text('Pourquoi le ciel est bleu'), language: 'fr' });
    for (const r of [contextual, unknown, french])
      expect(await status(p, r.requestId)).toMatchObject({ status: 'unavailable', reason: 'unsupported_request' });
    expect(await jobs(p)).toHaveLength(1);
    expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual(before);
  });
  it('reuses exact current eligible catalogue content, never evidence; receipt remains accepted as status changes', async () => {
    const asset = await admit(),
      p = await seedPerson(database.db),
      c = catalogue('earth.greenhouse-effect');
    const r = await ask(p, c),
      s = await status(p, r.requestId);
    expect(s).toMatchObject({ status: 'ready', content: asset, requestRevision: 1 });
    expect(await jobs(p)).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('experience.exposures')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    const before = (
      await database.db
        .selectFrom('content.assets')
        .select('availability_revision')
        .where('id', '=', asset.assetId)
        .executeTakeFirstOrThrow()
    ).availability_revision;
    await database.db
      .updateTable('content.assets')
      .set({ status: 'admitted', availability_revision: 99 })
      .where('id', '=', asset.assetId)
      .execute();
    expect(
      (
        await database.db
          .selectFrom('content.assets')
          .select('availability_revision')
          .where('id', '=', asset.assetId)
          .executeTakeFirstOrThrow()
      ).availability_revision,
    ).toBe(before);
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', asset.assetId)
      .execute();
    const withdrawn = await status(p, r.requestId);
    expect(withdrawn).toMatchObject({ status: 'unavailable', reason: 'source_unavailable', requestRevision: 2 });
    expect(await status(p, r.requestId)).toEqual(withdrawn);
    expect(await ask(p, c)).toEqual({ ...r, replayed: true });
    await database.db
      .updateTable('content.assets')
      .set({ status: 'admitted' })
      .where('id', '=', asset.assetId)
      .execute();
    expect(await status(p, r.requestId)).toMatchObject({ status: 'ready', content: asset, requestRevision: 3 });
    const closed = await cancel(p.authority, {
      version: 'content-request-cancel.v1',
      commandId: randomUUID(),
      requestId: r.requestId,
    });
    expect(closed).toMatchObject({ kind: 'ok', value: { outcome: 'already_closed' } });
    expect(await ask(p, c)).toEqual({ ...r, replayed: true });
    expect(await jobs(p)).toHaveLength(0);
  });
  it('queue failure rolls back shared work, its production job, private demand, receipt and personal watermark together', async () => {
    const p = await seedPerson(database.db),
      c = catalogue('space.stars', 'scroll');
    const producedBefore = await produceJobs();
    const before = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const fail = makeCreateRequest({
      ...ports,
      enqueue: async (s, id) => {
        await ports.enqueue(s, id);
        throw new Error('CI injected failure after real pg-boss insert');
      },
    });
    await expect(fail(p.authority, c)).rejects.toThrow('CI injected failure');
    expect(
      await database.db.selectFrom('supply.requests').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toHaveLength(0);
    expect(await jobs(p)).toHaveLength(0);
    expect(await produceJobs()).toEqual(producedBefore);
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    const work = await database.db
      .selectFrom('supply.work')
      .select('id')
      .where(sql<boolean>`brief->'subject'->>'topicId'='space.stars'`)
      .execute();
    expect(work).toHaveLength(0);
  });
  it('variant source requires own exact activated encounter and optional latest session; a missing variant has no production path and closes at once', async () => {
    const asset = await admit('earth.seasons'),
      p = await seedPerson(database.db),
      other = await seedPerson(database.db);
    const ref = await source(p, asset);
    const c: CreateContentRequest = { ...catalogue(), intent: { kind: 'variant', source: ref, to: 'reel' } };
    expect(await create(other.authority, c)).toEqual({ kind: 'refused', reason: 'stale_source' });
    expect(
      await create(p.authority, {
        ...c,
        intent: {
          kind: 'variant',
          source: { ...ref, session: { sessionId: randomUUID(), expectedIntentRevision: 0 } },
          to: 'reel',
        },
      }),
    ).toEqual({ kind: 'refused', reason: 'stale_source' });
    const workBefore = await database.db.selectFrom('supply.work').select('id').execute();
    const r = await ask(p, c);
    // Only a Scroll of a catalogue meaning can be produced, so the answer is honest straight away.
    expect(await status(p, r.requestId)).toMatchObject({
      status: 'unavailable',
      reason: 'budget_unavailable',
      requestRevision: 1,
    });
    expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual(workBefore);
    expect(await jobs(p)).toHaveLength(0);
    expect(await ask(p, c)).toEqual({ ...r, replayed: true });

    // Withdrawing the source later keeps the closed ask closed, and a cancel finds nothing open.
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', asset.assetId)
      .execute();
    expect(await status(p, r.requestId)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
    expect(
      await cancel(p.authority, {
        version: 'content-request-cancel.v1',
        commandId: randomUUID(),
        requestId: r.requestId,
      }),
    ).toMatchObject({ kind: 'ok', value: { outcome: 'already_closed' } });
    await database.db
      .updateTable('content.assets')
      .set({ status: 'admitted' })
      .where('id', '=', asset.assetId)
      .execute();
    expect(await read(other.authority, { requestId: r.requestId })).toEqual({ kind: 'refused', reason: 'not_found' });
  });
  it('session authority accepts actual activated membership, refuses stale intent, and keeps an accepted ask independent of later navigation', async () => {
    const p = await seedPerson(database.db);
    await admit('earth.seasons');
    const opened = await content.navigate(p.authority, {
      commandId: randomUUID(),
      target: { kind: 'discover' },
      capabilities,
    });
    if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready') throw new Error('CI discovery refused');
    const o = opened.outcome;
    const activation = await content.activateOffer(p.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: o.sessionId,
        offerId: o.offer.offerId,
        expectedIntentRevision: o.intentRevision,
      },
    });
    if (activation.kind !== 'accepted') throw new Error('CI offer activation refused');
    const ref = {
      assetId: o.offer.assetId,
      assetRevision: o.offer.assetRevision,
      exposureId: activation.outcome.exposureId,
      session: { sessionId: o.sessionId, expectedIntentRevision: o.intentRevision },
    };
    const c: CreateContentRequest = { ...catalogue(), intent: { kind: 'variant', source: ref, to: 'reel' } };
    const accepted = await ask(p, c);
    const advanced = await content.navigate(p.authority, {
      commandId: randomUUID(),
      sessionId: o.sessionId,
      expectedIntentRevision: o.intentRevision,
      from: { offerId: o.offer.offerId, exposureId: ref.exposureId },
      intent: { mode: 'vertical', direction: 'next' },
    });
    expect(advanced.kind).toBe('accepted');
    expect(await create(p.authority, { ...c, commandId: randomUUID() })).toEqual({
      kind: 'refused',
      reason: 'stale_source',
    });
    expect(await ask(p, c)).toEqual({ ...accepted, replayed: true });
    expect(await status(p, accepted.requestId)).toMatchObject({ status: 'unavailable', reason: 'budget_unavailable' });
  });
  it('worker independently fences reset, account revocation and erased private bindings; shared briefs survive', async () => {
    const p = await seedPerson(database.db),
      r = await ask(p, catalogue('space.black-holes', 'scroll'));
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', p.universeId)
      .execute();
    await resolve(job(p, r.requestId));
    expect(await read(p.authority, { requestId: r.requestId })).toEqual({ kind: 'refused', reason: 'scope_refused' });
    const authority = { ...p.authority, privacyEpoch: 2 };
    expect(await read(authority, { requestId: r.requestId })).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(
      await create(authority, {
        ...catalogue('space.black-holes', 'scroll'),
        commandId: (
          await database.db
            .selectFrom('receipts.personal_commands')
            .select('command_id')
            .where('universe_id', '=', p.universeId)
            .executeTakeFirstOrThrow()
        ).command_id,
      }),
    ).toMatchObject({ kind: 'refused' });
    const before = await database.db.selectFrom('supply.work').select('id').execute();
    await withScope()(authority, (s) => eraseUniverse(s, personalStores));
    await resolve({ ...job(p, r.requestId), privacyEpoch: 2 });
    expect(await jobs(p)).toHaveLength(0);
    expect(
      await database.db.selectFrom('supply.requests').select('id').where('universe_id', '=', p.universeId).execute(),
    ).toHaveLength(0);
    expect(await database.db.selectFrom('supply.work').select('id').execute()).toEqual(before);
    const suspended = await seedPerson(database.db),
      pending = await ask(suspended, catalogue('space.exoplanets', 'scroll'));
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.accountId)
      .execute();
    await resolve(job(suspended, pending.requestId));
    expect(
      (
        await database.db
          .selectFrom('supply.requests')
          .select('state')
          .where('id', '=', pending.requestId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('requested');
  });
  it('current-head authority is separate from historical reads and rechecks withdrawal after SHARE wait', async () => {
    const asset = await admit('earth.seasons'),
      p = await seedPerson(database.db);
    let release!: () => void, locked!: () => void;
    const signal = new Promise<void>((r) => {
        locked = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const withdrawal = database.db.transaction().execute(async (tx) => {
      await tx.updateTable('content.assets').set({ status: 'withdrawn' }).where('id', '=', asset.assetId).execute();
      locked();
      await hold;
    });
    await signal;
    const binding = withScope()(p.authority, (s) => lockCurrentEncounters(s, { refs: [asset], capabilities }));
    try {
      await expect
        .poll(
          async () => {
            const waits = await sql<{
              n: number;
            }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database.db,
            );
            return waits.rows[0]?.n ?? 0;
          },
          { timeout: 4000 },
        )
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    await withdrawal;
    const result = await binding;
    expect(result).toMatchObject({ kind: 'entered', value: [{ ref: asset, availabilityRevision: 2 }] });
    if (result.kind === 'entered') expect(result.value[0]?.encounter).toBeUndefined();
    await database.db
      .updateTable('content.assets')
      .set({ status: 'admitted' })
      .where('id', '=', asset.assetId)
      .execute();
    expect(await withScope()(p.authority, (s) => readExactEncounter(s, { ...asset, capabilities }))).toMatchObject({
      kind: 'entered',
      value: asset,
    });
    const corrected = starterSource() as {
      assetId: string;
      publication: { explanationUnitId: string };
      draft: { title: string };
    };
    corrected.assetId = asset.assetId;
    corrected.publication.explanationUnitId = (
      await database.db
        .selectFrom('content.asset_revisions')
        .select('explanation_unit_id')
        .where('asset_id', '=', asset.assetId)
        .where('revision', '=', asset.assetRevision)
        .executeTakeFirstOrThrow()
    ).explanation_unit_id;
    corrected.draft.title = 'Authored CI corrected Supply fixture';
    expect(await content.importScroll(corrected)).toMatchObject({ kind: 'imported', revision: 2 });
    const oldCurrent = await withScope()(p.authority, (s) => lockCurrentEncounters(s, { refs: [asset], capabilities }));
    expect(oldCurrent).toMatchObject({ kind: 'entered', value: [{ ref: asset, availabilityRevision: 4 }] });
    if (oldCurrent.kind === 'entered') expect(oldCurrent.value[0]?.encounter).toBeUndefined();
    expect(await withScope()(p.authority, (s) => readExactEncounter(s, { ...asset, capabilities }))).toMatchObject({
      kind: 'entered',
      value: asset,
    });
    expect(
      await withScope()(p.authority, (s) => checkRequestSource(s, { ...asset, exposureId: randomUUID() })),
    ).toEqual({ kind: 'entered', value: false });
  });
});
