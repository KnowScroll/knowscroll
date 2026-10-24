/**
 * "Not interested" (P03, D-055) over real PostgreSQL: idempotent receipts, Undo, Composer's exclusion
 * of the marked asset, a lapse by itself, no evidence, and the three erasures. CI fixture Scrolls and
 * accounts; no provider.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  PREPARE_COMPOSER_BUFFER,
  prepareBufferQueue,
  type PrepareBuffer,
  type PrepareBufferJob,
} from '@knowscroll/backend/modules/composer';
import { composerBufferWorkerProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { READ_COMPOSER_CONTEXT } from '@knowscroll/backend/modules/personal-context';
import { REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness } from '../support/fixture-model.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  expect(result).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}

describe('Not interested (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: Cases;
  let boss: ReturnType<typeof createBoss>;
  const assets: { assetId: string; assetRevision: number }[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('feedback_not_interested');
    cases = await scrollUseCases(database);
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    // Exactly two explanations, so "the other one" is the only thing a next subject can offer.
    for (const title of ['First explanation', 'Second explanation']) assets.push(await admit(title));
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await cases.close();
    await database.drop();
  });

  async function admit(title: string) {
    const source = starterSource() as { assetId: string; title?: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `fixture-not-interested-${randomUUID()}`;
    if (source.title !== undefined) source.title = title;
    const imported = await cases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    return { assetId: imported.assetId, assetRevision: imported.revision };
  }

  /** Opens Explore and activates the first offer, like the client does. */
  async function openAndActivate(person: FixturePerson) {
    const open = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
      }),
    );
    const activated = await cases.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: open.sessionId,
        offerId: open.offer.offerId,
        expectedIntentRevision: open.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error('fixture activation refused');
    return { open, from: { offerId: open.offer.offerId, exposureId: activated.outcome.exposureId } };
  }
  const nextSubject = (person: FixturePerson, open: Ready, from: { offerId: string; exposureId: string }) =>
    cases.navigate(person.authority, {
      commandId: randomUUID(),
      sessionId: open.sessionId,
      expectedIntentRevision: open.intentRevision,
      from,
      intent: { mode: 'vertical', direction: 'next' },
    });
  const mark = (person: FixturePerson, assetId: string, commandId = randomUUID()) =>
    cases.notInterested.set(person.authority, { commandId, assetId });
  const markedAssets = async (universeId: string) =>
    (
      await database.db
        .selectFrom('experience.not_interested')
        .select('asset_id')
        .where('universe_id', '=', universeId)
        .execute()
    ).map((row) => row.asset_id);
  const countOf = async (table: string, universeId: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*)::text as n from ${sql.table(table)} where universe_id = ${universeId}::uuid`.execute(
          database.db,
        )
      ).rows[0]?.n ?? 0,
    );

  it('marks an asset for fourteen days and answers a retry from the receipt', async () => {
    const person = await seedPerson(database.db);
    const commandId = randomUUID();
    const first = await mark(person, assets[0]!.assetId, commandId);
    if (first.kind !== 'applied') throw new Error('expected applied');
    const days = (new Date(first.outcome.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(first.outcome.replayed).toBe(false);

    const again = await mark(person, assets[0]!.assetId, commandId);
    expect(again).toMatchObject({ kind: 'applied', outcome: { expiresAt: first.outcome.expiresAt, replayed: true } });
    expect(await markedAssets(person.universeId)).toEqual([assets[0]!.assetId]);
    expect(await mark(person, assets[1]!.assetId, commandId)).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });

  it('refuses an asset that does not exist or is withdrawn, and writes nothing', async () => {
    const person = await seedPerson(database.db);
    expect(await mark(person, randomUUID())).toEqual({ kind: 'refused', reason: 'asset_not_found' });
    const withdrawn = await admit('Withdrawn explanation');
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', withdrawn.assetId)
      .execute();
    expect(await mark(person, withdrawn.assetId)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
    expect(await markedAssets(person.universeId)).toEqual([]);
    expect(await countOf('receipts.personal_commands', person.universeId)).toBe(0);
  });

  it('keeps the marked asset out of the next subject, and Undo brings it back', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    const other = assets.find((asset) => asset.assetId !== open.offer.assetId)!;

    expect(await mark(person, other.assetId)).toMatchObject({ kind: 'applied' });
    // The other explanation is excluded and the one on screen never repeats: the honest answer is exhaustion.
    const exhausted = await nextSubject(person, open, from);
    expect(exhausted).toMatchObject({
      kind: 'accepted',
      outcome: { status: 'exhausted', reason: 'no_eligible_content' },
    });
    // The refused move still advances the session's intent revision; the next move names it.
    const afterExhausted = {
      ...open,
      intentRevision: exhausted.kind === 'accepted' ? exhausted.outcome.intentRevision : 0,
    };

    expect(
      await cases.notInterested.undo(person.authority, { commandId: randomUUID(), assetId: other.assetId }),
    ).toMatchObject({
      kind: 'applied',
      outcome: { assetId: other.assetId, replayed: false },
    });
    expect(await markedAssets(person.universeId)).toEqual([]);
    expect(ready(await nextSubject(person, afterExhausted, from)).offer.assetId).toBe(other.assetId);
  });

  it('lets the asset return once the mark has lapsed, with no sweep needed', async () => {
    const person = await seedPerson(database.db);
    const { open, from } = await openAndActivate(person);
    const other = assets.find((asset) => asset.assetId !== open.offer.assetId)!;
    await mark(person, other.assetId);
    await sql`update experience.not_interested set marked_at = now() - interval '15 days', expires_at = now() - interval '1 day'
      where universe_id = ${person.universeId}::uuid`.execute(database.db);
    expect(ready(await nextSubject(person, open, from)).offer.assetId).toBe(other.assetId);
  });

  it('is one person’s constraint: another person is still offered the asset', async () => {
    const marker = await seedPerson(database.db);
    const other = await seedPerson(database.db);
    await mark(marker, assets[0]!.assetId);
    await mark(marker, assets[1]!.assetId);
    const started = await openAndActivate(other);
    expect(assets.map((asset) => asset.assetId)).toContain(started.open.offer.assetId);
    // The marker, with both marked, is offered nothing to open in Explore.
    expect(
      await cases.navigate(marker.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
      }),
    ).toMatchObject({ kind: 'accepted', outcome: { status: 'exhausted' } });
  });

  it('undoing what was never marked, or marked by an earlier command, succeeds and changes nothing else', async () => {
    const person = await seedPerson(database.db);
    const undo = (assetId: string, commandId = randomUUID()) =>
      cases.notInterested.undo(person.authority, { commandId, assetId });
    expect(await undo(assets[0]!.assetId)).toMatchObject({ kind: 'applied' });
    await mark(person, assets[0]!.assetId);
    const commandId = randomUUID();
    expect(await undo(assets[0]!.assetId, commandId)).toMatchObject({ kind: 'applied', outcome: { replayed: false } });
    expect(await undo(assets[0]!.assetId, commandId)).toMatchObject({ kind: 'applied', outcome: { replayed: true } });
    expect(await markedAssets(person.universeId)).toEqual([]);
  });

  it('is no evidence: no action, exposure, observation or job, and Hide stays a separate constraint', async () => {
    const person = await seedPerson(database.db);
    const tables = ['experience.actions', 'experience.action_state', 'experience.exposures', 'evidence.action_events'];
    const before = await Promise.all(tables.map((table) => countOf(table, person.universeId)));
    const jobs = async () =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from pgboss.job where data ->> 'universeId' = ${person.universeId}`.execute(
            database.db,
          )
        ).rows[0]?.n ?? 0,
      );
    expect(await jobs()).toBe(0);
    await mark(person, assets[0]!.assetId);
    await cases.notInterested.undo(person.authority, { commandId: randomUUID(), assetId: assets[0]!.assetId });
    expect(await Promise.all(tables.map((table) => countOf(table, person.universeId)))).toEqual(before);
    expect(await jobs()).toBe(0);
  });

  it('keeps at most 500 assets per person, dropping the oldest', async () => {
    const person = await seedPerson(database.db);
    const crowd: string[] = [];
    for (let index = 0; index < 500; index++) {
      const asset = await database.db
        .insertInto('content.assets')
        .values({ id: randomUUID(), revision: 1, kind: 'reel', status: 'admitted' })
        .returning('id')
        .executeTakeFirstOrThrow();
      crowd.push(asset.id);
    }
    await sql`insert into experience.not_interested (universe_id, privacy_epoch, asset_id, marked_at, expires_at)
      select ${person.universeId}::uuid, 1, id, now() - interval '1 day' - (n || ' seconds')::interval, now() + interval '13 days'
      from unnest(${crowd}::uuid[]) with ordinality as asset(id, n)`.execute(database.db);
    expect(await markedAssets(person.universeId)).toHaveLength(500);
    expect(await mark(person, assets[0]!.assetId)).toMatchObject({ kind: 'applied' });
    const kept = await markedAssets(person.universeId);
    expect(kept).toHaveLength(500);
    expect(kept).toContain(assets[0]!.assetId);
    // The oldest mark made room for the new one.
    expect(kept).not.toContain(crowd[499]);
  });

  it('is rechecked when a prepared buffer is served: a marked asset in it makes the buffer drift', async () => {
    const buffered = await scrollUseCases(database, { buffers: true });
    try {
      const withScope = Symbol('test.withPersonalScope');
      const workerConfig = Symbol('test.workerConfig');
      const { harness } = fixtureHarness(database.db, { model: undefined });
      const values = new Map<symbol, unknown>([
        [withScope, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
        [workerConfig, { jevEnabled: false, reasoning: { minimax: { model: 'fixture-model-v1' } } }],
        [REASONING_HARNESS, harness],
        [READ_COMPOSER_CONTEXT, buffered.readComposerContext],
        ...[
          ...experienceBufferSourceProviders(),
          ...composerProviders({ isOperator: () => false }),
          ...contentProviders(),
        ].map((provider) => [provider.provide, provider.useValue] as const),
      ]);
      const prepare = buildFromProviders(
        composerBufferWorkerProviders({ withPersonalScope: withScope, workerConfig }),
        PREPARE_COMPOSER_BUFFER,
        values,
      ) as PrepareBuffer;

      const person = await seedPerson(database.db);
      const open = ready(
        await buffered.navigate(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'discover' },
          capabilities: textCapabilities,
        }),
      );
      const activated = await buffered.activateOffer(person.authority, {
        commandId: randomUUID(),
        target: {
          kind: 'offer',
          sessionId: open.sessionId,
          offerId: open.offer.offerId,
          expectedIntentRevision: open.intentRevision,
        },
      });
      if (activated.kind !== 'accepted') throw new Error('fixture activation refused');
      const from = { offerId: open.offer.offerId, exposureId: activated.outcome.exposureId };
      const [job] = (
        await sql<{
          data: PrepareBufferJob;
        }>`select data from pgboss.job where name = ${prepareBufferQueue.name} and data ->> 'universeId' = ${person.universeId}`.execute(
          database.db,
        )
      ).rows;
      await prepare(job!.data, { jobId: randomUUID(), signal: new AbortController().signal });
      const buffer = (
        await sql<{
          decision_id: string;
          selection: { assetId: string }[];
        }>`select decision_id, selection from composer.buffers where universe_id = ${person.universeId}::uuid`.execute(
          database.db,
        )
      ).rows[0]!;
      const marked = buffer.selection[0]!.assetId;

      await buffered.notInterested.set(person.authority, { commandId: randomUUID(), assetId: marked });
      const next = await buffered.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: open.sessionId,
        expectedIntentRevision: open.intentRevision,
        from,
        intent: { mode: 'vertical', direction: 'next' },
      });
      expect(next).toMatchObject({ kind: 'accepted' });
      const offered =
        next.kind === 'accepted' && next.outcome.status === 'ready'
          ? [next.outcome.offer, ...next.outcome.bufferedOffers].map((offer) => offer.assetId)
          : [];
      expect(offered).not.toContain(marked);
      expect(
        (await sql`select 1 from composer.buffers where universe_id = ${person.universeId}::uuid`.execute(database.db))
          .rows,
      ).toEqual([]);
    } finally {
      await buffered.close();
    }
  });

  describe('erasure', () => {
    it('is deleted by Clear and by account deletion, and listed in the person’s export', async () => {
      const person = await recordingPerson(database);
      await mark(person, assets[0]!.assetId);
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const experience = exported.value.sections['experience'] as { notInterested: { items: { title: string }[] } };
      expect(experience.notInterested.items).toMatchObject([{ title: expect.any(String) as string }]);
      // The file says what was marked and until when: no asset ID, and nothing like a score.
      expect(JSON.stringify(experience.notInterested)).not.toContain(assets[0]!.assetId);

      await clearRecordingPerson(database, boss, person);
      expect(await markedAssets(person.universeId)).toEqual([]);

      const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
      await mark(cleared, assets[1]!.assetId);
      expect(await markedAssets(person.universeId)).toEqual([assets[1]!.assetId]);
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(cleared.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await markedAssets(person.universeId)).toEqual([]);
    });
  });
});
