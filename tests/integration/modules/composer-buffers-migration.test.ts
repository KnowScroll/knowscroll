import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSettings } from '@knowscroll/backend/infrastructure/config';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { createDatabase, migrateToLatest, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { RECORDING_LIFECYCLE_PROTOCOL_SHA256 } from '@knowscroll/backend/modules/identity';
import { loadMigrations } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';
import { testQueues } from '../support/queues.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

/** The registry digest 0044 stamped on every account created before 0045 (a labelled historical constant). */
const DIGEST_BEFORE_0045 = 'ebbec3bda043ab47c5566ebb29e80322e841f4dc15ef7940fc2ee4c053176dc1';

describe('migration 0045 over a database that already holds 0044-era accounts (real PostgreSQL)', () => {
  let empty: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: ReturnType<typeof createDatabase<Database>>;
  let migrator: ReturnType<typeof createDatabase<unknown>>;
  let settings: DatabaseSettings;

  beforeAll(async () => {
    empty = await createEmptyDatabase('migration_0045');
    settings = {
      url: empty.url,
      applicationName: 'knowscroll-it-migration-0045',
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

  it('re-stamps the existing witness, so the person can still open, activate and navigate', async () => {
    const migrations = loadMigrations();
    const before0045 = migrations.slice(
      0,
      migrations.findIndex((m) => m.name.startsWith('0045_')),
    );
    expect(before0045.at(-1)?.name).toMatch(/^0044_/);
    expect(await migrateToLatest(migrator.db, before0045)).toMatchObject({ kind: 'migrated' });

    // An account created while schema 44 was current: the root insert trigger stamps the old digest.
    const accountId = randomUUID();
    const universeId = randomUUID();
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    await handle.db
      .insertInto('identity.universes')
      .values({ id: universeId, account_id: accountId, privacy_epoch: 1, recording_lifecycle_protocol: 1 })
      .execute();
    const witness = () =>
      sql<{
        registry_sha256: string;
      }>`select registry_sha256 from identity.recording_lifecycle_witnesses where universe_id=${universeId}::uuid`
        .execute(handle.db)
        .then((result) => result.rows.map((row) => row.registry_sha256));
    expect(await witness()).toEqual([DIGEST_BEFORE_0045]);

    expect(await migrateToLatest(migrator.db, migrations)).toMatchObject({
      kind: 'migrated',
      applied: [expect.stringMatching(/^0045_/) as unknown as string],
    });
    expect(await witness()).toEqual([RECORDING_LIFECYCLE_PROTOCOL_SHA256]);
    const constraint = await sql<{
      convalidated: boolean;
    }>`select convalidated from pg_constraint where conname='recording_lifecycle_witnesses_registry_sha256_check'`.execute(
      handle.db,
    );
    expect(constraint.rows).toEqual([{ convalidated: true }]);
    // The guard trigger is back on: witnesses are immutable again.
    await expect(
      sql`update identity.recording_lifecycle_witnesses set registry_sha256=${DIGEST_BEFORE_0045} where universe_id=${universeId}::uuid`.execute(
        handle.db,
      ),
    ).rejects.toThrow();

    // The queues and pg-boss schema the Experience use cases write to.
    const installer = createBoss(settings, 'install', { onError: () => undefined, onWarning: () => undefined });
    await installer.start();
    await applyQueueDeclarations(installer, testQueues);
    await installer.stop({ graceful: false });

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
        source.publication.explanationUnitId = `migration-0045-${randomUUID()}`;
        source.draft = { ...source.draft, title };
        expect((await cases.importScroll(source)).kind).toBe('imported');
      }
      const authority = { universeId, privacyEpoch: 1, actor: { kind: 'account' as const, accountId } };
      const opened = await cases.navigate(authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
      });
      if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready') throw new Error('open must be ready');
      const { sessionId, intentRevision, offer } = opened.outcome;
      const activated = await cases.activateOffer(authority, {
        commandId: randomUUID(),
        target: { kind: 'offer', sessionId, offerId: offer.offerId, expectedIntentRevision: intentRevision },
      });
      if (activated.kind !== 'accepted') throw new Error('activation must be accepted');
      expect(
        await cases.navigate(authority, {
          commandId: randomUUID(),
          sessionId,
          expectedIntentRevision: intentRevision,
          from: { offerId: offer.offerId, exposureId: activated.outcome.exposureId },
          intent: { mode: 'vertical', direction: 'next' },
        }),
      ).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
    } finally {
      await cases.close();
    }

    // A person who joins after 0045 is stamped with the new digest too.
    const newcomer = randomUUID();
    const newcomerUniverse = randomUUID();
    await handle.db.insertInto('identity.accounts').values({ id: newcomer }).execute();
    await handle.db
      .insertInto('identity.universes')
      .values({ id: newcomerUniverse, account_id: newcomer, privacy_epoch: 1, recording_lifecycle_protocol: 1 })
      .execute();
    const stamped = await sql<{
      registry_sha256: string;
    }>`select registry_sha256 from identity.recording_lifecycle_witnesses where universe_id=${newcomerUniverse}::uuid`.execute(
      handle.db,
    );
    expect(stamped.rows).toEqual([{ registry_sha256: RECORDING_LIFECYCLE_PROTOCOL_SHA256 }]);
  });
});
