import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSettings } from '@knowscroll/backend/infrastructure/config';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import {
  createDatabase,
  fencePersonalRecording,
  makeWithPersonalScope,
  migrateToLatest,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  accountAccessUseCases,
  readRecordingLifecycle,
  recordingPolicyFor,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { loadMigrations } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';
import type { FixturePerson } from '../support/fixtures.js';
import { testQueues } from '../support/queues.js';
import { clearRecordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

/** The registry digests that 0044 and 0047 stamped on witnesses (labelled historical constants). */
const DIGEST_STAMPED_AT_SCHEMA = new Map([
  ['0044_', 'ebbec3bda043ab47c5566ebb29e80322e841f4dc15ef7940fc2ee4c053176dc1'],
  ['0047_', 'd7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10'],
]);

/**
 * Each path is a database that stops at the listed schemas, gets a person at each stop, and then
 * takes every pending migration in one batch, as `migrate` does on dev.
 */
const upgradePaths: readonly { readonly title: string; readonly stops: readonly string[] }[] = [
  { title: 'schema 44 straight to the latest (the dev upgrade)', stops: ['0044_'] },
  { title: 'schema 44, then 47, then the latest', stops: ['0044_', '0047_'] },
];

const witnessColumns = `universe_id,privacy_epoch,account_id,protocol_version,origin_kind,clear_operation_id,verified_at`;

describe.each(upgradePaths)(
  'migration 0051 over stamped recording witnesses: $title (real PostgreSQL)',
  ({ stops }) => {
    let empty: Awaited<ReturnType<typeof createEmptyDatabase>>;
    let handle: ReturnType<typeof createDatabase<Database>>;
    let migrator: ReturnType<typeof createDatabase<unknown>>;
    let settings: DatabaseSettings;

    beforeAll(async () => {
      empty = await createEmptyDatabase('migration_0051');
      settings = {
        url: empty.url,
        applicationName: 'knowscroll-it-migration-0051',
        poolMax: 3,
        statementTimeoutMs: 30_000,
      };
      handle = createDatabase<Database>(settings, { onIdleClientError: () => undefined });
      migrator = createDatabase<unknown>(settings, { onIdleClientError: () => undefined });
    });
    afterAll(async () => {
      await handle.close();
      await migrator.close();
      await empty.drop();
    });

    /** An account created through the root insert, whose birth trigger stamps the current witness. */
    async function bornPerson(): Promise<FixturePerson> {
      const accountId = randomUUID();
      const universeId = randomUUID();
      await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
      await handle.db
        .insertInto('identity.universes')
        .values({ id: universeId, account_id: accountId, privacy_epoch: 1, recording_lifecycle_protocol: 1 })
        .execute();
      return {
        accountId,
        universeId,
        authority: { universeId, privacyEpoch: 1, actor: { kind: 'account', accountId } },
      };
    }
    const witnessDigests = (person: FixturePerson) =>
      sql<{
        registry_sha256: string;
      }>`select registry_sha256 from identity.recording_lifecycle_witnesses where universe_id=${person.universeId}::uuid`
        .execute(handle.db)
        .then((result) => result.rows.map((row) => row.registry_sha256));
    /** What the recording-aware commands see for the person's current epoch and recording generation. */
    async function lifecycleOf(person: FixturePerson) {
      const root = await handle.db
        .selectFrom('identity.universes')
        .select(['privacy_epoch', 'recording_generation'])
        .where('id', '=', person.universeId)
        .executeTakeFirstOrThrow();
      const authority = { ...person.authority, privacyEpoch: root.privacy_epoch };
      const outcome = await makeWithPersonalScope(handle.db, { lockTimeoutMs: 5000 })(authority, async (scope) => {
        const own = await accountAccessUseCases({ db: handle.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope);
        if (own.kind !== 'active') throw new Error('own account unavailable');
        const recording = await fencePersonalRecording(scope, root.recording_generation);
        if (recording.kind !== 'recording') throw new Error('recording unavailable');
        return readRecordingLifecycle(recording.scope);
      });
      if (outcome.kind !== 'entered') throw new Error('personal scope refused');
      return outcome.value;
    }
    const witnessRows = (person: FixturePerson) =>
      sql
        .raw<Record<string, unknown>>(
          `select ${witnessColumns} from identity.recording_lifecycle_witnesses where universe_id='${person.universeId}' order by privacy_epoch`,
        )
        .execute(handle.db)
        .then((result) => result.rows);

    it('keeps every witness valid: open, navigate, Pause, Resume and Clear still work', async () => {
      const migrations = loadMigrations();
      const through = (prefix: string) =>
        migrations.slice(0, migrations.findIndex((m) => m.name.startsWith(prefix)) + 1);

      const upgraded: FixturePerson[] = [];
      for (const stop of stops) {
        expect(await migrateToLatest(migrator.db, through(stop))).toMatchObject({ kind: 'migrated' });
        const person = await bornPerson();
        expect(await witnessDigests(person)).toEqual([DIGEST_STAMPED_AT_SCHEMA.get(stop)]);
        upgraded.push(person);
      }
      const witnessesBefore = await Promise.all(upgraded.map(witnessRows));

      const rest = await migrateToLatest(migrator.db, migrations);
      expect(rest).toMatchObject({ kind: 'migrated' });
      expect(rest.kind === 'migrated' && rest.applied).toContain('0051_recording_witness_without_digest');

      expect(await Promise.all(upgraded.map(witnessRows))).toEqual(witnessesBefore);
      const columns = await sql<{
        column_name: string;
      }>`select column_name from information_schema.columns where table_schema='identity' and table_name='recording_lifecycle_witnesses'`.execute(
        handle.db,
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(witnessColumns.split(',').sort());
      for (const person of upgraded) expect(await lifecycleOf(person)).toEqual({ kind: 'fresh', protocolVersion: 1 });
      const [oldest, newest] = [upgraded[0]!, upgraded.at(-1)!];
      // Witnesses stay immutable: no guard trigger was left disabled.
      await expect(
        sql`update identity.recording_lifecycle_witnesses set verified_at=now() where universe_id=${oldest.universeId}::uuid`.execute(
          handle.db,
        ),
      ).rejects.toThrow('recording_lifecycle_witness_immutable');

      // The queues and pg-boss schema the Experience and Clear use cases write to.
      const installer = createBoss(settings, 'install', { onError: () => undefined, onWarning: () => undefined });
      await installer.start();
      await applyQueueDeclarations(installer, testQueues);

      const database = { ...handle, name: empty.name, settings, drop: () => Promise.resolve() };
      const cases = await scrollUseCases(database, { recording: true, buffers: true });
      try {
        for (const title of ['First explanation', 'Second explanation']) {
          const source = starterSource() as {
            assetId: string;
            draft: { title: string };
            publication: { explanationUnitId: string };
          };
          source.assetId = randomUUID();
          source.publication.explanationUnitId = `migration-0051-${randomUUID()}`;
          source.draft = { ...source.draft, title };
          expect((await cases.importScroll(source)).kind).toBe('imported');
        }
        /** Open, activate and navigate on the upgraded schema. */
        const encounterWorks = async (person: FixturePerson) => {
          const opened = await cases.navigate(person.authority, {
            commandId: randomUUID(),
            target: { kind: 'discover' },
            capabilities: textCapabilities,
          });
          if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready') throw new Error('open must be ready');
          const { sessionId, intentRevision, offer } = opened.outcome;
          const activated = await cases.activateOffer(person.authority, {
            commandId: randomUUID(),
            target: { kind: 'offer', sessionId, offerId: offer.offerId, expectedIntentRevision: intentRevision },
          });
          if (activated.kind !== 'accepted') throw new Error('activation must be accepted');
          expect(
            await cases.navigate(person.authority, {
              commandId: randomUUID(),
              sessionId,
              expectedIntentRevision: intentRevision,
              from: { offerId: offer.offerId, exposureId: activated.outcome.exposureId },
              intent: { mode: 'vertical', direction: 'next' },
            }),
          ).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
        };
        for (const person of upgraded) await encounterWorks(person);

        // Pause and Resume on a stamped witness.
        const policy = recordingPolicyFor(handle.db, { lockTimeoutMs: 5000 });
        const setRecording = (generation: number, on: boolean) =>
          policy.set(newest.authority, {
            version: 'recording-policy.v1',
            commandId: randomUUID(),
            expectedPrivacyEpoch: 1,
            expectedRecordingGeneration: generation,
            on,
          });
        expect(await setRecording(1, false)).toMatchObject({ kind: 'ok' });
        expect(await setRecording(2, true)).toMatchObject({ kind: 'ok' });
        expect(await lifecycleOf(newest)).toEqual({ kind: 'fresh', protocolVersion: 1 });
        await encounterWorks(newest);

        // Clear on a stamped witness installs the next epoch's witness, and encounters still work.
        const boss = createBoss(settings, 'install', { onError: () => undefined, onWarning: () => undefined });
        await boss.start();
        try {
          await clearRecordingPerson(database, boss, oldest);
        } finally {
          await boss.stop({ graceful: false });
        }
        expect((await witnessRows(oldest)).map((row) => [row.privacy_epoch, row.origin_kind])).toEqual([
          [2, 'clear_core'],
        ]);
        expect(await lifecycleOf(oldest)).toEqual({ kind: 'fresh', protocolVersion: 1 });
        await encounterWorks({ ...oldest, authority: { ...oldest.authority, privacyEpoch: 2 } });

        // A person who joins after 0051 is witnessed at birth without any digest.
        const newcomer = await bornPerson();
        expect((await witnessRows(newcomer)).map((row) => [row.privacy_epoch, row.origin_kind])).toEqual([
          [1, 'birth'],
        ]);
        expect(await lifecycleOf(newcomer)).toEqual({ kind: 'fresh', protocolVersion: 1 });
        await encounterWorks(newcomer);

        // Control: the check above sees a missing witness (only full erasure removes one).
        await sql`delete from identity.recording_lifecycle_witnesses where universe_id=${newcomer.universeId}::uuid`.execute(
          handle.db,
        );
        expect(await lifecycleOf(newcomer)).toEqual({ kind: 'not_ready' });
      } finally {
        await cases.close();
        await installer.stop({ graceful: false });
      }
    });
  },
);
