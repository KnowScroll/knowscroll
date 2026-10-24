/**
 * Idea rooms and the two erasures (#245, D-043, D-051) over real PostgreSQL: deleting an account turns its
 * words in rooms into tombstones and leaves the room to the others; selective Clear keeps the room and
 * only cancels the asks of AI inhabitants that were waiting. CI fixture accounts, fixture model, no provider.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness, fixtureModel } from '../support/fixture-model.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  ask,
  joinRoom,
  makeModerator,
  readActivity,
  readDiscussion,
  roomWorld,
  say,
  seedRoom,
  startPoll,
  startTopic,
  unwrap,
  votePoll,
  type RoomWorld,
} from '../support/rooms.js';
import { seedFriend, type Friend } from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const version = 'rooms.v1' as const;

describe('idea rooms and erasure (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let boss: ReturnType<typeof createBoss>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_erasure');
    world = await roomWorld(database);
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  /** A person created by the real operator sign-in (deletion and Clear need the real lifecycle), with a claimed profile. */
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

  const countOf = async (table: string, column: string, value: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*)::text as n from ${sql.table(table)} where ${sql.ref(column)}::text = ${value}`.execute(
          database.db,
        )
      ).rows[0]?.n ?? 0,
    );

  it('turns a deleted person’s words into tombstones and leaves the room to the others', async () => {
    const { roomId } = await seedRoom(world);
    const erased = await namedPerson();
    const staying = await seedFriend(world.db, world.friends);
    unwrap(await joinRoom(world, erased, roomId));
    unwrap(await joinRoom(world, staying, roomId));
    const reel = await seedReel(world.db, { durationMs: 40_000, title: 'Tokens' });
    const started = unwrap(
      await world.rooms.create(erased.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        start: { kind: 'content', root: { assetId: reel.assetId, assetRevision: 1 } },
      }),
    );
    const discussionId = started.discussionId;
    unwrap(await say(world, erased, roomId, discussionId, 'words that will go'));
    unwrap(
      await world.rooms.send(erased.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        discussionId,
        body: {
          kind: 'snippet',
          target: { assetId: reel.assetId, assetRevision: 1 },
          anchor: { kind: 'reel_range', startMs: 5_000, endMs: 15_000 },
        },
      }),
    );
    unwrap(await say(world, staying, roomId, discussionId, 'words that stay'));
    // An inhabitant answers the person who will leave; its words belong to the room.
    const model = fixtureModel(() => ({
      kind: 'success',
      text: JSON.stringify({ kind: 'explanation', text: 'A tokenizer splits text into pieces a model can count.' }),
    }));
    const { harness } = fixtureHarness(database.db, { model });
    const before = world.queued.length;
    unwrap(await ask(world, erased, roomId, discussionId, 'explainer'));
    await world.contribute(harness)(world.queued[before]!);

    const view = await readDiscussion(world, staying, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected ready');
    const cursor = view.catchUpCursor;
    expect(view.discussion.startedBy?.displayName).toBe('Fixture person');
    expect(view.messages).toHaveLength(4);

    // The export holds the person's own words and none of anyone else's.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(erased.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: erased.accountId }),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = JSON.stringify(exported.value.sections['rooms']);
    expect(section).toContain('words that will go');
    expect(section).not.toContain('words that stay');
    expect(section).not.toContain('A tokenizer splits');
    expect(JSON.stringify(exported.value.sections['rooms'])).toMatch(/"inhabitantAsks":1/);

    const receiptId = randomUUID();
    const deleting = deleteAccountFor(database.db, boss, {
      eraseAccountData: eraseCurrentAccount,
      lockTimeoutMs: 5_000,
    });
    expect((await deleting.request(erased.authority, { receiptId })).kind).toBe('accepted');
    expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');

    for (const [table, column] of [
      ['rooms.members', 'account_id'],
      ['rooms.messages', 'author_account_id'],
      ['rooms.discussions', 'started_by_account_id'],
      ['rooms.ai_requests', 'requested_by_account_id'],
    ] as const)
      expect(await countOf(table, column, erased.accountId), table).toBe(0);
    expect(
      await world.db.selectFrom('rooms.message_snippets').select('message_id').execute(),
      'the deleted author’s snippet goes with the message',
    ).toEqual([]);

    const after = await readDiscussion(world, staying, roomId, discussionId);
    if (after.status !== 'ready') throw new Error('expected ready');
    // Same places and numbers; the person's words are markers, the others' words and the AI's stay.
    expect(after.messages.map((message) => [message.sequence, message.status])).toEqual([
      [1, 'unavailable'],
      [2, 'unavailable'],
      [3, 'available'],
      [4, 'available'],
    ]);
    expect(after.messages[3]).toMatchObject({
      author: { kind: 'ai', label: 'AI · Explainer' },
      body: { text: 'A tokenizer splits text into pieces a model can count.' },
    });
    expect(after.discussion.startedBy).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain('words that will go');
    // Everyone's catch-up replaces the bubbles.
    const changes = unwrap(
      await world.rooms.changes(staying.authority, {
        version,
        readId: randomUUID(),
        roomId,
        discussionId,
        limit: 10,
        cursor,
      }),
    );
    if (changes.status !== 'ready') throw new Error('expected changes');
    expect(changes.changes.map((change) => change.message.status)).toEqual(['unavailable', 'unavailable']);
    const roomView = unwrap(await world.rooms.read(staying.authority, { version, readId: randomUUID(), roomId }));
    expect(roomView.status).toBe('member');
  });

  it('deletes a voter’s votes and leaves a deleted moderator’s poll to the room', async () => {
    const { roomId, slug } = await seedRoom(world);
    const moderator = await namedPerson();
    const voter = await namedPerson();
    const staying = await seedFriend(world.db, world.friends);
    for (const person of [moderator, voter, staying]) unwrap(await joinRoom(world, person, roomId));
    await makeModerator(world, slug, moderator);
    const { activityId } = unwrap(await startPoll(world, moderator, roomId, ['Batching', 'Instances']));
    unwrap(await votePoll(world, voter, roomId, activityId, 'o1'));
    unwrap(await votePoll(world, staying, roomId, activityId, 'o1'));

    // The voter's export holds their own vote, with the words of the option they chose.
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(voter.authority, (scope) =>
      exportCurrentPerson(scope, { accountId: voter.accountId }),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = JSON.stringify(exported.value.sections['rooms']);
    expect(section).toContain('"choice":"Batching"');
    expect(section).toContain('At 10x requests, what would you try first?');

    const erase = async (person: Friend) => {
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
    };
    await erase(voter);
    expect(await countOf('rooms.poll_votes', 'account_id', voter.accountId)).toBe(0);
    let view = await readActivity(world, staying, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([1, 0]);

    // Deleting the moderator clears the creator link; the poll stays open and countable for the others.
    await erase(moderator);
    expect(await countOf('rooms.activities', 'created_by_account_id', moderator.accountId)).toBe(0);
    expect(
      await world.db
        .selectFrom('rooms.activities')
        .select('activity_id')
        .where('activity_id', '=', activityId)
        .execute(),
    ).toHaveLength(1);
    unwrap(await votePoll(world, staying, roomId, activityId, 'o2'));
    view = await readActivity(world, staying, roomId, activityId);
    if (view.status !== 'ready' || view.activity.kind !== 'poll') throw new Error('expected a poll');
    expect(view.activity.options.map((option) => option.votes)).toEqual([0, 1]);
  });

  it('keeps the room through a Clear and cancels only the asks that were waiting', async () => {
    const { roomId } = await seedRoom(world);
    const person = await namedPerson();
    unwrap(await joinRoom(world, person, roomId));
    const discussionId = await startTopic(world, person, roomId, 'Before the clear');
    unwrap(await say(world, person, roomId, discussionId, 'still here after a clear'));
    unwrap(await ask(world, person, roomId, discussionId));
    const asking = await world.db
      .selectFrom('rooms.ai_requests')
      .select(['request_id', 'state'])
      .where('requested_by_account_id', '=', person.accountId)
      .executeTakeFirstOrThrow();
    expect(asking.state).toBe('queued');
    const jobsBefore = await jobsOf(person.universeId);
    expect(jobsBefore).toBe(1);

    await clearRecordingPerson(database, boss, person);

    expect(await jobsOf(person.universeId)).toBe(0);
    expect(
      (
        await world.db
          .selectFrom('rooms.ai_requests')
          .select('state')
          .where('request_id', '=', asking.request_id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('failed');
    const cleared = { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
    const view = await readDiscussion(world, cleared, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.messages).toMatchObject([{ status: 'available', body: { text: 'still here after a clear' } }]);
    // The ask that was cancelled does not hold the discussion: it can be asked again.
    expect(view.inhabitants.map((entry) => entry.ask)).toEqual(['available', 'available']);
  });

  async function jobsOf(universeId: string): Promise<number> {
    const row = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
      where name = 'rooms.contribute' and data ->> 'universeId' = ${universeId}`.execute(database.db);
    return Number(row.rows[0]?.n ?? 0);
  }
});
