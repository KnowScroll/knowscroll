/**
 * Migration 0070 over rooms that already exist (v3 R-2): a database that stops at schema 0069 gets a room, a member, a
 * discussion with an asked AI contribution and a usage receipt, then takes every pending migration as `migrate` does on
 * dev. Every old room gets the residents its old array named, the old ask becomes an `asked` turn that keeps its
 * provenance, the rooms scope exists, and the checks refuse the shapes the router must never write.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { loadMigrations } from '@knowscroll/migrations';
import { createEmptyDatabase } from '../support/empty-database.js';

describe('migration 0070 over existing rooms (real PostgreSQL)', () => {
  let empty: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: ReturnType<typeof createDatabase<Database>>;
  let migrator: ReturnType<typeof createDatabase<unknown>>;

  beforeAll(async () => {
    empty = await createEmptyDatabase('migration_0070');
    const settings = {
      url: empty.url,
      applicationName: 'knowscroll-it-migration-0070',
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

  it('gives old rooms their residents, keeps old asks as asked turns and adds the rooms scope', async () => {
    const migrations = loadMigrations();
    const before = migrations.slice(
      0,
      migrations.findIndex((migration) => migration.name.startsWith('0070_')),
    );
    expect(await migrateToLatest(migrator.db, before)).toMatchObject({ kind: 'migrated' });

    const created = new Date('2026-10-01T10:00:00Z');
    const roomId = randomUUID();
    const onlyExplainerRoom = randomUUID();
    for (const [id, slug, inhabitants] of [
      [roomId, 'old-both-room', ['explainer', 'skeptic']],
      [onlyExplainerRoom, 'old-one-room', ['explainer']],
    ] as const)
      await handle.db
        .insertInto('rooms.rooms')
        .values({
          room_id: id,
          slug,
          name: slug,
          description: 'A room made before the cast',
          topic_kind: 'system',
          topic_id: 'machine-learning',
          join_rule: 'open',
          inhabitants: [...inhabitants],
          created_at: created,
        })
        .execute();
    const accountId = randomUUID();
    await handle.db.insertInto('identity.accounts').values({ id: accountId }).execute();
    const discussionId = randomUUID();
    await handle.db
      .insertInto('rooms.discussions')
      .values({
        discussion_id: discussionId,
        room_id: roomId,
        title: 'Before the cast',
        last_sequence: 1,
        last_change_sequence: 1,
        last_activity_at: created,
        created_at: created,
      })
      .execute();
    const messageId = randomUUID();
    await handle.db
      .insertInto('rooms.messages')
      .values({
        discussion_id: discussionId,
        sequence: 1,
        message_id: messageId,
        change_sequence: 1,
        author_kind: 'ai',
        inhabitant: 'skeptic',
        ai_kind: 'assumption',
        recorded_at: created,
        body_text: 'Is that so?',
      })
      .execute();
    const requestId = randomUUID();
    await sql`
      insert into rooms.ai_requests (request_id, room_id, discussion_id, inhabitant, requested_by_account_id, command_id,
        state, created_at, settled_at, message_id, role_version, prompt_version, model, dispatched)
      values (${requestId}::uuid, ${roomId}::uuid, ${discussionId}::uuid, 'skeptic', ${accountId}::uuid, ${randomUUID()}::uuid,
        'completed', ${created}, ${created}, ${messageId}::uuid, 'inhabitant.1', 'hp2', 'fixture-model-v1', true)`.execute(
      handle.db,
    );

    const rest = await migrateToLatest(migrator.db, migrations);
    expect(rest).toMatchObject({ kind: 'migrated' });
    expect(rest.kind === 'migrated' && rest.applied).toContain('0070_room_residents');

    const cast = await handle.db
      .selectFrom('rooms.room_cast')
      .select(['room_id', 'inhabitant', 'name', 'position'])
      .orderBy('position')
      .execute();
    expect(cast.filter((row) => row.room_id === roomId)).toMatchObject([
      { inhabitant: 'explainer', name: 'Nova', position: 1 },
      { inhabitant: 'skeptic', name: 'Halley', position: 2 },
    ]);
    expect(cast.filter((row) => row.room_id === onlyExplainerRoom)).toMatchObject([
      { inhabitant: 'explainer', name: 'Nova', position: 1 },
    ]);

    const turn = await handle.db
      .selectFrom('rooms.ai_turns')
      .selectAll()
      .where('turn_id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(turn).toMatchObject({
      trigger: 'asked',
      decided_by: 'asked_bounds',
      cause_message_id: null,
      state: 'completed',
      message_id: messageId,
      role_version: 'inhabitant.1',
      model: 'fixture-model-v1',
    });
    expect(turn.caps).toEqual({});
    expect(await handle.db.selectFrom('rooms.messages').select('trigger').execute()).toEqual([{ trigger: null }]);

    const scopes = await handle.db
      .selectFrom('reasoning.production_scopes')
      .select(['id', 'enabled', 'generation'])
      .orderBy('id')
      .execute();
    expect(scopes).toEqual([
      { id: 'rooms', enabled: true, generation: 1 },
      { id: 'scroll-supply', enabled: false, generation: 1 },
    ]);
    expect(await handle.db.selectFrom('rooms.typing_holds').select('discussion_id').execute()).toEqual([]);
  }, 120_000);

  it('refuses a turn row the router must never write', async () => {
    const [{ room_id: roomId }] = await handle.db
      .selectFrom('rooms.rooms')
      .select('room_id')
      .where('slug', '=', 'old-both-room')
      .execute()
      .then((rows) => rows as [{ room_id: string }]);
    const discussion = await handle.db
      .selectFrom('rooms.discussions')
      .select('discussion_id')
      .where('room_id', '=', roomId)
      .limit(1)
      .executeTakeFirstOrThrow();
    const message = await handle.db.selectFrom('rooms.messages').select('message_id').executeTakeFirstOrThrow();
    const insert = (values: {
      readonly state: string;
      readonly settledAt?: Date;
      readonly dispatched?: boolean;
      readonly trigger: string;
      readonly cause: string | null;
      readonly decidedBy: string;
      readonly command?: string;
    }) =>
      sql`
        insert into rooms.ai_turns (turn_id, room_id, discussion_id, inhabitant, state, created_at, settled_at, dispatched,
          trigger, cause_message_id, decided_by, command_id)
        values (${randomUUID()}::uuid, ${roomId}::uuid, ${discussion.discussion_id}::uuid, 'explainer',
          ${values.state}, now(), ${values.settledAt ?? null}, ${values.dispatched ?? false},
          ${values.trigger}, ${values.cause}::uuid, ${values.decidedBy}, ${values.command ?? null}::uuid)`.execute(
        handle.db,
      );
    const cause = message.message_id;
    // A refused turn that names its cap is fine.
    await insert({
      state: 'refused',
      settledAt: new Date(),
      trigger: 'unanswered_question',
      cause,
      decidedBy: 'ratio',
    });
    // Refused but dispatched, refused without a cap, an allowed turn that names a cap, an ask with a cause, an
    // unprompted turn without one, and an unprompted turn that claims the ask's bound: each is refused by a check.
    await expect(
      insert({
        state: 'refused',
        settledAt: new Date(),
        dispatched: true,
        trigger: 'overstated_claim',
        cause,
        decidedBy: 'ratio',
      }),
    ).rejects.toThrow();
    await expect(
      insert({ state: 'refused', settledAt: new Date(), trigger: 'overstated_claim', cause, decidedBy: 'caps_clear' }),
    ).rejects.toThrow();
    await expect(
      insert({ state: 'queued', trigger: 'answer_overstated', cause, decidedBy: 'room_day' }),
    ).rejects.toThrow();
    await expect(
      insert({ state: 'queued', trigger: 'asked', cause, decidedBy: 'asked_bounds', command: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      insert({ state: 'queued', trigger: 'answer_overstated', cause: null, decidedBy: 'caps_clear' }),
    ).rejects.toThrow();
    await expect(
      insert({ state: 'queued', trigger: 'answer_overstated', cause, decidedBy: 'asked_bounds' }),
    ).rejects.toThrow();
    // One turn of each kind per message, however often the job is delivered.
    await expect(
      insert({
        state: 'refused',
        settledAt: new Date(),
        trigger: 'unanswered_question',
        cause,
        decidedBy: 'room_hour',
      }),
    ).rejects.toThrow();
  });
});
