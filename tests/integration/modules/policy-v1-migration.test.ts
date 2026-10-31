/**
 * Migrations 0081 and 0082 over data that already exists (v3 S-5): a database that stops at schema 0080 holds a stored
 * Composer decision under policy v0 and Evidence topic counts, then takes every pending migration as `migrate` does on
 * dev. The old decision is kept and new ones may name policy v1; every old count becomes its plain play-level cell;
 * the checks refuse what the code must never write.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';

describe('migrations 0081 and 0082 over existing decisions and counts (real PostgreSQL)', () => {
  let empty: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: ReturnType<typeof createDatabase<Database>>;
  let migrator: ReturnType<typeof createDatabase<unknown>>;

  const universeId = randomUUID();
  const oldDecisionId = randomUUID();

  const decision = (id: string, policyVersion: string, epoch = 1) =>
    sql`insert into composer.decisions (id, universe_id, privacy_epoch, command_id, input_sha256, policy_version, payload, expires_at)
      values (${id}::uuid, ${universeId}::uuid, ${epoch}, ${randomUUID()}::uuid, ${'a'.repeat(64)}, ${policyVersion},
        ${JSON.stringify({ version: 'composer-decision.v0', universeId, privacyEpoch: epoch, policyVersion })}::jsonb, now() + interval '1 day')`.execute(
      handle.db,
    );

  beforeAll(async () => {
    empty = await createEmptyDatabase('policy_v1_migration');
    const settings = {
      url: empty.url,
      applicationName: 'knowscroll-it-migration-0081',
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

  it('keeps a stored v0 decision, accepts v1, refuses any other label, and turns old counts into plain cells', async () => {
    const migrations = loadMigrations();
    const before = migrations.slice(
      0,
      migrations.findIndex((migration) => migration.name.startsWith('0081_')),
    );
    expect(await migrateToLatest(migrator.db, before)).toMatchObject({ kind: 'migrated' });

    const accountId = randomUUID();
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    await handle.db.insertInto('identity.universes').values({ id: universeId, account_id: accountId }).execute();
    await decision(oldDecisionId, 'composer-policy.v0');
    // Before 0081 the label was pinned to v0.
    await expect(decision(randomUUID(), 'composer-policy.v1')).rejects.toThrow(/decisions_policy_version_check/);

    const at = new Date('2026-10-30T10:00:00Z');
    for (const [topic, reel, scroll] of [
      ['earth.seasons', [2, 1], [5, 3]],
      ['space.stars', [0, 0], [4, 4]],
      ['body.immune', [0, 0], [0, 0]],
    ] as const)
      await handle.db
        .insertInto('evidence.topic_context')
        .values({
          universe_id: universeId,
          privacy_epoch: 1,
          topic_id: topic,
          channel_values: JSON.stringify({}),
          activity: 1,
          evaluated_at: at,
          reel_measured: reel[0],
          reel_qualified: reel[1],
          scroll_measured: scroll[0],
          scroll_qualified: scroll[1],
        })
        .execute();

    const rest = await migrateToLatest(migrator.db, migrations);
    expect(rest).toMatchObject({ kind: 'migrated' });
    expect(rest.kind === 'migrated' && rest.applied).toEqual(
      expect.arrayContaining(['0081_composer_policy_v1', '0082_evidence_play_cells']),
    );

    // The old decision is untouched; a decision under v1 is accepted; another label is not.
    const kept = await sql<{
      policy_version: string;
    }>`select policy_version from composer.decisions where id = ${oldDecisionId}::uuid`.execute(handle.db);
    expect(kept.rows).toEqual([{ policy_version: 'composer-policy.v0' }]);
    await decision(randomUUID(), 'composer-policy.v1');
    await expect(decision(randomUUID(), 'composer-policy.v2')).rejects.toThrow(/decisions_policy_version_check/);
    // A decision cannot be rewritten to another policy.
    await expect(
      sql`update composer.decisions set policy_version = 'composer-policy.v1' where id = ${oldDecisionId}::uuid`.execute(
        handle.db,
      ),
    ).rejects.toThrow(/COMPOSER_DECISION_IMMUTABLE/);

    // Every old count becomes its plain cell; a kind or topic with nothing counted gets none.
    const cells = await handle.db
      .selectFrom('evidence.topic_format_cells')
      .select(['topic_id', 'kind', 'play_level', 'measured', 'qualified'])
      .where('universe_id', '=', universeId)
      .orderBy('topic_id')
      .orderBy('kind')
      .execute();
    expect(cells).toEqual([
      { topic_id: 'earth.seasons', kind: 'reel', play_level: 'plain', measured: 2, qualified: 1 },
      { topic_id: 'earth.seasons', kind: 'scroll', play_level: 'plain', measured: 5, qualified: 3 },
      { topic_id: 'space.stars', kind: 'scroll', play_level: 'plain', measured: 4, qualified: 4 },
    ]);
  });

  it('refuses a cell that no reading could make, and a level that does not exist', async () => {
    const cell = (kind: string, level: string, measured: number, qualified: number) =>
      sql`insert into evidence.topic_format_cells (universe_id, privacy_epoch, topic_id, kind, play_level, measured, qualified)
        values (${universeId}::uuid, 1, 'earth.tides', ${kind}, ${level}, ${measured}, ${qualified})`.execute(
        handle.db,
      );
    await expect(cell('scroll', 'game', 1, 2)).rejects.toThrow(/topic_format_cells_check/);
    await expect(cell('scroll', 'game', -1, -1)).rejects.toThrow(/topic_format_cells_check/);
    await expect(cell('scroll', 'game', 1, -1)).rejects.toThrow(/topic_format_cells_check/);
    await expect(cell('scroll', 'expert', 1, 1)).rejects.toThrow(/topic_format_cells_play_level_check/);
    await expect(cell('video', 'plain', 1, 1)).rejects.toThrow(/topic_format_cells_kind_check/);
    await cell('scroll', 'stage', 2, 1);
    await expect(cell('scroll', 'stage', 3, 3)).rejects.toThrow(/topic_format_cells_pkey/);
  });

  it('widens the activity pin to v0 and v1 only', async () => {
    const pin = await sql<{ definition: string }>`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'activity_revisions_policy_version_check'`.execute(handle.db);
    expect(pin.rows).toHaveLength(1);
    expect(pin.rows[0]!.definition).toContain('activity.v0');
    expect(pin.rows[0]!.definition).toContain('activity.v1');
    expect(pin.rows[0]!.definition).not.toContain('activity.v2');
  });
});
