/** Installed release API/worker + PostgreSQL. Authored creation and shown/skipped requests are CI
 * fixtures only; no actual personal formation, client rendering, provider or HUMAN approval. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  FormationPresentationReadSchema,
  FormationPresentationClaimAcceptanceSchema,
  FormationPresentationAcknowledgementSchema,
  FormationPresentationProblemSchema,
  UniverseDeltaSchema,
} from '@knowscroll/contracts';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  advanceScopeRevision,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { createBoss, makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { geographyStore } from '@knowscroll/backend/modules/geography/nest-providers';
import { sceneAppliedProviders, formationStore } from '@knowscroll/backend/modules/scenes/nest-providers';
import { GEOGRAPHY_APPLIED, type GeographyApplied } from '@knowscroll/backend/modules/geography';
import { expireFormationQueue, recoverFormationQueue } from '@knowscroll/backend/modules/scenes';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { buildFromProviders } from '../support/providers.js';
const version = 'formation-presentation.v1',
  canary = 'PRIVATE-FORMATION-HTTP-CANARY';
const capabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
describe('U05 normal installed API/worker journey (Actions fixtures)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    db: DatabaseHandle<Database>,
    api: ReleaseProcess,
    worker: ReleaseProcess,
    origin: string,
    boss: ReturnType<typeof createBoss>;
  const processes: ReleaseProcess[] = [],
    secrets = new Set<string>();
  const env = () => ({
    NODE_ENV: 'test',
    KS_WORLD: 'ci',
    DATABASE_URL: database.url,
    KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
    KS_SHUTDOWN_GRACE_SECONDS: '10',
  });
  async function startAPI() {
    const p = startReleaseProcess('api', 'main', {
      ...env(),
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
    });
    processes.push(p);
    await p.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
    return p;
  }
  async function startWorker() {
    const p = startReleaseProcess('worker', 'main', env());
    processes.push(p);
    await p.waitForEvent('process.started');
    return p;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('formation_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    db = createDatabase<Database>(
      { url: database.url, applicationName: 'ci-formation-http', poolMax: 5, statementTimeoutMs: 15000 },
      { onIdleClientError: () => undefined },
    );
    boss = createBoss(
      { url: database.url, applicationName: 'ci-formation-http', poolMax: 5, statementTimeoutMs: 15000 },
      'producer',
      { onError: () => undefined, onWarning: () => undefined },
    );
    await boss.start();
    origin = `http://127.0.0.1:${await freePort()}`;
    api = await startAPI();
    worker = await startWorker();
  });
  afterAll(async () => {
    try {
      for (const p of processes) {
        expect(await p.stop()).toBe(0);
        expect(p.rawOutput()).not.toContain(canary);
        for (const secret of secrets) expect(p.rawOutput()).not.toContain(secret);
        expect(p.records.filter((x) => x.event === 'http.unexpected_error')).toEqual([]);
      }
    } finally {
      await boss?.stop({ graceful: false });
      await db?.close();
      await database?.drop();
    }
  });
  async function person() {
    const p = await seedPerson(db.db),
      tokens = await seedKeepSessions(db.db, p);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    return { ...p, tokens };
  }
  async function post(
    p: Awaited<ReturnType<typeof person>>,
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) {
    return fetch(origin + '/v1/universe/formation/' + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${p.tokens.native}`,
        'X-KS-Scope': `${p.accountId}:1`,
        'Content-Type': 'application/json',
        ...extra,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }
  async function read(p: Awaited<ReturnType<typeof person>>, t?: string) {
    const response = await post(p, 'read', {
      version,
      readId: randomUUID(),
      target: t ? { kind: 'transition', transitionId: t } : { kind: 'next' },
      capabilities,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return FormationPresentationReadSchema.parse(await response.json());
  }
  async function seedCreation(p: FixturePerson, at = new Date()) {
    const transitionId = randomUUID(),
      objectId = randomUUID(),
      runId = randomUUID(),
      scope = makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 }),
      e = p.authority.privacyEpoch;
    const object = {
      id: objectId,
      kind: 'system' as const,
      conceptId: 'earth',
      parent: { kind: 'universe' as const, id: p.universeId },
      label: 'Earth',
      truthStatus: 'factual' as const,
      objectRevision: 1,
      originTransitionId: transitionId,
      activity: { availability: 'available' as const, state: 'active' as const },
    };
    const delta = UniverseDeltaSchema.parse({
      version: 'universe-delta.v1',
      universeId: p.universeId,
      privacyEpoch: e,
      personalWatermark: 1,
      transitionId,
      recordedAt: at.toISOString(),
      base: { revision: 0, structureRevision: 0, activityRevision: 0 },
      geography: { revision: 1, structureRevision: 1, activityRevision: 0 },
      operations: [{ kind: 'create_system', object }],
    });
    const ENQUEUE = Symbol('enqueue'),
      applied = buildFromProviders(
        sceneAppliedProviders({ enqueueJob: ENQUEUE }),
        GEOGRAPHY_APPLIED,
        new Map([[ENQUEUE, makeEnqueueJob(boss)]]),
      ) as GeographyApplied;
    await scope(p.authority, async (s) => {
      const tx = transactionOf(s);
      await tx
        .insertInto('geography.runs')
        .values({ universe_id: p.universeId, privacy_epoch: e, id: runId, desired_revision: 1, status: 'accepted' })
        .execute();
      await geographyStore.saveObject(
        s,
        {
          id: objectId,
          key: 'system:earth:factual',
          kind: 'system',
          conceptId: 'earth',
          parentKey: 'universe',
          label: 'Earth',
          labels: ['Earth'],
          truthStatus: 'factual',
          objectRevision: 1,
          originTransitionId: transitionId,
          activity: object.activity,
        },
        [canary],
      );
      await geographyStore.writeDelta(s, runId, 'a'.repeat(64), delta);
      await geographyStore.writeState(s, { ...(await geographyStore.state(s)), ...delta.geography });
      await advanceScopeRevision(s);
      await applied(s, {
        transitionId,
        geography: delta.geography,
        personalRevision: 1,
        committedCreations: {
          recordedAt: delta.recordedAt,
          targets: [
            {
              operation: 'create_system',
              objectId,
              parentId: p.universeId,
              kind: 'system',
              objectRevision: 1,
              label: 'Earth',
              truthStatus: 'factual',
            },
          ],
        },
      });
    });
    return transitionId;
  }
  const wait = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('CI_FORMATION_HTTP_TIMEOUT');
  };
  it('pure own read/closed early private errors do not create a fact/receipt/job/root change', async () => {
    const p = await person();
    expect(await read(p)).toMatchObject({
      status: 'none',
      scope: { universeId: p.universeId, privacyEpoch: 1, personalWatermark: 0 },
    });
    const bad = await fetch(origin + '/v1/universe/formation/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [canary]: canary }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('cache-control')).toBe('private, no-store');
    expect(FormationPresentationProblemSchema.parse(await bad.json()).code).toBe('UNAUTHENTICATED');
    for (const body of [
      { version, readId: randomUUID(), target: { kind: 'next' }, capabilities, privateKey: canary },
      { version, readId: canary, target: { kind: 'next' }, capabilities },
    ]) {
      const r = await post(p, 'read', body);
      expect(r.status).toBe(400);
      const text = await r.text();
      expect(text).not.toContain(canary);
      expect(FormationPresentationProblemSchema.parse(JSON.parse(text)).code).toBe('INVALID_REQUEST');
    }
    const foreign = await post(
      p,
      'claim',
      { version, commandId: randomUUID(), transitionId: randomUUID(), attemptNonce: randomUUID() },
      { Origin: 'https://foreign.invalid' },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('private, no-store');
    expect(
      (
        await db.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(0);
    expect(
      await db.db
        .selectFrom('scenes.formation_presentations')
        .select('transition_id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await db.db
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await db.pool.query<{ n: number }>("select count(*)::int as n from pgboss.job where data->>'universeId'=$1", [
          p.universeId,
        ])
      ).rows[0]!.n,
    ).toBe(0);
  });
  it('normal projection -> read -> concurrent deliberate claims -> restart -> same original replay -> truthful terminal ACK', async () => {
    const p = await person(),
      t = await seedCreation(p);
    await wait(async () => (await read(p, t)).status === 'available');
    const q = { version, commandId: randomUUID(), transitionId: t, attemptNonce: randomUUID() },
      other = { ...q, commandId: randomUUID(), attemptNonce: randomUUID() };
    const results = await Promise.all([post(p, 'claim', q), post(p, 'claim', other)]);
    const values = await Promise.all(
      results.map(async (r) => {
        expect(r.status).toBe(200);
        return FormationPresentationClaimAcceptanceSchema.parse(await r.json());
      }),
    );
    expect(values.filter((v) => v.receipt.outcome === 'claimed')).toHaveLength(1);
    const winning = values[0]!.receipt.outcome === 'claimed' ? q : other,
      original = values.find((v) => v.receipt.outcome === 'claimed')!;
    expect(original.current.status).toBe('active');
    expect(await api.stop()).toBe(0);
    api = await startAPI();
    const replay = await post(p, 'claim', winning);
    const accepted = FormationPresentationClaimAcceptanceSchema.parse(await replay.json());
    expect(accepted.receipt).toEqual(original.receipt);
    expect(accepted.replayed).toBe(true);
    if (original.receipt.outcome !== 'claimed') throw new Error('CI_CLAIM_MISSING');
    const ack = {
      version,
      commandId: randomUUID(),
      transitionId: t,
      claimId: original.receipt.claim.claimId,
      attemptNonce: winning.attemptNonce,
      disposition: 'shown',
    };
    const a = await post(p, 'acknowledge', ack);
    expect(FormationPresentationAcknowledgementSchema.parse(await a.json())).toMatchObject({
      outcome: 'recorded',
      disposition: 'shown',
    });
    const retry = await post(p, 'acknowledge', ack);
    expect(FormationPresentationAcknowledgementSchema.parse(await retry.json())).toMatchObject({
      replayed: true,
      disposition: 'shown',
    });
    const later = await post(p, 'claim', winning);
    expect(FormationPresentationClaimAcceptanceSchema.parse(await later.json()).current).toMatchObject({
      status: 'final',
      reason: 'terminal',
    });
  });
  it('lost/exhausted expiry is recovered by the installed normal scheduled-queue consumer after worker restart', async () => {
    expect(await worker.stop()).toBe(0);
    const p = await person(),
      at = new Date(Date.now() - 90_000),
      t = await seedCreation(p, at),
      claimId = randomUUID();
    await makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 })(p.authority, (s) =>
      formationStore.claim(s, t, {
        claimId,
        attemptNonce: randomUUID(),
        claimedAt: new Date(at.getTime() + 1000).toISOString(),
        expiresAt: new Date(at.getTime() + 31_000).toISOString(),
      }),
    );
    const id = await boss.send(expireFormationQueue.name, {
      v: 1,
      universeId: p.universeId,
      privacyEpoch: 1,
      transitionId: t,
      claimId,
    });
    expect(id).toBeTruthy();
    // Authored lost transport state only; exact durable claim remains the owner authority.
    await db.pool.query("update pgboss.job set state='failed',retry_count=retry_limit where id=$1", [id]);
    worker = await startWorker();
    await boss.send(recoverFormationQueue.name, { v: 1 });
    await wait(async () =>
      Boolean(
        (
          await db.db
            .selectFrom('scenes.formation_presentations')
            .select('disposition')
            .where('universe_id', '=', p.universeId)
            .executeTakeFirstOrThrow()
        ).disposition,
      ),
    );
    expect(
      (
        await db.db
          .selectFrom('scenes.formation_presentations')
          .select('disposition')
          .where('universe_id', '=', p.universeId)
          .executeTakeFirstOrThrow()
      ).disposition,
    ).toBe('skipped');
  });
});
