/**
 * What a room’s residents remember (v3 R-8, D-247) over real PostgreSQL and a CI fixture model (never provider output): a
 * bounded text derived from the newest retained messages, written again and never added to; erased when something it read is
 * removed, kept out or deleted, and never carrying a kept-out member’s words; replaced by a moderator, with an audit row.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { gate } from '../support/fixture-model.js';
import {
  feedHeartbeat,
  feedTurns,
  FIND_NOTE,
  find,
  isFindCall,
  libraryScroll,
  MEMORY_TEXT,
  memory,
  memoryRow,
  NOTHING,
  readFeed,
  replaceMemory,
  requestText,
} from '../support/rooms-feed.js';
import { recordingPerson } from '../support/recording-person.js';
import {
  hideMessage,
  joinRoom,
  joined,
  makeModerator,
  memberView,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomWorld,
  rowsIn,
  say,
  seedRoom,
  setPreferences,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend, type Friend } from '../support/talk.js';

const HOUR = 3_600_000;
const START = new Date('2026-11-01T00:30:00Z');

describe('what the residents remember (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_memory');
    world = await roomWorld(database, { now: START }, { residentsEnabled: true });
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });
  beforeEach(async () => {
    await database.db.updateTable('content.assets').set({ status: 'withdrawn' }).execute();
    await database.db.updateTable('rooms.rooms').set({ status: 'closed' }).execute();
    world.clock.now = START;
  });

  const at = (iso: string) => {
    world.clock.now = new Date(iso);
  };
  /** A room with a moderator and `people` ordinary members, and the General discussion's ID. */
  async function room(people = 3) {
    const { roomId, slug } = await seedRoom(world);
    const members = await joined(world, roomId, people);
    const moderator = await seedFriend(world.db, world.friends);
    await makeModerator(world, slug, moderator);
    const general = (await memberView(world, members[0]!, roomId)).general.discussionId;
    return { roomId, slug, members, moderator, general };
  }
  type Room = Awaited<ReturnType<typeof room>>;

  /** `count` messages from the members in turn, a minute apart, each with words of its own. */
  async function talk(r: Room, count: number, label = 'topic', from = 0) {
    const sent: string[] = [];
    for (let index = 0; index < count; index++) {
      world.clock.now = new Date(world.clock.now.getTime() + 60_000);
      const result = unwrap(
        await say(
          world,
          r.members[(from + index) % r.members.length]!,
          r.roomId,
          r.general,
          `Remark ${label} number ${String(from + index + 1)} about running models`,
        ),
      );
      sent.push(result.messageId);
    }
    return sent;
  }
  const bytesOf = (call: { readonly bytes: Uint8Array }) => Buffer.from(call.bytes).toString('utf8');

  describe('writing it', () => {
    it('is written from the newest retained messages once there are enough, with no name and no kept-out word, and is the member’s to read', async () => {
      const r = await room(4);
      unwrap(await setPreferences(world, r.members[3]!, r.roomId, { keepOut: true }));
      const kept = unwrap(await say(world, r.members[3]!, r.roomId, r.general, 'KEPT-OUT-WORDS about batching'));
      const removed = unwrap(await say(world, r.members[0]!, r.roomId, r.general, 'REMOVED-WORDS about batching'));
      await talk(r, 10);
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, removed.messageId));
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      const result = await look(r.slug);
      expect(result.memory).toEqual({ kind: 'written' });
      // One call. It read people's words as numbered speakers, and neither the kept-out words nor the removed ones.
      expect(model.calls).toHaveLength(1);
      const request = bytesOf(model.calls[0]!);
      expect(request).toContain('Member 1:');
      expect(request).toContain('about running models');
      expect(request).not.toContain('KEPT-OUT-WORDS');
      expect(request).not.toContain('REMOVED-WORDS');
      expect(kept.messageId).toBeTruthy();
      const row = await memoryRow(world.db, r.roomId);
      expect(row).toMatchObject({ state: 'ready', source: 'derived', body: MEMORY_TEXT, messages_read: 8 });
      expect(row!.covers_from!.getTime()).toBeLessThan(row!.covers_through!.getTime());
      const [turn] = await feedTurns(world.db, r.roomId);
      expect(turn).toMatchObject({
        trigger: 'memory_refresh',
        decided_by: 'caps_clear',
        state: 'completed',
        dispatched: true,
        discussion_id: null,
        message_id: null,
        role_version: 'memory.1',
        model: model.model,
      });
      expect(row!.turn_id).toBe(turn!.turn_id);
      // Every member reads the same words, and nothing says whose they are.
      for (const member of r.members.slice(0, 2))
        expect((await readFeed(world, member, r.roomId)).memory).toEqual({
          state: 'ready',
          text: MEMORY_TEXT,
          by: 'residents',
        });
    });

    it('is a text of its own, written again and never added to, and a find carries it', async () => {
      await libraryScroll(world.db, 'A Scroll for a room that remembers', 5);
      const r = await room();
      await talk(r, 9);
      const { look, model } = feedHeartbeat(world, (_sequence, call) => (isFindCall(call) ? find() : memory()));
      at('2026-11-01T01:00:00Z');
      const first = await look(r.slug);
      expect(first.memory.kind).toBe('written');
      expect(first.find.kind).toBe('posted');
      // The memory call came first; the find that followed read what it wrote, as data, with no raw message.
      const findCall = model.calls.find(isFindCall)!;
      const request = requestText(findCall);
      expect(request).toContain(`<context-item ref="memory" kind="memory">\n${MEMORY_TEXT}\n</context-item>`);
      expect(request).not.toContain('about running models');
      expect(FIND_NOTE).toBeTruthy();
      // Twenty more messages and the next slot: one new call, one row, the text replaced.
      await talk(r, 20, 'later');
      at('2026-11-01T08:10:00Z');
      const second = await feedHeartbeat(world, () => memory('People moved on to caching.\nNothing is open.')).look(
        r.slug,
      );
      expect(second.memory.kind).toBe('written');
      const rows = await database.db
        .selectFrom('rooms.room_memory')
        .selectAll()
        .where('room_id', '=', r.roomId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('People moved on to caching.\nNothing is open.');
      expect(rows[0]!.messages_read).toBeLessThanOrEqual(60);
    });

    it('makes no call when there is too little to remember, or nothing new, or nobody listens', async () => {
      const r = await room();
      await talk(r, 7);
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'dropped', reason: 'not_due' });
      await talk(r, 3, 'more');
      at('2026-11-01T08:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'written' });
      // Nothing new since: due for nothing.
      at('2026-11-01T16:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'dropped', reason: 'not_due' });
      expect(model.calls).toHaveLength(1);
      // Everyone turns the AI off: a refresh that would otherwise be due still calls nothing.
      for (const member of [...r.members, r.moderator])
        unwrap(await setPreferences(world, member, r.roomId, { aiLevel: 'off' }));
      await talk(r, 25, 'again');
      at('2026-11-02T00:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'dropped', reason: 'nobody_listening' });
      expect(model.calls).toHaveLength(1);
    });

    it('is written once per slot, however often the job runs', async () => {
      const r = await room();
      await talk(r, 10);
      const { heartbeat, model } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      await heartbeat.lookAtAll({ signal: new AbortController().signal });
      await heartbeat.lookAtAll({ signal: new AbortController().signal });
      expect(model.calls).toHaveLength(1);
      expect(await feedTurns(world.db, r.roomId)).toHaveLength(1);
    });

    it('waits a day after a refresh that wrote nothing before asking again', async () => {
      const r = await room();
      await talk(r, 12);
      const { look, model } = feedHeartbeat(world, () => NOTHING);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'not_written', reason: 'nothing_to_keep' });
      expect((await feedTurns(world.db, r.roomId))[0]).toMatchObject({ state: 'declined', dispatched: true });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
      at('2026-11-01T09:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'dropped', reason: 'resting' });
      expect(model.calls).toHaveLength(1);
      at('2026-11-02T01:30:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'not_written', reason: 'nothing_to_keep' });
      expect(model.calls).toHaveLength(2);
    });

    it('refuses quietly when the room has had its eight unprompted turns this hour: no call, a refused row', async () => {
      const r = await room();
      await talk(r, 12);
      at('2026-11-01T01:00:00Z');
      for (let n = 0; n < 8; n++)
        await sql`insert into rooms.ai_turns (turn_id, room_id, inhabitant, trigger, state, decided_by, created_at, settled_at, dispatched, role_version, prompt_version, model)
          values (${randomUUID()}::uuid, ${r.roomId}::uuid, 'skeptic', 'memory_refresh', 'completed', 'caps_clear', ${new Date(world.clock.now.getTime() - n * 60_000)}, now(), true, 'memory.1', 'p', 'm')`.execute(
          world.db,
        );
      const { look, model } = feedHeartbeat(world);
      expect((await look(r.slug)).memory).toEqual({ kind: 'refused', cap: 'room_hour' });
      expect(model.calls).toHaveLength(0);
      expect((await feedTurns(world.db, r.roomId)).filter((turn) => turn.state === 'refused')).toHaveLength(1);
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
    });
  });

  describe('going stale', () => {
    async function remembered() {
      const r = await room(4);
      const sent = await talk(r, 12);
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory.kind).toBe('written');
      return { r, sent, look, model };
    }
    const seen = async (r: Room, person: Friend) => (await readFeed(world, person, r.roomId)).memory;

    it('is erased when a moderator removes a message it read, and written again from what is left', async () => {
      const { r, sent, look, model } = await remembered();
      expect(await seen(r, r.members[0]!)).toMatchObject({ state: 'ready' });
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, sent[3]!));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({
        state: 'stale',
        body: null,
        covers_from: null,
        covers_through: null,
      });
      expect(await seen(r, r.members[0]!)).toEqual({ state: 'none' });
      at('2026-11-01T09:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'written' });
      expect(bytesOf(model.calls[1]!)).not.toContain('number 4 about');
      expect(await seen(r, r.members[0]!)).toMatchObject({ state: 'ready' });
    });

    it('is not erased by a message it did not read', async () => {
      const { r } = await remembered();
      const later = await talk(r, 1, 'after');
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, later[0]!));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'ready' });
    });

    it('is erased when a member it read keeps their messages out, and written again without them', async () => {
      const { r, look, model } = await remembered();
      unwrap(await setPreferences(world, r.members[1]!, r.roomId, { keepOut: true }));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'stale', body: null });
      expect(await seen(r, r.members[0]!)).toEqual({ state: 'none' });
      at('2026-11-01T09:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'written' });
      const request = bytesOf(model.calls[1]!);
      // Member 2 (the second to speak) is gone from what the second call read: only three speakers remain.
      expect(request).toContain('Member 3:');
      expect(request).not.toContain('Member 4:');
      expect(request).not.toContain('number 2 about');
      expect(request).not.toContain('number 6 about');
    });

    it('is not erased when a member keeps their messages out who had written nothing it read', async () => {
      const r = await room(4);
      await talk({ ...r, members: r.members.slice(0, 3) }, 12);
      const { look } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory.kind).toBe('written');
      unwrap(await setPreferences(world, r.members[3]!, r.roomId, { keepOut: true }));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'ready' });
    });

    it('is never stored when what it read was removed while the call ran, and the call stays counted', async () => {
      const r = await room(3);
      const sent = await talk(r, 12);
      const { look } = feedHeartbeat(world, async () => {
        // A moderator removes a message the call read, while it is in flight.
        unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, sent[5]!));
        return memory();
      });
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'not_written', reason: 'not_stored' });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
      expect((await feedTurns(world.db, r.roomId))[0]).toMatchObject({ state: 'failed', dispatched: true });
    });

    it('is erased when a person it read deletes their account, before their messages become tombstones', async () => {
      const r = await room(2);
      const leaving = await namedPerson();
      unwrap(await joinRoom(world, leaving, r.roomId));
      await talk({ ...r, members: [r.members[0]!, leaving, r.members[1]!] }, 12);
      const { look } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory.kind).toBe('written');
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'ready' });
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(leaving.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'stale', body: null });
      expect(await seen(r, r.members[0]!)).toEqual({ state: 'none' });
    });
  });

  describe('a removal that commits just after the check', () => {
    /** How many backends of this database are waiting for a lock right now. */
    const waiting = async () =>
      Number(
        (
          await sql<{ n: string }>`select count(*) as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`.execute(world.db)
        ).rows[0]!.n,
      );
    /** Resolves when something is waiting for a lock, or after five seconds (nothing was going to wait). */
    const somethingWaits = () =>
      expect
        .poll(waiting, { timeout: 5_000 })
        .toBeGreaterThan(0)
        .catch(() => undefined);

    /**
     * One refresh whose call is in flight while a removal is open in a second transaction: `before` is what it has done
     * when the call returns, `after` what it does once the store step has run into it (it waits for it or, with nothing to
     * wait for, finishes). Only then does the removal commit, so what is left is what a real concurrent removal would have
     * left behind.
     */
    async function refreshWhileOpen(
      r: Room,
      removal: { before(trx: Transaction<Database>): Promise<void>; after?(trx: Transaction<Database>): Promise<void> },
    ) {
      const holding = gate();
      const commit = gate();
      let removing: Promise<void> | undefined;
      const { look } = feedHeartbeat(world, async () => {
        removing = world.db.transaction().execute(async (trx) => {
          try {
            await removal.before(trx);
          } finally {
            holding.open();
          }
          await commit.promise;
          await removal.after?.(trx);
        });
        await holding.promise;
        return memory();
      });
      at('2026-11-01T01:00:00Z');
      const looking = look(r.slug);
      await Promise.race([looking, somethingWaits()]);
      commit.open();
      await removing;
      return looking;
    }

    /** A deletion's change to the first message of a person: it becomes a tombstone. */
    const tombstoneOneOf = async (trx: Transaction<Database>, r: Room, person: Friend): Promise<void> => {
      await sql`with bumped as (
          update rooms.discussions set last_change_sequence = last_change_sequence + 1
          where discussion_id = ${r.general}::uuid returning last_change_sequence)
        update rooms.messages set author_account_id = null, command_id = null, body_text = null, asset_id = null,
          asset_revision = null, note = null, topic_discussion_id = null,
          change_sequence = (select last_change_sequence from bumped)
        where message_id = (select message_id from rooms.messages
          where discussion_id = ${r.general}::uuid and author_account_id = ${person.accountId}::uuid
          order by sequence limit 1)`.execute(trx);
    };

    it('is not stored with the words a hide took out, when the hide commits just after the check', async () => {
      const r = await room(3);
      const sent = await talk(r, 12);
      const result = await refreshWhileOpen(r, {
        // What hiding does: the room shared, then the message. Its hook finds no memory yet, so it has nothing to erase.
        async before(trx) {
          await sql`select room_id from rooms.rooms where room_id = ${r.roomId}::uuid for share`.execute(trx);
          await sql`with bumped as (
              update rooms.discussions set last_change_sequence = last_change_sequence + 1
              where discussion_id = ${r.general}::uuid returning last_change_sequence)
            update rooms.messages set hidden_at = now(), change_sequence = (select last_change_sequence from bumped)
            where message_id = ${sent[5]!}::uuid`.execute(trx);
        },
      });
      expect(result.memory).toEqual({ kind: 'not_written', reason: 'not_stored' });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
      expect((await feedTurns(world.db, r.roomId))[0]).toMatchObject({ state: 'failed', dispatched: true });
    });

    it('is not stored with the words of a deletion that has changed the messages and not yet committed', async () => {
      const r = await room(2);
      const leaving = await namedPerson();
      unwrap(await joinRoom(world, leaving, r.roomId));
      await talk({ ...r, members: [r.members[0]!, leaving, r.members[1]!] }, 12);
      const result = await refreshWhileOpen(r, {
        // The deletion's own change to a message, with no room lock of its own: the check has to wait for the row.
        before: (trx) => tombstoneOneOf(trx, r, leaving),
      });
      expect(result.memory).toEqual({ kind: 'not_written', reason: 'not_stored' });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
    });

    it('waits for a deletion that holds the room and changes the messages only after the check began', async () => {
      const r = await room(2);
      const leaving = await namedPerson();
      unwrap(await joinRoom(world, leaving, r.roomId));
      await talk({ ...r, members: [r.members[0]!, leaving, r.members[1]!] }, 12);
      const result = await refreshWhileOpen(r, {
        // What a deletion does first: the room shared. Its hook finds no memory yet; the tombstones come later.
        async before(trx) {
          await sql`select room_id from rooms.rooms where room_id = ${r.roomId}::uuid for share`.execute(trx);
        },
        after: (trx) => tombstoneOneOf(trx, r, leaving),
      });
      expect(result.memory).toEqual({ kind: 'not_written', reason: 'not_stored' });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
    });

    it('is not stored with the words of a member who keeps theirs out just after the check', async () => {
      const r = await room(3);
      await talk(r, 12);
      const result = await refreshWhileOpen(r, {
        // What keeping out does: the room shared, then the member's row.
        async before(trx) {
          await sql`select room_id from rooms.rooms where room_id = ${r.roomId}::uuid for share`.execute(trx);
          await sql`update rooms.members set keep_out = true
            where room_id = ${r.roomId}::uuid and account_id = ${r.members[1]!.accountId}::uuid`.execute(trx);
        },
      });
      expect(result.memory).toEqual({ kind: 'not_written', reason: 'not_stored' });
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
    });

    it('is erased by a deletion that begins while the memory is being stored, however the two interleave', async () => {
      const r = await room(2);
      const leaving = await namedPerson();
      unwrap(await joinRoom(world, leaving, r.roomId));
      await talk({ ...r, members: [r.members[0]!, leaving, r.members[1]!] }, 12);
      const holding = gate();
      const commit = gate();
      // The store step as the refresh runs it: the room's row exclusively, then the words it read the person's messages for.
      const storing = world.db.transaction().execute(async (trx) => {
        await sql`select room_id from rooms.rooms where room_id = ${r.roomId}::uuid for update`.execute(trx);
        holding.open();
        await commit.promise;
        await sql`insert into rooms.room_memory (room_id, state, source, body, covers_from, covers_through, messages_read, updated_at)
          select ${r.roomId}::uuid, 'ready', 'derived', ${MEMORY_TEXT}, min(message.recorded_at), max(message.recorded_at),
            count(*), now()
          from rooms.messages message join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
          where discussion.room_id = ${r.roomId}::uuid`.execute(trx);
      });
      await holding.promise;
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 20_000,
      });
      expect((await deleting.request(leaving.authority, { receiptId })).kind).toBe('accepted');
      const processing = deleting.process({ v: 1, deletionId: receiptId });
      // The deletion waits for the room. With nothing to wait for it finishes first, and the check below catches that.
      await Promise.race([processing, somethingWaits()]);
      commit.open();
      await storing;
      expect(await processing).toBe('completed');
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'stale', body: null });
    });
  });

  describe('what a memory may not say', () => {
    it('is written again when the first text speaks as a self that is not there, with a fixed hint', async () => {
      const r = await room(3);
      await talk(r, 12);
      const { look, model } = feedHeartbeat(world, (sequence) =>
        sequence === 1 ? memory('I remember when people asked about batching.') : memory(),
      );
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'written' });
      expect(model.calls).toHaveLength(2);
      expect(bytesOf(model.calls[1]!)).toContain('never about yourselves');
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'ready', body: MEMORY_TEXT });
    });

    it('is never stored when it claims an experience twice, and the call stays counted', async () => {
      const r = await room(3);
      await talk(r, 12);
      const { look, model } = feedHeartbeat(world, () => memory('The thread changed how people picture batching.'));
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'not_written', reason: 'call_failed' });
      expect(model.calls).toHaveLength(2);
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
      expect((await feedTurns(world.db, r.roomId))[0]).toMatchObject({ state: 'failed', dispatched: true });
    });
  });

  describe('a moderator’s own words', () => {
    it('replace what the residents remember, are audited, and stand until a moderator ends them', async () => {
      const r = await room();
      await talk(r, 12);
      const { look, model } = feedHeartbeat(world);
      at('2026-11-01T01:00:00Z');
      expect((await look(r.slug)).memory.kind).toBe('written');
      const commandId = randomUUID();
      const send = (id: string) =>
        world.rooms.replaceMemory(r.moderator.authority, {
          version: 'rooms.v1',
          commandId: id,
          roomId: r.roomId,
          text: 'The room is for beginners. Please be patient with questions.',
        });
      const accepted = unwrap(await send(commandId));
      expect(accepted).toMatchObject({
        memory: {
          state: 'ready',
          by: 'moderator',
          text: 'The room is for beginners. Please be patient with questions.',
        },
      });
      expect(unwrap(await send(commandId))).toMatchObject({ replayed: true });
      const edits = await database.db
        .selectFrom('rooms.memory_edits')
        .selectAll()
        .where('room_id', '=', r.roomId)
        .execute();
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ action: 'replace', by_account_id: r.moderator.accountId });
      expect(edits[0]!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
      // It is the moderator's: members read it as theirs, a removal does not erase it and no refresh replaces it.
      expect(await readFeed(world, r.members[0]!, r.roomId)).toMatchObject({
        memory: { state: 'ready', by: 'moderator' },
        canEditMemory: false,
      });
      expect((await readFeed(world, r.moderator, r.roomId)).canEditMemory).toBe(true);
      const sent = await talk(r, 30, 'after');
      unwrap(await hideMessage(world, r.moderator, r.roomId, r.general, sent[0]!));
      unwrap(await setPreferences(world, r.members[1]!, r.roomId, { keepOut: true }));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'ready', source: 'moderator' });
      at('2026-11-01T09:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'dropped', reason: 'not_due' });
      expect(model.calls).toHaveLength(1);
      // Clearing it is audited too, and the residents write it again from what the room said.
      unwrap(await replaceMemory(world, r.moderator, r.roomId, null));
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({ state: 'stale', source: 'derived', body: null });
      at('2026-11-01T17:10:00Z');
      expect((await look(r.slug)).memory).toEqual({ kind: 'written' });
      expect(await memoryRow(world.db, r.roomId)).toMatchObject({
        source: 'derived',
        state: 'ready',
        edited_by_account_id: null,
      });
      const audit = await database.db
        .selectFrom('rooms.memory_edits')
        .select(['action', 'by_account_id'])
        .where('room_id', '=', r.roomId)
        .orderBy('at')
        .execute();
      expect(audit.map((edit) => edit.action)).toEqual(['replace', 'clear']);
    });

    it('can be made by a moderator only, in plain text of a bounded length', async () => {
      const r = await room();
      const refusal = async (person: Friend, text: string | null) => {
        const result = await replaceMemory(world, person, r.roomId, text);
        return result.kind === 'refused' ? result.code : 'accepted';
      };
      expect(await refusal(r.members[0]!, 'A member’s words')).toBe('unavailable');
      expect(await refusal(await seedFriend(world.db, world.friends), 'A stranger’s words')).toBe('unavailable');
      expect(await refusal(r.moderator, 'Read https://example.org for more')).toBe('invalid_input');
      expect(await refusal(r.moderator, 'x'.repeat(601))).toBe('invalid_input');
      expect(await refusal(r.moderator, '   ')).toBe('invalid_input');
      expect(await memoryRow(world.db, r.roomId)).toBeUndefined();
      expect(
        await database.db.selectFrom('rooms.memory_edits').selectAll().where('room_id', '=', r.roomId).execute(),
      ).toEqual([]);
    });

    it('keep their audit when the moderator’s account is deleted, and the export names the edit without its words', async () => {
      const r = await room();
      const editor = await namedPerson();
      expect(await joinRoom(world, editor, r.roomId)).toMatchObject({ kind: 'ok' });
      await makeModerator(world, r.slug, editor);
      unwrap(await replaceMemory(world, editor, r.roomId, 'Words only the moderator chose.'));
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(editor.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: editor.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = JSON.stringify(exported.value.sections['rooms']);
      expect(section).toContain('"memoryEdits":[{"room":"Fixture room","action":"replaced"');
      expect(section).not.toContain('Words only the moderator chose.');
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(editor.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      const row = await memoryRow(world.db, r.roomId);
      expect(row).toMatchObject({
        state: 'ready',
        source: 'moderator',
        body: 'Words only the moderator chose.',
        edited_by_account_id: null,
      });
      const edits = await database.db
        .selectFrom('rooms.memory_edits')
        .selectAll()
        .where('room_id', '=', r.roomId)
        .execute();
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ action: 'replace', by_account_id: null });
    });
  });

  it('writes nothing to a person’s own universe', async () => {
    const r = await room();
    await talk(r, 12);
    const before = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
    const { look } = feedHeartbeat(world);
    at('2026-11-01T01:00:00Z');
    await look(r.slug);
    unwrap(await replaceMemory(world, r.moderator, r.roomId, 'Beginners are welcome here.'));
    await readFeed(world, r.members[0]!, r.roomId);
    expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(before);
    expect(HOUR).toBe(3_600_000);
  });

  /** A person created by the real operator sign-in (deletion needs the real lifecycle), with a claimed profile. */
  async function namedPerson(): Promise<Friend> {
    const person = await recordingPerson(database);
    const set = await world.friends.setProfile(person.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: `ci.${person.accountId.replaceAll('-', '').slice(0, 14)}`,
      displayName: 'Fixture person',
    });
    if (set.kind !== 'ok') throw new Error('profile refused');
    const read = await world.friends.readProfile(person.authority);
    if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
    return { ...person, person: read.value.person };
  }
});
