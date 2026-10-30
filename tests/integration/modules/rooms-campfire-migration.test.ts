/**
 * Migration 0069 over rooms that already exist (v3 R-1): a database that stops at schema 0068 gets rooms, members
 * and a discussion with a message, then takes every pending migration as `migrate` does on dev. Every old room gets
 * one General, old discussions become topics with their messages untouched, and old members get the AI level of
 * their room (Lively in an open room, Quieter otherwise) with nothing kept out and the notice unread.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';

describe('migration 0069 over existing rooms (real PostgreSQL)', () => {
  let empty: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: ReturnType<typeof createDatabase<Database>>;
  let migrator: ReturnType<typeof createDatabase<unknown>>;

  beforeAll(async () => {
    empty = await createEmptyDatabase('migration_0069');
    const settings = {
      url: empty.url,
      applicationName: 'knowscroll-it-migration-0069',
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

  it('gives every old room a General, keeps old discussions as topics and gives old members their room’s default level', async () => {
    const migrations = loadMigrations();
    const before = migrations.slice(
      0,
      migrations.findIndex((migration) => migration.name.startsWith('0069_')),
    );
    expect(await migrateToLatest(migrator.db, before)).toMatchObject({ kind: 'migrated' });

    const created = new Date('2026-10-01T10:00:00Z');
    const rooms = [
      { roomId: randomUUID(), slug: 'old-open-room', joinRule: 'open' },
      { roomId: randomUUID(), slug: 'old-invite-room', joinRule: 'invite_only' },
    ] as const;
    for (const room of rooms)
      await handle.db
        .insertInto('rooms.rooms')
        .values({
          room_id: room.roomId,
          slug: room.slug,
          name: room.slug,
          description: 'A room made before General',
          topic_kind: 'system',
          topic_id: 'machine-learning',
          join_rule: room.joinRule,
          created_at: created,
        })
        .execute();
    const accountId = randomUUID();
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    for (const room of rooms)
      await handle.db
        .insertInto('rooms.members')
        .values({ room_id: room.roomId, account_id: accountId, joined_at: created })
        .execute();
    const oldDiscussion = randomUUID();
    await handle.db
      .insertInto('rooms.discussions')
      .values({
        discussion_id: oldDiscussion,
        room_id: rooms[0].roomId,
        title: 'A discussion from before',
        started_by_account_id: accountId,
        last_sequence: 1,
        last_change_sequence: 1,
        last_activity_at: created,
        created_at: created,
      })
      .execute();
    await handle.db
      .insertInto('rooms.messages')
      .values({
        discussion_id: oldDiscussion,
        sequence: 1,
        message_id: randomUUID(),
        change_sequence: 1,
        command_id: randomUUID(),
        author_kind: 'person',
        author_account_id: accountId,
        recorded_at: created,
        body_text: 'Words from before',
      })
      .execute();

    const rest = await migrateToLatest(migrator.db, migrations);
    expect(rest).toMatchObject({ kind: 'migrated' });
    expect(rest.kind === 'migrated' && rest.applied).toContain('0069_room_campfire');

    const discussions = await handle.db
      .selectFrom('rooms.discussions')
      .select(['room_id', 'kind', 'title', 'started_by_account_id', 'last_sequence', 'discussion_id'])
      .orderBy('title')
      .execute();
    for (const room of rooms) {
      const generals = discussions.filter((row) => row.room_id === room.roomId && row.kind === 'general');
      expect(generals, room.slug).toHaveLength(1);
      expect(generals[0]).toMatchObject({ title: 'General', started_by_account_id: null });
      expect(Number(generals[0]!.last_sequence)).toBe(0);
    }
    expect(discussions.find((row) => row.discussion_id === oldDiscussion)).toMatchObject({ kind: 'topic' });
    const messages = await handle.db.selectFrom('rooms.messages').select('body_text').execute();
    expect(messages).toEqual([{ body_text: 'Words from before' }]);

    const members = await handle.db
      .selectFrom('rooms.members')
      .select(['room_id', 'ai_level', 'keep_out', 'notice_seen_at'])
      .execute();
    expect(members.find((row) => row.room_id === rooms[0].roomId)).toMatchObject({
      ai_level: 'lively',
      keep_out: false,
      notice_seen_at: null,
    });
    expect(members.find((row) => row.room_id === rooms[1].roomId)).toMatchObject({
      ai_level: 'quieter',
      keep_out: false,
      notice_seen_at: null,
    });
    // The presence table starts empty: nobody is claimed to be anywhere.
    expect(await handle.db.selectFrom('rooms.room_presence').select('room_id').execute()).toEqual([]);
  }, 120_000);
});
