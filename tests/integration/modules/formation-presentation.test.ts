/** Authored CI Geography commits, real PostgreSQL and normal adapters. Not live formation,
 * provider output, HUMAN approval or proof that an actual client displayed anything. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { UniverseDeltaSchema, type SceneClientCapabilities } from '@knowscroll/contracts';
import {
  makeWithPersonalScope,
  transactionOf,
  advanceScopeRevision,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  createBoss,
  applyQueueDeclarations,
  makeEnqueueJob,
  jobConsumer,
  startConsumers,
  deadLetterQueueName,
} from '@knowscroll/backend/infrastructure/jobs';
import { personalStores, explorationStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse, eraseExploration, checkErasureInventory } from '@knowscroll/backend/infrastructure/erasure';
import { identityScopeOwnerProviders, clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { CHECK_PERSONAL_OWNER_ACTIVE, type CheckPersonalOwnerActive } from '@knowscroll/backend/modules/identity';
import {
  READ_GEOGRAPHY_SCENE_INPUT,
  GEOGRAPHY_APPLIED,
  type ReadGeographySceneInput,
  type GeographyApplied,
} from '@knowscroll/backend/modules/geography';
import { geographyProviders, geographyStore } from '@knowscroll/backend/modules/geography/nest-providers';
import { READ_COVERAGE_INPUTS, READ_TRUSTED_COVERAGE } from '@knowscroll/backend/modules/personal-context';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import {
  projectSceneQueue,
  expireFormationQueue,
  recoverFormationQueue,
  PROJECT_SCENE,
  type ProjectScene,
} from '@knowscroll/backend/modules/scenes';
import {
  sceneAppliedProviders,
  sceneProviders,
  formationPortsFor,
  formationStore,
  formationRecoveryPage,
  makeFormationPresentations,
  type FormationPorts,
} from '@knowscroll/backend/modules/scenes/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const version = 'formation-presentation.v1' as const;
const claim = (transitionId: string) => ({
  version,
  transitionId,
  commandId: randomUUID(),
  attemptNonce: randomUUID(),
});
const waitUntil = async (read: () => Promise<boolean>) => {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('CI_FORMATION_WAIT_TIMEOUT');
};
describe('durable U05 presentation (real PostgreSQL Actions fixtures)', () => {
  let database: TestDatabase<Database>,
    c: Awaited<ReturnType<typeof scrollUseCases>>,
    ports: FormationPorts,
    applied: GeographyApplied,
    project: ProjectScene;
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('formation');
    c = await scrollUseCases(database);
    const installer = createBoss(database.settings, 'install', {
      onError: () => undefined,
      onWarning: () => undefined,
    });
    await installer.start();
    try {
      await applyQueueDeclarations(installer, [
        projectSceneQueue,
        expireFormationQueue,
        recoverFormationQueue,
        clearExplorationQueue,
        recoverClearOperationsQueue,
      ]);
    } finally {
      await installer.stop({ graceful: false });
    }
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue');
    const providers = [
      ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
      ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
      ...sceneProviders({ withPersonalScope: SCOPE }),
    ];
    const values = new Map<symbol, unknown>([
      [SCOPE, scope()],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [READ_TRUSTED_COVERAGE, c.readTrustedCoverage],
      [READ_COVERAGE_INPUTS, buildFromProviders(personalContextProviders(), READ_COVERAGE_INPUTS, new Map())],
      ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
    ]);
    const get = <T>(token: symbol): T => {
      if (values.has(token)) return values.get(token) as T;
      const p = providers.find((p) => p.provide === token);
      if (!p) throw new Error('CI_MISSING_PROVIDER');
      for (const dep of p.inject) get(dep);
      const result = buildFromProviders(providers, token, values);
      values.set(token, result);
      return result as T;
    };
    applied = get(GEOGRAPHY_APPLIED);
    project = get(PROJECT_SCENE);
    ports = formationPortsFor(
      database.db,
      c.boss,
      scope(),
      get<CheckPersonalOwnerActive>(CHECK_PERSONAL_OWNER_ACTIVE),
      get<ReadGeographySceneInput>(READ_GEOGRAPHY_SCENE_INPUT),
    );
  });
  afterAll(async () => {
    await c?.close();
    await database?.drop();
  });
  async function fixture(
    options: {
      person?: FixturePerson;
      at?: Date;
      project?: boolean;
      failAfterRecord?: boolean;
      oldWriter?: boolean;
    } = {},
  ) {
    const p = options.person ?? (await seedPerson(database.db)),
      u = p.universeId,
      e = p.authority.privacyEpoch,
      t = randomUUID(),
      system = randomUUID(),
      star = randomUUID(),
      planet = randomUUID();
    const at = options.at ?? new Date(),
      revision = 1;
    const places = [
      { id: system, kind: 'system' as const, conceptId: 'earth', parentKey: 'universe', parentId: u, label: 'Earth' },
      {
        id: star,
        kind: 'star' as const,
        conceptId: 'earth',
        parentKey: 'system:earth:factual',
        parentId: system,
        label: 'Earth star',
      },
      {
        id: planet,
        kind: 'planet' as const,
        conceptId: 'earth.seasons',
        parentKey: 'system:earth:factual',
        parentId: system,
        label: 'Seasons',
      },
    ];
    const d = UniverseDeltaSchema.parse({
      version: 'universe-delta.v1',
      universeId: u,
      privacyEpoch: e,
      personalWatermark: 1,
      transitionId: t,
      recordedAt: at.toISOString(),
      base: { revision: 0, structureRevision: 0, activityRevision: 0 },
      geography: { revision, structureRevision: revision, activityRevision: 0 },
      operations: places.map((o) => ({
        kind: o.kind === 'system' ? 'create_system' : o.kind === 'star' ? 'establish_star' : 'form_planet',
        object: {
          id: o.id,
          kind: o.kind,
          parent: { kind: o.kind === 'system' ? 'universe' : 'system', id: o.parentId },
          label: o.label,
          truthStatus: 'factual',
          objectRevision: revision,
          originTransitionId: t,
          activity: { availability: 'available', state: 'active' },
        },
      })),
    });
    const job = {
      v: 1 as const,
      universeId: u,
      privacyEpoch: e,
      transitionId: t,
      geography: d.geography,
      personalRevision: 1,
    };
    await scope()(p.authority, async (s) => {
      const tx = transactionOf(s),
        run = randomUUID();
      await tx
        .insertInto('geography.runs')
        .values({ universe_id: u, privacy_epoch: e, id: run, desired_revision: 1, status: 'accepted' })
        .execute();
      for (const o of places)
        await geographyStore.saveObject(
          s,
          {
            id: o.id,
            key: `${o.kind}:${o.conceptId}:factual`,
            kind: o.kind,
            conceptId: o.conceptId,
            parentKey: o.parentKey,
            label: o.label,
            labels: [o.label],
            truthStatus: 'factual',
            objectRevision: 1,
            originTransitionId: t,
            activity: { availability: 'available', state: 'active' },
          },
          ['PRIVATE-FORMATION-SUPPORT-CANARY'],
        );
      await geographyStore.writeDelta(s, run, 'a'.repeat(64), d);
      await geographyStore.writeState(s, { ...(await geographyStore.state(s)), ...d.geography });
      await advanceScopeRevision(s);
      if (options.oldWriter) await makeEnqueueJob(c.boss)(s, projectSceneQueue, job);
      else
        await applied(s, {
          transitionId: t,
          geography: d.geography,
          personalRevision: 1,
          committedCreations: {
            recordedAt: d.recordedAt,
            targets: d.operations.flatMap((op) =>
              'object' in op
                ? [
                    {
                      operation: op.kind,
                      objectId: op.object.id,
                      parentId: op.object.parent.id,
                      kind: op.object.kind,
                      objectRevision: op.object.objectRevision,
                      label: op.object.label,
                      truthStatus: op.object.truthStatus,
                    },
                  ]
                : [],
            ),
          },
        });
      if (options.failAfterRecord) throw new Error('CI_AFTER_RECORD');
    });
    if (options.project !== false) await project(job);
    return { ...p, t, system, star, planet, job };
  }
  const api = () => makeFormationPresentations(ports);
  const read = (p: FixturePerson, t?: string) =>
    api().read(p.authority, {
      version,
      readId: randomUUID(),
      target: t ? { kind: 'transition', transitionId: t } : { kind: 'next' },
      capabilities,
    });
  const row = async (p: FixturePerson, t: string) => {
    const r = await scope()(p.authority, (s) => formationStore.read(s, { kind: 'transition', transitionId: t }));
    if (r.kind !== 'entered') throw new Error('CI_SCOPE_REFUSED');
    return r.value;
  };
  it('same transaction records only real committed targets and closed old project payload; rollback erases both', async () => {
    const p = await fixture(),
      before = await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow();
    const result = await read(p, p.t);
    expect(result).toMatchObject({
      kind: 'accepted',
      value: {
        status: 'available',
        fact: {
          transitionId: p.t,
          sequence: { kind: 'planet', durationMs: 2400, newSystem: { systemId: p.system, starId: p.star } },
        },
        eligibility: { status: 'claimable' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-FORMATION-SUPPORT-CANARY');
    const payload = (
      await database.pool.query<{ data: Record<string, unknown> }>(
        "select data from pgboss.job where name=$1 and data->>'universeId'=$2",
        [projectSceneQueue.name, p.universeId],
      )
    ).rows[0]!.data;
    expect(Object.keys(payload).sort()).toEqual([
      'geography',
      'personalRevision',
      'privacyEpoch',
      'transitionId',
      'universeId',
      'v',
    ]);
    await read(p, p.t);
    expect(
      (
        await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(before.revision);
    const fail = await seedPerson(database.db);
    await expect(fixture({ person: fail, failAfterRecord: true })).rejects.toThrow('CI_AFTER_RECORD');
    expect(
      (
        await database.pool.query<{ n: number }>(
          'select count(*)::int as n from scenes.formation_presentations where universe_id=$1',
          [fail.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await database.pool.query<{ n: number }>(
          'select count(*)::int as n from geography.deltas where universe_id=$1',
          [fail.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
  });
  it('old mixed-version valid creation writer fails its WHOLE transaction at COMMIT without a fact', async () => {
    const p = await seedPerson(database.db);
    await expect(fixture({ person: p, oldWriter: true })).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await database.pool.query<{ n: number }>(
          'select count(*)::int as n from geography.deltas where universe_id=$1',
          [p.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await database.pool.query<{ n: number }>(
          "select count(*)::int as n from pgboss.job where data->>'universeId'=$1",
          [p.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(0);
  });
  it('requires ALL current real manifest targets; pending and stale projection cannot claim', async () => {
    const p = await fixture({ project: false });
    expect(await read(p, p.t)).toMatchObject({
      kind: 'accepted',
      value: { status: 'unavailable', reason: 'projection_pending' },
    });
    expect(await api().claim(p.authority, claim(p.t))).toMatchObject({
      kind: 'accepted',
      value: { receipt: { outcome: 'not_claimed', reason: 'unavailable' }, current: { status: 'final' } },
    });
    // An expired retained delivery is not a pending projection promise.
    await database.pool.query(
      "update pgboss.job set keep_until=pgboss.job_now()-interval '1 second' where name=$1 and data->>'universeId'=$2",
      [projectSceneQueue.name, p.universeId],
    );
    expect(await read(p, p.t)).toMatchObject({
      kind: 'accepted',
      value: { status: 'unavailable', reason: 'temporarily_unavailable' },
    });
    await project(p.job);
    expect(await read(p, p.t)).toMatchObject({ kind: 'accepted', value: { status: 'available' } });
    const state = await database.db
      .selectFrom('scenes.state')
      .select('payload')
      .where('universe_id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    const payload = state.payload as { manifest: { chunks: { objectIds: string[] }[] } };
    payload.manifest.chunks[0]!.objectIds = payload.manifest.chunks[0]!.objectIds.filter((id) => id !== p.planet);
    await database.db
      .updateTable('scenes.state')
      .set({ payload: JSON.stringify(payload) })
      .where('universe_id', '=', p.universeId)
      .execute();
    expect(await api().claim(p.authority, claim(p.t))).toMatchObject({
      kind: 'accepted',
      value: { receipt: { outcome: 'not_claimed' } },
    });
  });
  it('rechecks freshness/active expiry AFTER actual readiness queries, never at an earlier sampled clock', async () => {
    const at = new Date(Date.now() - 299_000),
      p = await fixture({ at });
    let clock = at.getTime() + 299_000;
    const slow = makeFormationPresentations({
      ...ports,
      now: () => new Date(clock),
      scenes: {
        ...ports.scenes,
        chunk: async (...args) => {
          const result = await ports.scenes.chunk(...args);
          clock += 2000;
          return result;
        },
      },
    });
    expect(await slow.claim(p.authority, claim(p.t))).toMatchObject({
      kind: 'accepted',
      value: { receipt: { outcome: 'not_claimed', reason: 'expired' } },
    });
    expect((await row(p, p.t))?.claim).toBeUndefined();
    const freshAt = new Date(Date.now() - 60_000),
      fresh = await fixture({ at: freshAt });
    clock = freshAt.getTime() + 1000;
    let slowRead = false;
    const controlled = makeFormationPresentations({
      ...ports,
      now: () => new Date(clock),
      scenes: {
        ...ports.scenes,
        chunk: async (...args) => {
          const result = await ports.scenes.chunk(...args);
          if (slowRead) clock += 2000;
          return result;
        },
      },
    });
    const q = claim(fresh.t),
      first = await controlled.claim(fresh.authority, q);
    if (first.kind !== 'accepted' || first.value.receipt.outcome !== 'claimed') throw new Error('CI_CLAIM_MISSING');
    clock = Date.parse(first.value.receipt.claim.expiresAt) - 1000;
    slowRead = true;
    expect(await controlled.claim(fresh.authority, q)).toMatchObject({
      kind: 'accepted',
      value: { replayed: true, receipt: first.value.receipt, current: { status: 'final', reason: 'expired' } },
    });
    await controlled.expire({
      v: 1,
      universeId: fresh.universeId,
      privacyEpoch: 1,
      transitionId: fresh.t,
      claimId: first.value.receipt.claim.claimId,
    });
  });
  it('concurrent devices claim once; original unknown retry replays immutable receipt/current status', async () => {
    const p = await fixture(),
      a = claim(p.t),
      b = claim(p.t),
      both = await Promise.all([api().claim(p.authority, a), api().claim(p.authority, b)]);
    const accepted = both.filter((r) => r.kind === 'accepted' && r.value.receipt.outcome === 'claimed');
    expect(accepted).toHaveLength(1);
    const winner = both[0].kind === 'accepted' && both[0].value.receipt.outcome === 'claimed' ? a : b;
    const replay = await api().claim(p.authority, winner);
    expect(replay).toMatchObject({ kind: 'accepted', value: { replayed: true, current: { status: 'active' } } });
    if (replay.kind !== 'accepted') throw new Error('CI_CLAIM_REFUSED');
    expect(replay.value.receipt).toEqual(accepted[0]!.kind === 'accepted' ? accepted[0]!.value.receipt : undefined);
    expect(await api().claim(p.authority, { ...winner, attemptNonce: randomUUID() })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    const jobs = await database.pool.query<{ data: Record<string, unknown> }>(
      "select data from pgboss.job where name=$1 and data->>'universeId'=$2",
      [expireFormationQueue.name, p.universeId],
    );
    expect(jobs.rows).toHaveLength(1);
    if (replay.value.receipt.outcome !== 'claimed') throw new Error('CI_WINNER_MISSING');
    await api().acknowledge(p.authority, {
      version,
      commandId: randomUUID(),
      transitionId: p.t,
      claimId: replay.value.receipt.claim.claimId,
      attemptNonce: winner.attemptNonce,
      disposition: 'skipped',
    });
  });
  it('required expiry-send failure rolls claim, receipt and root back', async () => {
    const p = await fixture(),
      q = claim(p.t),
      broken = makeFormationPresentations({ ...ports, enqueueExpiry: () => Promise.reject(new Error('CI_SEND_FAIL')) });
    await expect(broken.claim(p.authority, q)).rejects.toThrow('CI_SEND_FAIL');
    expect((await row(p, p.t))?.claim).toBeUndefined();
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('command_id', '=', q.commandId)
        .execute(),
    ).toEqual([]);
    const success = await api().claim(p.authority, q);
    expect(success).toMatchObject({ kind: 'accepted', value: { receipt: { outcome: 'claimed' }, replayed: false } });
    if (success.kind !== 'accepted' || success.value.receipt.outcome !== 'claimed') throw new Error('CI_CLAIM_MISSING');
    await api().acknowledge(p.authority, {
      version,
      commandId: randomUUID(),
      transitionId: p.t,
      claimId: success.value.receipt.claim.claimId,
      attemptNonce: q.attemptNonce,
      disposition: 'skipped',
    });
  });
  it('lost ACK replay never renews expiry; delayed shown keeps actual expiry skipped', async () => {
    const at = new Date(Date.now() - 60_000),
      p = await fixture({ at }),
      q = claim(p.t),
      clock = { now: at.getTime() + 1000 };
    const controlled = makeFormationPresentations({ ...ports, now: () => new Date(clock.now) });
    const c = await controlled.claim(p.authority, q);
    if (c.kind !== 'accepted' || c.value.receipt.outcome !== 'claimed') throw new Error('CI_CLAIM_MISSING');
    clock.now += 31_000;
    expect(await controlled.claim(p.authority, q)).toMatchObject({
      kind: 'accepted',
      value: { replayed: true, receipt: c.value.receipt, current: { status: 'final', reason: 'expired' } },
    });
    const ack = {
      version,
      commandId: randomUUID(),
      transitionId: p.t,
      claimId: c.value.receipt.claim.claimId,
      attemptNonce: q.attemptNonce,
      disposition: 'shown' as const,
    };
    const first = await controlled.acknowledge(p.authority, ack);
    expect(first).toMatchObject({
      kind: 'accepted',
      value: { disposition: 'skipped', requestedDisposition: 'shown', outcome: 'already_terminal' },
    });
    expect(await controlled.acknowledge(p.authority, ack)).toMatchObject({
      kind: 'accepted',
      value: { replayed: true, disposition: 'skipped' },
    });
    expect(await controlled.claim(p.authority, claim(p.t))).toMatchObject({
      kind: 'accepted',
      value: { receipt: { outcome: 'not_claimed', reason: 'terminal' } },
    });
    const other = await seedPerson(database.db);
    expect(await api().claim({ ...p.authority, actor: { kind: 'account', accountId: other.accountId } }, q)).toEqual({
      kind: 'refused',
      code: 'UNIVERSE_UNAVAILABLE',
    });
  });
  async function overdue() {
    const at = new Date(Date.now() - 90_000),
      p = await fixture({ at, project: false }),
      claimId = randomUUID();
    await scope()(p.authority, (s) =>
      formationStore.claim(s, p.t, {
        claimId,
        attemptNonce: randomUUID(),
        claimedAt: new Date(at.getTime() + 1000).toISOString(),
        expiresAt: new Date(at.getTime() + 31_000).toISOString(),
      }),
    );
    return { ...p, claimId };
  }
  it('exhausted/dead-lettered final delivery plus root-lock failure recovers after restart through normal consumer', async () => {
    const p = await overdue(),
      job = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, transitionId: p.t, claimId: p.claimId };
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r)),
      gate = new Promise<void>((r) => (release = r));
    const held = scope()(p.authority, async () => {
      locked();
      await gate;
    });
    await ready;
    const delivery = createBoss(database.settings, 'consumer', {
      onError: () => undefined,
      onWarning: () => undefined,
    });
    await delivery.start();
    let id: string | null = null;
    try {
      const bounded = makeFormationPresentations({ ...ports, withScope: ports.withRecoveryScope });
      await expect(bounded.expire(job)).rejects.toMatchObject({ code: 'SCOPE_BUSY' });
      await startConsumers(
        delivery,
        [jobConsumer(expireFormationQueue, async (input) => bounded.expire(input))],
        () => undefined,
      );
      // Real pg-boss final failed delivery, with a zero-retry fixture override, while its root
      // is unavailable. The failure and actual declared dead letter are asserted, not authored.
      id = await c.boss.send(expireFormationQueue.name, job, { retryLimit: 0 });
      expect(id).toBeTruthy();
      await waitUntil(async () => {
        const rows = await database.pool.query<{ state: string }>('select state from pgboss.job where id=$1', [id]);
        return rows.rows[0]?.state === 'failed';
      });
      await waitUntil(
        async () =>
          (
            await database.pool.query("select id from pgboss.job where name=$1 and data->>'claimId'=$2", [
              deadLetterQueueName(expireFormationQueue.name),
              p.claimId,
            ])
          ).rowCount === 1,
      );
      expect(
        (
          await database.pool.query<{ disposition: string | null }>(
            'select disposition from scenes.formation_presentations where universe_id=$1',
            [p.universeId],
          )
        ).rows[0]!.disposition,
      ).toBeNull();
    } finally {
      await delivery.stop({ graceful: false });
      release();
      await held;
    }
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    try {
      await worker.unschedule(recoverFormationQueue.name);
      await startConsumers(
        worker,
        [
          jobConsumer(recoverFormationQueue, async (input) => {
            await api().recover(input);
          }),
        ],
        () => undefined,
      );
      await c.boss.send(recoverFormationQueue.name, { v: 1 });
      await waitUntil(async () => Boolean((await row(p, p.t))?.terminal));
    } finally {
      await worker.stop({ graceful: false });
    }
    expect((await row(p, p.t))?.terminal?.disposition).toBe('skipped');
    await api().expire(job);
    expect((await row(p, p.t))?.terminal?.disposition).toBe('skipped');
  });
  it('100 busy heads cannot hide tail: required fixed child survives abandoned page and restart, dedupes and ends', async () => {
    // Independent disposable roots; intentionally leave first100 claimed rows due, without changing ordering.
    const heads = [];
    for (let i = 0; i < 100; i++) heads.push(await overdue());
    const tail = await overdue();
    const first = await formationRecoveryPage(database.db, c.boss)({ v: 1 });
    expect(first).toHaveLength(100);
    const children = async () =>
      (
        await database.pool.query<{ id: string; data: Record<string, unknown> }>(
          "select id,data from pgboss.job where name=$1 and data ? 'afterKey' and state in('created','retry','active')",
          [recoverFormationQueue.name],
        )
      ).rows;
    const initial = await children();
    expect(initial).toHaveLength(1);
    expect(Object.keys(initial[0]!.data).sort()).toEqual(['afterKey', 'throughKey', 'v']);
    await formationRecoveryPage(database.db, c.boss)({ v: 1 });
    expect(await children()).toHaveLength(1);
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select id from identity.universes where id=any($1::uuid[]) order by id for no key update', [
        heads.map((p) => p.universeId),
      ]);
      const blocked = await api().recover({ v: 1 });
      expect(blocked).toEqual({ completed: 0, skipped: 100 });
      expect(await children()).toHaveLength(1);
      expect(
        (
          await database.pool.query<{ disposition: string | null }>(
            'select disposition from scenes.formation_presentations where universe_id=$1',
            [tail.universeId],
          )
        ).rows[0]!.disposition,
      ).toBeNull();
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    const future = await overdue();
    const follow = initial[0]!.data;
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    try {
      await worker.unschedule(recoverFormationQueue.name);
      await startConsumers(
        worker,
        [
          jobConsumer(recoverFormationQueue, async (input) => {
            await api().recover(input);
          }),
        ],
        () => undefined,
      );
      await waitUntil(async () => Boolean((await row(tail, tail.t))?.terminal));
    } finally {
      await worker.stop({ graceful: false });
    }
    expect((await row(future, future.t))?.terminal).toBeUndefined();
    expect((await row(heads[0]!, heads[0]!.t))?.terminal).toBeUndefined();
    const before = await database.pool.query<{ n: number }>('select count(*)::int as n from pgboss.job where name=$1', [
      recoverFormationQueue.name,
    ]);
    await api().recover(follow);
    const after = await database.pool.query<{ n: number }>('select count(*)::int as n from pgboss.job where name=$1', [
      recoverFormationQueue.name,
    ]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    await database.pool
      .query(`create function public.ci_formation_child_refusal() returns trigger language plpgsql as $$ begin
      if new.name='scenes.recover-formation' and new.data ? 'afterKey' then raise exception 'CI_CHILD_FAIL' using errcode='23514';end if;return new;end $$;
      create trigger ci_formation_child_refusal before insert on pgboss.job for each row execute function public.ci_formation_child_refusal();`);
    try {
      await database.pool.query("update pgboss.job set state='failed' where name=$1 and data ? 'afterKey'", [
        recoverFormationQueue.name,
      ]);
      await expect(api().recover({ v: 1 })).rejects.toMatchObject({ code: '23514' });
    } finally {
      await database.pool.query(
        'drop trigger ci_formation_child_refusal on pgboss.job;drop function public.ci_formation_child_refusal();',
      );
    }
    expect((await row(heads[0]!, heads[0]!.t))?.terminal).toBeUndefined();
  }, 90_000);
  it('full and selective inventories include facts/claims; old late jobs and ordinal cursor cannot restore cleared IDs or erase new data', async () => {
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
    const p = await overdue(),
      old = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, transitionId: p.t, claimId: p.claimId };
    // Every private transport lifecycle state and dead-letter payload is a real erasure input.
    for (const state of ['created', 'retry', 'active', 'completed', 'cancelled', 'failed']) {
      const id = await c.boss.send(expireFormationQueue.name, old);
      expect(id).toBeTruthy();
      await database.pool.query('update pgboss.job set state=$1 where id=$2', [state, id]);
    }
    await c.boss.send(deadLetterQueueName(expireFormationQueue.name), old);
    const original = await row(p, p.t);
    if (!original) throw new Error('CI_RECORD_MISSING');
    const cursor = { v: 1, afterKey: (BigInt(original.key) - 1n).toString(), throughKey: original.key };
    await c.boss.send(recoverFormationQueue.name, cursor);

    const clear = clearExplorationFor(database.db, c.boss, {
      reasoning: clearReasoning,
      eraseCore: async (s) => {
        await eraseExploration(s, explorationStores);
      },
    });
    const q = {
      commandId: randomUUID(),
      version: 'clear-exploration.v1' as const,
      expectedPrivacyEpoch: 1,
      confirmation: 'clear-exploration-preserve-keep-and-social',
    };
    const a = await clear.start({ accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 }, q);
    expect(a).toMatchObject({ kind: 'entered', value: { kind: 'ok' } });
    await clear.process({ v: 1, accountId: p.accountId, commandId: q.commandId });
    expect(
      (
        await database.pool.query<{ n: number }>(
          'select count(*)::int as n from scenes.formation_presentations where universe_id=$1',
          [p.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await database.pool.query<{ n: number }>(
          "select count(*)::int as n from pgboss.job where name=any($1::text[]) and data->>'universeId'=$2",
          [[expireFormationQueue.name, deadLetterQueueName(expireFormationQueue.name)], p.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
    const fresh = await fixture({ person: { ...p, authority: { ...p.authority, privacyEpoch: 2 } } });
    const freshRecord = await row(fresh, fresh.t);
    expect(BigInt(freshRecord!.key)).toBeGreaterThan(BigInt(original.key));
    await api().expire(old);
    await api().recover(cursor);
    await api().recover({ v: 1 });
    const global = await database.pool.query<{ data: unknown }>('select data from pgboss.job where name=$1', [
      recoverFormationQueue.name,
    ]);
    for (const r of global.rows) {
      expect(JSON.stringify(r.data)).not.toContain(p.universeId);
      expect(JSON.stringify(r.data)).not.toContain(p.t);
      expect(JSON.stringify(r.data)).not.toContain(p.claimId);
    }
    expect(await read(fresh, fresh.t)).toMatchObject({
      kind: 'accepted',
      value: { status: 'available', eligibility: { status: 'claimable' } },
    });
    expect(await api().claim(p.authority, claim(p.t))).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
    for (const state of ['created', 'retry', 'active', 'completed', 'cancelled', 'failed']) {
      const id = await c.boss.send(expireFormationQueue.name, { ...old, privacyEpoch: 2, transitionId: fresh.t });
      await database.pool.query('update pgboss.job set state=$1 where id=$2', [state, id]);
    }
    await scope()(fresh.authority, (s) => eraseUniverse(s, personalStores));
    expect(
      (
        await database.pool.query<{ n: number }>(
          "select count(*)::int as n from pgboss.job where data->>'universeId'=$1 and name=any($2::text[])",
          [p.universeId, [expireFormationQueue.name, deadLetterQueueName(expireFormationQueue.name)]],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await database.pool.query<{ n: number }>(
          'select count(*)::int as n from scenes.formation_presentations where universe_id=$1',
          [p.universeId],
        )
      ).rows[0]!.n,
    ).toBe(0);
  });
});
