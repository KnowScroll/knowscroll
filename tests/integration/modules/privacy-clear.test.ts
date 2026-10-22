import { personalStores } from '@knowscroll/backend/erasure-registry';
import { socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION, type CoverageCommand } from '@knowscroll/backend/modules/content';
import {
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import { composeEncounter } from '@knowscroll/backend/modules/composer';
import { makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { fixtureComposerSnapshot } from '../support/composer.js';
import { evidenceUseCase } from '../support/evidence.js';
import { experienceUseCases } from '../support/experience.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { admitStarter, scrollUseCases } from '../support/scroll.js';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explorationStores } from '@knowscroll/backend/erasure-registry';
import {
  eraseExploration,
  clearExplorationRegistry,
  checkErasureInventory,
} from '@knowscroll/backend/infrastructure/erasure';
import { applyQueueDeclarations, createBoss, makeEnqueuePrivacyJob } from '@knowscroll/backend/infrastructure/jobs';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import {
  makeWithPrivacyScope,
  makeWithClearMaintenance,
  isClearCore,
  makeWithPersonalScope,
  transactionOf,
  clearAccountingTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  clearExplorationQueue,
  makeClearExploration,
  type ClearPorts,
  type PrivacyAuthority,
} from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, clearStore, identityUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning, makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset, seedPerson, type FixturePerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';

/** CI fixture: a run descriptor and a reservation written straight through the ledger port. */
function fixtureRunDescriptor(id: string) {
  return {
    id,
    ownerModule: 'fixture',
    purpose: 'fixture',
    roleId: 'fixture.erasure',
    roleVersion: 'v1',
    policyVersion: 'fixture.v1',
    provider: 'fixture',
    model: 'fixture',
    contextBundleRef: 'fixture.bundle:erasure',
    contextRefs: ['fixture:item'],
  };
}

function fixtureReservation(id: string, runId: string, label: string) {
  // The database recomputes the hash of the stored bytes (a CHECK): the hash is the real one.
  const requestBody = new TextEncoder().encode(`{"fixture":"erasure-${label}"}`);
  return {
    id,
    runId,
    step: 'primary',
    provider: 'fixture',
    model: 'fixture',
    roleId: 'fixture.erasure',
    roleVersion: 'v1',
    promptVersion: 'hp-fixture',
    requestHash: createHash('sha256').update(requestBody).digest('hex'),
    requestBody,
    maxOutputTokens: 16,
    reservedTokens: 37,
    requestRetentionSeconds: 3_600,
  };
}

/** CI fixtures + real PostgreSQL/pg-boss only. Never owner data or a provider. */
describe('durable selective Clear', () => {
  let database: TestDatabase<Database>;
  let boss: ReturnType<typeof createBoss>;
  const db = () => database.db;
  const authority = (p: FixturePerson, privacyEpoch = 1): PrivacyAuthority => ({
    accountId: p.accountId,
    universeId: p.universeId,
    privacyEpoch,
  });
  const body = (expectedPrivacyEpoch = 1, commandId = randomUUID()) => ({
    version: 'clear-exploration.v1',
    commandId,
    expectedPrivacyEpoch,
    confirmation: 'clear-exploration-preserve-keep-and-social',
  });
  const job = (p: FixturePerson, commandId: string) => ({ v: 1, accountId: p.accountId, commandId });
  const core = async (scope: Parameters<typeof eraseExploration>[0]) => {
    await eraseExploration(scope, explorationStores);
  };
  const cases = () => clearExplorationFor(db(), boss, { reasoning: clearReasoning, eraseCore: core });
  const custom = (overrides: Partial<ClearPorts>) =>
    makeClearExploration({
      withPrivacyScope: makeWithPrivacyScope(db(), { lockTimeoutMs: 5000 }),
      withMaintenance: makeWithClearMaintenance(db(), { lockTimeoutMs: 5000 }),
      store: clearStore,
      reasoning: clearReasoning,
      hash: (input) => requestHash('privacy.clear-exploration', input as Parameters<typeof requestHash>[1]),
      eraseCore: core,
      isCore: isClearCore,
      enqueue: makeEnqueuePrivacyJob(boss, clearExplorationQueue),
      now: () => new Date(),
      ...overrides,
    });
  const root = (p: FixturePerson) =>
    db().selectFrom('identity.universes').selectAll().where('id', '=', p.universeId).executeTakeFirstOrThrow();
  const status = (p: FixturePerson, epoch = 2) =>
    cases().status(authority(p, epoch), { version: 'clear-exploration.v1', target: { kind: 'latest' } });
  beforeEach(async () => {
    database = await createTestDatabase<Database>('privacy_clear');
    boss = createBoss(database.settings, 'install', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    await applyQueueDeclarations(boss, [clearExplorationQueue]);
  });
  afterEach(async () => {
    await boss.stop({ graceful: false });
    await database.drop();
  });

  const personalRowCounts = async (universeId: string) => {
    const counts: Record<string, number> = {};
    for (const d of personalStores)
      for (const t of d.tables) {
        const result = await sql<{
          n: number;
        }>`select count(*)::int n from ${sql.table(`${t.schema}.${t.table}`)} where universe_id=${universeId}`.execute(
          db(),
        );
        counts[`${t.schema}.${t.table}`] = result.rows[0]?.n ?? 0;
      }
    return counts;
  };

  async function seedAttempt(
    p: FixturePerson,
    state: 'reserved' | 'dispatched' | 'unknown' | 'succeeded' = 'dispatched',
  ) {
    const ledger = makeAttemptLedger(db()),
      id = randomUUID(),
      runId = randomUUID(),
      bytes = new TextEncoder().encode('{"fixture":"private-clear-canary"}');
    await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      await ledger.admitRun(scope, {
        id: runId,
        ownerModule: 'fixture',
        purpose: 'private-clear-canary',
        roleId: 'fixture.clear',
        roleVersion: 'v1',
        policyVersion: 'v1',
        provider: 'fixture',
        model: 'fixture',
        contextBundleRef: 'private-clear-canary',
        contextRefs: ['private-clear-canary'],
      });
      await ledger.reserve(scope, {
        id,
        runId,
        step: 'primary',
        provider: 'fixture',
        model: 'fixture',
        roleId: 'fixture.clear',
        roleVersion: 'v1',
        promptVersion: 'v1',
        requestHash: createHash('sha256').update(bytes).digest('hex'),
        requestBody: bytes,
        reservedTokens: 150,
        maxOutputTokens: 100,
        requestRetentionSeconds: 3600,
      });
      if (state !== 'reserved')
        await ledger.commitDispatch(scope, id, {
          dispatchId: randomUUID(),
          dispatchedBy: 'private-clear-canary',
          quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
        });
    });
    if (state === 'unknown' || state === 'succeeded')
      await ledger.settle(
        { scopeId: p.universeId, attemptId: id },
        'dispatched',
        state,
        state === 'succeeded'
          ? {
              output: { v: 1, text: 'private-clear-canary' },
              usage: { inputTokens: 9, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
              outcomeCode: 'SUCCEEDED',
            }
          : { outcomeCode: 'TRANSPORT_OUTCOME_UNKNOWN' },
      );
    return { id, runId, ledger };
  }
  it('serializes duplicate starts, binds the complete original body, and replays only under current authority', async () => {
    const p = await seedPerson(db()),
      input = body();
    const results = await Promise.all([cases().start(authority(p), input), cases().start(authority(p, 2), input)]);
    // Either current epoch claim can race the root. An exact current retry is decisive.
    expect(results.some((r) => r.kind === 'entered' && r.value.kind === 'ok')).toBe(true);
    expect(await cases().start(authority(p, 2), input)).toMatchObject({
      kind: 'entered',
      value: { kind: 'ok', value: { replayed: true, fromEpoch: 1, toEpoch: 2 } },
    });
    expect(await cases().start(authority(p), input)).toMatchObject({
      kind: 'refused',
      refusal: { kind: 'epoch_changed' },
    });
    expect(await cases().start(authority(p, 2), { ...input, expectedPrivacyEpoch: 2 })).toMatchObject({
      kind: 'entered',
      value: { code: 'COMMAND_KEY_REUSED' },
    });
    expect(await cases().start(authority(p, 2), body(2))).toMatchObject({
      kind: 'entered',
      value: { code: 'CONFLICT' },
    });
    const jobs = await sql<{
      n: number;
    }>`select count(*)::int n from pgboss.job where name=${clearExplorationQueue.name}`.execute(db());
    expect(jobs.rows[0]?.n).toBe(1);
    expect((await root(p)).privacy_epoch).toBe(2);
    await db().updateTable('identity.accounts').set({ status: 'suspended' }).where('id', '=', p.accountId).execute();
    expect(await cases().start(authority(p, 2), input)).toMatchObject({ kind: 'refused' });
  });
  for (const point of ['after-receipt-and-barrier', 'after-required-job'] as const)
    it(`rolls back acceptance, epoch, barrier and job ${point}`, async () => {
      const p = await seedPerson(db()),
        input = body();
      const broken =
        point === 'after-receipt-and-barrier'
          ? custom({
              store: {
                ...clearStore,
                async create(...args) {
                  await clearStore.create(...args);
                  throw new Error('fixture-crash');
                },
              },
            })
          : custom({
              async enqueue(...args) {
                await makeEnqueuePrivacyJob(boss, clearExplorationQueue)(...args);
                throw new Error('fixture-crash');
              },
            });
      await expect(broken.start(authority(p), input)).rejects.toThrow('fixture-crash');
      expect(await root(p)).toMatchObject({ privacy_epoch: 1, revision: 0, clear_operation_id: null });
      expect(await db().selectFrom('identity.clear_operations').selectAll().execute()).toEqual([]);
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pgboss.job where name=${clearExplorationQueue.name}`.execute(db())
        ).rows[0]?.n,
      ).toBe(0);
    });
  it('refuses stale unrecorded commands and int32 exhaustion without accepting work', async () => {
    for (const mode of ['stale', 'epoch', 'revision']) {
      const p = await seedPerson(db());
      if (mode === 'epoch')
        await db()
          .updateTable('identity.universes')
          .set({ privacy_epoch: 2147483647 })
          .where('id', '=', p.universeId)
          .execute();
      if (mode === 'revision')
        await db()
          .updateTable('identity.universes')
          .set({ revision: 2147483646 })
          .where('id', '=', p.universeId)
          .execute();
      expect(
        await cases().start(
          authority(p, mode === 'epoch' ? 2147483647 : 1),
          body(mode === 'stale' ? 2 : mode === 'epoch' ? 2147483647 : 1),
        ),
      ).toMatchObject({ kind: 'entered', value: { code: 'CONFLICT' } });
    }
    expect(await db().selectFrom('identity.clear_operations').selectAll().execute()).toEqual([]);
  });
  it('rolls back failed core, preserves barrier, and verifies mandatory inventory before core_done', async () => {
    const p = await seedPerson(db()),
      input = body();
    await cases().start(authority(p), input);
    const broken = custom({
      async eraseCore(scope) {
        await core(scope);
        throw new Error('fixture-core-crash');
      },
    });
    await expect(broken.process(job(p, input.commandId))).rejects.toThrow('fixture-core-crash');
    expect((await root(p)).clear_operation_id).not.toBeNull();
    expect(() =>
      clearExplorationRegistry([
        {
          ...explorationStores[0]!,
          clearExploration: {
            dispositions: {},
            erase: () => Promise.resolve({ module: 'social', status: 'completed', removed: 0 }),
          },
        },
      ]),
    ).toThrow('CLEAR_DISPOSITION_MISSING');
    await cases().fail(job(p, input.commandId), 'completion_unverified');
    expect(await status(p)).toMatchObject({ value: { value: { status: 'failed', code: 'completion_unverified' } } });
    await cases().process(job(p, input.commandId));
    expect(await status(p)).toMatchObject({ value: { value: { status: 'completed_live' } } });
  });
  it('preserves every Saved/place and Social column; replays A after fresh data and during B without erasing it', async () => {
    const p = await seedPerson(db()),
      asset = await seedAsset(db()),
      entry = randomUUID(),
      input = body();
    await db()
      .insertInto('experience.saved_items')
      .values({
        universe_id: p.universeId,
        asset_id: asset.assetId,
        asset_revision: asset.revision,
        saved_entry_id: entry,
        saved_at: new Date('2026-01-01T00:00:00Z'),
      })
      .execute();
    await db()
      .insertInto('experience.saved_places')
      .values({
        universe_id: p.universeId,
        saved_entry_id: entry,
        place_revision: '17',
        position: { kind: 'reel', positionMs: 1928 },
      })
      .execute();
    await db()
      .insertInto('social.profiles')
      .values({
        account_id: p.accountId,
        person_id: randomUUID(),
        display_name: 'CI fixture',
        handle: `fixture${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        profile_revision: '7',
      })
      .execute();
    const peer = await seedPerson(db()),
      access = accountAccessUseCases({ db: db(), lockTimeoutMs: 5000 });
    const social = socialUseCases({
      withScope: makeWithPersonalScope(db(), { lockTimeoutMs: 5000 }),
      fencePair: access.fenceAccountPair,
      fenceOwn: access.fenceOwnAccount,
    });
    await social.setProfile(peer.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: 'fixture.peer',
      displayName: 'CI peer',
    });
    const profile = await social.readProfile(peer.authority);
    if (profile.kind !== 'ok' || profile.value.status !== 'claimed') throw new Error('CI peer profile');
    await social.command(p.authority, 'request', {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedPeerPersonId: profile.value.person.personId,
      expectedPairRevision: 0,
      target: { kind: 'handle', handle: 'fixture.peer' },
    });
    const snapshot = async () => [
      await db().selectFrom('experience.saved_items').selectAll().execute(),
      await db().selectFrom('experience.saved_places').selectAll().execute(),
      await db().selectFrom('social.profiles').selectAll().execute(),
      await db().selectFrom('social.pairs').selectAll().execute(),
      await db().selectFrom('social.pair_sides').selectAll().execute(),
      await db().selectFrom('social.requests').selectAll().execute(),
      await db().selectFrom('social.command_bindings').selectAll().execute(),
      await db().selectFrom('receipts.shared_commands').selectAll().execute(),
    ];
    const before = await snapshot();
    await cases().start(authority(p), input);
    await cases().process(job(p, input.commandId));
    expect(await snapshot()).toEqual(before);
    // A fresh real personal receipt is a stand-in for new-epoch exploration, never erased by replay.
    await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })({ ...p.authority, privacyEpoch: 2 }, async (scope) => {
      await transactionOf(scope)
        .insertInto('receipts.personal_commands')
        .values({
          universe_id: p.universeId,
          command_id: randomUUID(),
          privacy_epoch: 2,
          operation: 'fixture.fresh',
          request_hash: 'a'.repeat(64),
          outcome_version: 1,
          outcome: { fixture: true },
        })
        .execute();
    });
    const fresh = await db().selectFrom('receipts.personal_commands').selectAll().execute();
    await cases().process(job(p, input.commandId));
    await cases().start(authority(p, 2), input);
    expect(await db().selectFrom('receipts.personal_commands').selectAll().execute()).toEqual(fresh);
    const b = body(2);
    await cases().start(authority(p, 2), b);
    const barrier = (await root(p)).clear_operation_id;
    await cases().process(job(p, input.commandId));
    expect((await root(p)).clear_operation_id).toBe(barrier);
    expect(await snapshot()).toEqual(before);
  });
  it('redacts unknown liabilities, keeps exact current-window scope/global/role charges, and suppresses late payload', async () => {
    const p = await seedPerson(db()),
      attempt = await seedAttempt(p, 'unknown');
    const budget = async (epoch: number) =>
      makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })({ ...p.authority, privacyEpoch: epoch }, (scope) =>
        attempt.ledger.budgetUsage(scope, 'fixture.clear'),
      );
    const before = await budget(1),
      input = body();
    await cases().start(authority(p), input);
    await cases().process(job(p, input.commandId));
    expect(await budget(2)).toEqual(before);
    expect(await status(p)).toMatchObject({ value: { value: { status: 'pending', phase: 'waiting_for_accounting' } } });
    expect(await db().selectFrom('reasoning.protected_requests').selectAll().execute()).toEqual([]);
    expect(
      await attempt.ledger.settle({ scopeId: p.universeId, attemptId: attempt.id }, 'unknown', 'reconciled', {
        output: { v: 1, text: 'private-clear-canary' },
        usage: { inputTokens: 9, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
        outcomeCode: 'SUCCEEDED',
      }),
    ).toBe(true);
    await cases().process(job(p, input.commandId));
    const row = await db()
      .selectFrom('reasoning.external_attempts')
      .selectAll()
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ output: null, output_issues: null, quota_observation: null, dispatched_by: null });
    expect(JSON.stringify(row)).not.toContain('private-clear-canary');
    expect(await status(p)).toMatchObject({ value: { value: { status: 'completed_live' } } });
    const settled = await budget(2),
      b = body(2);
    await cases().start(authority(p, 2), b);
    await cases().process(job(p, b.commandId));
    expect(await budget(3)).toEqual(settled);
  });
  it('only releases proven undispatched reservations and refuses missing receipt identity', async () => {
    const p = await seedPerson(db()),
      a = await seedAttempt(p, 'reserved'),
      input = body();
    await cases().start(authority(p), input);
    await cases().process(job(p, input.commandId));
    expect(
      await db()
        .selectFrom('reasoning.usage_receipts')
        .select('state')
        .where('attempt_id', '=', a.id)
        .executeTakeFirst(),
    ).toEqual({ state: 'released' });
    const other = await seedPerson(db()),
      broken = await seedAttempt(other);
    await db().deleteFrom('reasoning.usage_receipts').where('attempt_id', '=', broken.id).execute();
    await expect(cases().start(authority(other), body())).rejects.toThrow('CLEAR_ACCOUNTING_UNVERIFIED');
    expect((await root(other)).privacy_epoch).toBe(1);
  });
  it('keeps status read-only and current scoped while receipts remain immutable', async () => {
    const p = await seedPerson(db()),
      input = body();
    await cases().start(authority(p), input);
    const before = await db().selectFrom('identity.clear_operations').selectAll().execute();
    for (let n = 0; n < 3; n++)
      expect(await status(p)).toMatchObject({
        value: { value: { scope: { privacyEpoch: 2 }, receipt: { toEpoch: 2 } } },
      });
    expect(await db().selectFrom('identity.clear_operations').selectAll().execute()).toEqual(before);
    await expect(
      db().updateTable('identity.clear_operations').set({ from_epoch: 2, to_epoch: 3 }).execute(),
    ).rejects.toThrow('clear_receipt_immutable');
    await cases().process(job(p, input.commandId));
    await expect(db().updateTable('identity.clear_operations').set({ core_done_at: null }).execute()).rejects.toThrow();
  });
  it('rechecks account status after a root/account lock wait before any historical replay', async () => {
    const p = await seedPerson(db()),
      input = body();
    await cases().start(authority(p), input);
    const entered = gate(),
      release = gate();
    const holding = db()
      .transaction()
      .execute(async (trx) => {
        await trx.selectFrom('identity.accounts').select('id').where('id', '=', p.accountId).forUpdate().execute();
        entered.open();
        await release.promise;
        await trx.updateTable('identity.accounts').set({ status: 'suspended' }).where('id', '=', p.accountId).execute();
      });
    await entered.promise;
    const retry = cases().start(authority(p, 2), input);
    release.open();
    await holding;
    expect(await retry).toMatchObject({ kind: 'refused' });
  });
  it('allows real sign-in/session refresh during a barrier and preserves the new-epoch auth receipt', async () => {
    const sent: { link: string }[] = [];
    const identity = identityUseCases({
      db: db(),
      lockTimeoutMs: 5000,
      logEvent: () => undefined,
      settings: {
        publicOrigin: 'https://privacy.ci.invalid',
        secureCookies: true,
        mail: { sender: 'fixture', outboxFile: undefined },
        operatorSignIn: undefined,
        nativeSignInBinding: false,
      },
      mailSender: (mail) => {
        sent.push({ link: mail.link });
        return Promise.resolve({ kind: 'sent' });
      },
    });
    const email = `fixture-${randomUUID()}@privacy.test`;
    await identity.requestSignIn({ email });
    const token = () => new URL(sent.at(-1)!.link).hash.replace(/^#token=/, '');
    const first = await identity.redeemSignIn({ token: token(), commandId: randomUUID(), client: 'web' });
    if (first.kind !== 'signed_in') throw new Error('Fixture sign-in failed');
    const p = {
      accountId: first.outcome.accountId,
      universeId: first.outcome.universeId,
      authority: {
        universeId: first.outcome.universeId,
        privacyEpoch: 1,
        actor: { kind: 'account' as const, accountId: first.outcome.accountId },
      },
    };
    const input = body();
    await cases().start(authority(p), input);
    await identity.requestSignIn({ email });
    const commandId = randomUUID();
    const next = await identity.redeemSignIn({ token: token(), commandId, client: 'web' });
    if (next.kind !== 'signed_in') throw new Error('Fixture barrier sign-in failed');
    expect((await identity.resolveSession(next.session.token))?.privacyEpoch).toBe(2);
    await cases().process(job(p, input.commandId));
    expect(
      await db()
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('command_id', '=', commandId)
        .executeTakeFirst(),
    ).toBeDefined();
  });
  it('selectively clears meaningful fixtures in every exploration store and every historical Scene version while preserving another universe', async () => {
    const erased = await seedPerson(database.db);
    const kept = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    const scroll = await scrollUseCases(database);
    const starter = await admitStarter(scroll.importScroll);
    // Explicit CI attribution fixture for exercising personal topic-row erasure; no runtime taxonomy inference.
    await database.db
      .insertInto('content.encounter_topics')
      .values({
        asset_id: starter.assetId,
        asset_revision: starter.revision,
        topic_id: 'ci.erasure.topic',
        role: 'primary',
        weight: 1,
      })
      .execute();
    // Exact synthetic semantic approval ONLY for this erasure fixture. The real reading pipeline
    // below must populate ALL new personal stores; production approval registry stays empty.
    const coverageSource = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document_sha256', 'explanation_unit_id', 'reading_facts'])
      .where('asset_id', '=', starter.assetId)
      .where('revision', '=', starter.revision)
      .executeTakeFirstOrThrow();
    const coverageProvenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', starter.assetId)
      .where('revision', '=', starter.revision)
      .executeTakeFirstOrThrow();
    const coverageCommand: CoverageCommand = {
      version: 'content-coverage-command.v1',
      assetId: starter.assetId,
      assetRevision: starter.revision,
      expectedHeadRevision: 0,
      semanticReviewReference: 'ci-erasure-only-not-live-semantic-approval',
      change: {
        kind: 'admit',
        mapping: {
          version: COVERAGE_POLICY,
          documentSha256: coverageSource.document_sha256,
          provenanceSha256: canonicalSha256(coverageProvenance.provenance),
          explanationUnitId: coverageSource.explanation_unit_id,
          framing: 'factual',
          framingSha256: canonicalSha256({ kind: 'factual' }),
          readingFactsVersion: 2,
          readingFactsSha256: canonicalSha256(coverageSource.reading_facts),
          catalogueVersion: CONCEPT_CATALOGUE_VERSION,
          catalogueSha256: coverageCatalogue.sha256,
          bindings: [
            {
              topicId: 'earth.seasons',
              facetId: 'earth.seasons.axial-tilt',
              meaningSha256: coverageCatalogue.meaningSha256('earth.seasons', 'earth.seasons.axial-tilt')!,
              requiredBlockIds: ['intro-look-up'],
            },
          ],
        },
      },
    };
    await makeAdmitCoverage(
      makeCoverageAdmissionPorts(
        database.db,
        (digest, reference) =>
          digest === canonicalSha256(coverageCommand) && reference === coverageCommand.semanticReviewReference,
      ),
    )(coverageCommand);
    const applyEvidence = evidenceUseCase(database);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    const ledger = makeAttemptLedger(database.db);
    /** A person's reading of the starter Scroll: exposure, observations and a projected evidence revision. */
    const seedReading = async (person: FixturePerson) => {
      const exposure = await openActive(scroll, person, starter);
      await activatedAgo(database.db, exposure.exposureId, 30);
      const facts = await database.db
        .selectFrom('content.asset_revisions')
        .select('reading_facts')
        .where('asset_id', '=', starter.assetId)
        .where('revision', '=', starter.revision)
        .executeTakeFirstOrThrow();
      const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
      const ingested = await scroll.ingestObservations(person.authority, {
        instrumentationVersion: 1,
        events: [event(exposure, coverage(blocks, 4_000)), event(exposure, dwell([0, 68_000]))],
      });
      if (ingested.kind !== 'ingested' || ingested.accepted !== 2) throw new Error('fixture observations refused');
      const projected = await scroll.projectScrollReading({
        v: 1,
        universeId: person.universeId,
        privacyEpoch: 1,
        exposureId: exposure.exposureId,
      });
      if (projected.kind !== 'applied' || projected.qualification !== 'qualified')
        throw new Error('fixture qualified projection skipped');
      // Seed real qualified structural support, so the unchanged every-store>0 assertion covers PC too.
      expect(
        await scroll.projectActivity({
          v: 1,
          universeId: person.universeId,
          privacyEpoch: 1,
          exposureId: exposure.exposureId,
        }),
      ).toMatchObject({ kind: 'applied' });
    };
    const seed = async (person: FixturePerson) => {
      await withPersonalScope(person.authority, (scope) =>
        makeComposerStore({ isOperator: () => true }).persistComposerDecision(
          scope,
          { decisionId: randomUUID(), commandId: randomUUID() },
          composeEncounter(fixtureComposerSnapshot(person.authority)),
        ),
      );
      await seedReading(person);
      const opened = await scroll.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', assetId: starter.assetId, assetRevision: starter.revision },
        capabilities: {
          documentSchemas: ['scroll-document.v1'],
          blocks: { fallback: [1], paragraph: [1], subheading: [1] },
        },
      });
      if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready')
        throw new Error('fixture navigation refused');
      const o = opened.outcome;
      const activated = await scroll.activateOffer(person.authority, {
        commandId: randomUUID(),
        target: {
          kind: 'offer',
          sessionId: o.sessionId,
          offerId: o.offer.offerId,
          expectedIntentRevision: o.intentRevision,
        },
      });
      if (activated.kind !== 'accepted') throw new Error('fixture offer activation refused');
      await scroll.applyEncounterAction(person.authority, {
        commandId: randomUUID(),
        kind: 'like',
        target: { assetId: starter.assetId, assetRevision: starter.revision },
        exposureId: activated.outcome.exposureId,
      });
      expect(
        await scroll.projectActivity({
          v: 1,
          universeId: person.universeId,
          privacyEpoch: 1,
          exposureId: activated.outcome.exposureId,
        }),
      ).toMatchObject({ kind: 'applied' });

      const saved = await useCases.applyAction(person.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target: { assetId: asset.assetId, assetRevision: 1 },
      });
      if (saved.kind !== 'applied') throw new Error('fixture save refused');
      // Actual retained membership with a latest private place: every registered store remains covered.
      const membership = await database.db
        .selectFrom('experience.saved_items')
        .select('saved_entry_id')
        .where('universe_id', '=', person.universeId)
        .where('asset_id', '=', asset.assetId)
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('experience.saved_places')
        .values({
          universe_id: person.universeId,
          saved_entry_id: membership.saved_entry_id,
          place_revision: '2',
          position: JSON.stringify({ kind: 'reel', positionMs: 1234.5 }),
        })
        .execute();

      await applyEvidence({ v: 1, universeId: person.universeId, privacyEpoch: 1, actionId: saved.outcome.actionId });
      await withPersonalScope(person.authority, async (scope) => {
        const runId = randomUUID();
        await ledger.admitRun(scope, fixtureRunDescriptor(runId));
        await ledger.reserve(scope, fixtureReservation(randomUUID(), runId, 'a'));
        // Authored erasure-only fixture rows, never provider output or runtime planning evidence.
        const plannerRunId = randomUUID(),
          tx = transactionOf(scope);
        await tx
          .insertInto('supply.requests')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: randomUUID(),
            command: { version: 'content-request.v1', fixture: 'Authored erasure-only private ask' },
            state: 'unavailable',
            request_revision: 1,
            revision: 1,
            decision: 'refuse',
            reason: 'unsupported_request',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        // Authored Scene erasure-only payloads: seed ALL new stores without claiming projection/formation.
        const sceneObjectId = randomUUID(),
          sceneChunkId = randomUUID(),
          sceneSystemId = randomUUID();
        const sceneFixture = { fixture: 'Authored CI erasure-only scene payload' };
        for (const epoch of [3, 6])
          for (const revision of [8, 17])
            await tx
              .insertInto('scenes.manifests')
              .values({
                universe_id: person.universeId,
                privacy_epoch: epoch,
                scene_revision: revision,
                payload: sceneFixture,
              })
              .execute();
        await tx
          .insertInto('scenes.manifests')
          .values({ universe_id: person.universeId, privacy_epoch: 1, scene_revision: 1, payload: sceneFixture })
          .execute();
        await tx
          .insertInto('scenes.chunks')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            scene_revision: 1,
            chunk_id: sceneChunkId,
            system_id: sceneSystemId,
            payload: sceneFixture,
          })
          .execute();
        await tx
          .insertInto('scenes.objects')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            object_id: sceneObjectId,
            system_id: sceneSystemId,
            chunk_id: sceneChunkId,
            slot: 0,
            payload: sceneFixture,
          })
          .execute();
        await tx
          .insertInto('scenes.state')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            policy_version: 'canonical-lattice.v1',
            world_seed: 'a'.repeat(64),
            scene_revision: 1,
            payload: sceneFixture,
          })
          .execute();
        // Authored Geography erasure-only rows. No fixture object is installed in runtime.
        const geographyRunId = randomUUID(),
          geographyObjectId = randomUUID(),
          geographyTransitionId = randomUUID();
        await tx
          .insertInto('geography.runs')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: geographyRunId,
            desired_revision: 1,
            status: 'accepted',
          })
          .execute();
        await tx
          .insertInto('geography.state')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            structure_revision: 1,
            desired_revision: 1,
          })
          .execute();
        await tx
          .insertInto('geography.objects')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: geographyObjectId,
            semantic_key: 'system:ci-erasure:factual',
            payload: { fixture: 'Authored erasure-only geography object' },
            support_refs: JSON.stringify([]),
          })
          .execute();
        await tx
          .insertInto('geography.relations')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: randomUUID(),
            semantic_key: 'ci-erasure-route',
            kind: 'route',
            payload: { fixture: 'Authored erasure-only relation' },
            support_refs: JSON.stringify([]),
          })
          .execute();
        await tx
          .insertInto('geography.deltas')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            transition_id: geographyTransitionId,
            run_id: geographyRunId,
            policy_version: 'geography-passive.v1',
            input_sha256: 'a'.repeat(64),
            payload: { fixture: 'Authored erasure-only delta' },
          })
          .execute();
        await tx
          .insertInto('planner.runs')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: plannerRunId,
            revision: 1,
            status: 'accepted',
            context_version: 'planner-context.v0',
            context: { fixture: 'Authored erasure fixture; not a provider result' },
          })
          .execute();
        await tx
          .insertInto('planner.state')
          .values({ universe_id: person.universeId, privacy_epoch: 1, desired_revision: 1, accepted_revision: 1 })
          .execute();
        await tx
          .insertInto('planner.revisions')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            revision: 1,
            run_id: plannerRunId,
            context_revision: 1,
            attempt_id: randomUUID(),
            policy_version: 'personal-planner.v0',
            // Explicit JSON text: pg otherwise encodes a JS array as a PostgreSQL array.
            opportunities: JSON.stringify([]),
          })
          .execute();
      });
    };
    try {
      await seed(erased);
      await seed(kept);
      const before = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(before.erased).every((count) => count > 0)).toBe(true);
      const command = body();
      await cases().start(authority(erased), command);
      await cases().process(job(erased, command.commandId));
      const after = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      for (const [name, count] of Object.entries(after.erased)) {
        const retained = [
          'experience.saved_items',
          'experience.saved_places',
          'reasoning.external_attempts',
          'reasoning.business_runs',
        ].includes(name);
        expect(count, name).toBe(retained ? before.erased[name] : 0);
      }
      expect(after.kept).toEqual(before.kept);
    } finally {
      await useCases.close();
      await scroll.close();
    }
    const jobs = async (universeId: string) =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pgboss.job where data ->> 'universeId' = ${universeId}`.execute(database.db)
      ).rows[0]?.n;
    expect(await jobs(erased.universeId)).toBe(0);
    expect(await jobs(kept.universeId)).toBeGreaterThan(0);
  });

  it('bounds the captured set and rejects oversized accounting identity before publishing a barrier', async () => {
    const p = await seedPerson(db()),
      runId = randomUUID();
    await db()
      .insertInto('reasoning.business_runs')
      .values({ universe_id: p.universeId, id: runId, owner_module: 'fixture', purpose: 'fixture', privacy_epoch: 1 })
      .execute();
    await sql`insert into reasoning.external_attempts(universe_id,id,run_id,step,provider,model,request_hash,role_id,role_version,budget_window,reserved_tokens)
    select ${p.universeId}::uuid,gen_random_uuid(),${runId}::uuid,'fixture.'||n,'fixture','fixture',repeat('a',64),'fixture.clear','v1',(now() at time zone 'UTC')::date,100 from generate_series(1,1001) n`.execute(
      db(),
    );
    await sql`insert into reasoning.usage_receipts(attempt_id,role_id,role_version,provider,model,budget_window,reserved_tokens)
    select id,role_id,role_version,provider,model,budget_window,reserved_tokens from reasoning.external_attempts where universe_id=${p.universeId}`.execute(
      db(),
    );
    await expect(cases().start(authority(p), body())).rejects.toThrow('CLEAR_ACCOUNTING_UNVERIFIED');
    expect((await root(p)).privacy_epoch).toBe(1);
    await sql`delete from reasoning.usage_receipts where attempt_id in (select id from reasoning.external_attempts where universe_id=${p.universeId})`.execute(
      db(),
    );
    await db().deleteFrom('reasoning.external_attempts').where('universe_id', '=', p.universeId).execute();
    const a = await seedAttempt(p);
    await db()
      .updateTable('reasoning.external_attempts')
      .set({ model: 'x'.repeat(129) })
      .where('id', '=', a.id)
      .execute();
    await expect(cases().start(authority(p), body())).rejects.toThrow('CLEAR_ACCOUNTING_UNVERIFIED');
  });
  it('prunes only captured terminal links after their UTC window and preserves receipts and fresh runs', async () => {
    const p = await seedPerson(db()),
      old = await seedAttempt(p, 'succeeded');
    await sql`update reasoning.external_attempts set budget_window=(now() at time zone 'UTC')::date-1 where id=${old.id}`.execute(
      db(),
    );
    await sql`update reasoning.usage_receipts set budget_window=(now() at time zone 'UTC')::date-1 where attempt_id=${old.id}`.execute(
      db(),
    );
    const receiptBefore = await db().selectFrom('reasoning.usage_receipts').selectAll().execute(),
      input = body();
    await cases().start(authority(p), input);
    // Separate core completion allows a real new-epoch run before old accounting cleanup.
    await makeWithClearMaintenance(db(), { lockTimeoutMs: 5000 })(p.accountId, input.commandId, async (scope) => {
      if (!isClearCore(scope)) throw new Error('fixture expected core');
      await core(scope);
      await clearStore.coreDone(scope);
    });
    const freshId = randomUUID();
    await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })({ ...p.authority, privacyEpoch: 2 }, (scope) =>
      old.ledger.admitRun(scope, {
        id: freshId,
        ownerModule: 'fixture',
        purpose: 'fresh-context',
        roleId: 'fixture.clear',
        roleVersion: 'v1',
        policyVersion: 'v1',
        provider: 'fixture',
        model: 'fixture',
        contextBundleRef: 'fresh-context',
        contextRefs: ['fresh-context'],
      }),
    );
    await makeWithClearMaintenance(db(), { lockTimeoutMs: 5000 })(p.accountId, input.commandId, async (scope) => {
      if (isClearCore(scope)) throw new Error('fixture expected accounting');
      // UTC decision is independent from a connection's civil timezone, including UTC+14.
      await sql`set local time zone 'Pacific/Kiritimati'`.execute(clearAccountingTransactionOf(scope));
      expect(await clearReasoning.verifyAndPrune(scope)).toBe('verified');
    });
    expect(
      await db().selectFrom('reasoning.external_attempts').select('id').where('id', '=', old.id).executeTakeFirst(),
    ).toBeUndefined();
    expect(await db().selectFrom('reasoning.usage_receipts').selectAll().execute()).toEqual(receiptBefore);
    expect(
      await db().selectFrom('reasoning.business_runs').select('purpose').where('id', '=', freshId).executeTakeFirst(),
    ).toEqual({ purpose: 'fresh-context' });
  });
  it('inventories account-lifetime receipts, restricts ownership, and preserves them across later Clears', async () => {
    const p = await seedPerson(db()),
      q = await seedPerson(db()),
      input = body();
    await cases().start(authority(p), input);
    await cases().process(job(p, input.commandId));
    expect(await checkErasureInventory(db(), personalStores)).toEqual([]);
    const omitted = personalStores.map((d) =>
      d.module === 'identity'
        ? { ...d, accountTables: d.accountTables?.filter((t) => !t.table.startsWith('clear_')) }
        : d,
    );
    expect(await checkErasureInventory(db(), omitted)).toEqual(
      expect.arrayContaining([
        'identity.clear_operations holds account records but no module declares it as an account table',
        'identity.clear_liabilities holds account records but no module declares it as an account table',
      ]),
    );
    const before = await db().selectFrom('identity.clear_operations').selectAll().execute();
    const next = body(2);
    await cases().start(authority(p, 2), next);
    await cases().process(job(p, next.commandId));
    expect(
      await db()
        .selectFrom('identity.clear_operations')
        .selectAll()
        .where('command_id', '=', input.commandId)
        .execute(),
    ).toEqual(before);
    await expect(db().deleteFrom('identity.accounts').where('id', '=', p.accountId).execute()).rejects.toThrow();
    await expect(
      db()
        .insertInto('identity.clear_operations')
        .values({
          id: randomUUID(),
          account_id: q.accountId,
          scope_id: p.universeId,
          command_id: randomUUID(),
          request_hash: 'a'.repeat(64),
          from_epoch: 1,
          to_epoch: 2,
        })
        .execute(),
    ).rejects.toThrow('clear_operation_owner_binding');
  });
  it('cannot complete when composition omits an owner or skips the verified runner', async () => {
    const p = await seedPerson(db()),
      input = body();
    await cases().start(authority(p), input);
    await expect(custom({ eraseCore: () => Promise.resolve() }).process(job(p, input.commandId))).rejects.toThrow(
      'CLEAR_REMOVAL_UNVERIFIED',
    );
    const omitted = explorationStores.filter((d) => d.module !== 'experience');
    await expect(
      custom({
        eraseCore: async (scope) => {
          await eraseExploration(scope, omitted);
        },
      }).process(job(p, input.commandId)),
    ).rejects.toThrow('CLEAR_INVENTORY_UNVERIFIED');
    expect((await root(p)).clear_operation_id).not.toBeNull();
    expect(await status(p)).toMatchObject({ value: { value: { status: 'pending', phase: 'removing_live_data' } } });
  });
});
