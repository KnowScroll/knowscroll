/**
 * Labelled AI inhabitants over real PostgreSQL and the real reasoning harness with a CI fixture model
 * (never provider output): they speak only when a member asks, are always labelled, are bounded per room
 * and per person and day, rely on this room's own words only, and never start production.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, attemptsOf, receiptClassesOf } from '../support/fixture-model.js';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import { clearRecordingPerson, pauseAndResume, recordingPerson, setRecording } from '../support/recording-person.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  ask,
  befriend,
  joinRoom,
  joined,
  readDiscussion,
  roomWorld,
  say,
  seedRoom,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { consumptionRows, seedFriend, type Friend } from '../support/talk.js';
import { seedReel } from '../support/thread-fixtures.js';

const version = 'rooms.v1' as const;
const answer = (kind: string, text: string): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify({ kind, text }),
});

describe('AI inhabitants (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_inhabitants');
    world = await roomWorld(database);
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  /** A room with two talking members and a discussion; the harness plays `script` for each model call. */
  async function conversation(script: (sequence: number) => FixtureScenario | Promise<FixtureScenario>) {
    const { roomId, slug } = await seedRoom(world);
    const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
    const discussionId = await startTopic(world, asha, roomId, 'Does batching always help?');
    unwrap(await say(world, asha, roomId, discussionId, 'More traffic means a bigger bill, linearly?'));
    unwrap(await say(world, ravi, roomId, discussionId, 'I think batching makes it cheaper.'));
    const model = fixtureModel(script, { label: 'rooms-inhabitants' });
    const { harness } = fixtureRecordingHarness(database.db, { model });
    return { roomId, slug, asha, ravi, discussionId, model, contribute: world.contribute(harness) };
  }

  /** The ask a member just made: the job the use case queued for it. */
  async function askAndTake(
    person: Friend,
    roomId: string,
    discussionId: string,
    inhabitant: 'explainer' | 'skeptic' = 'skeptic',
  ) {
    const before = world.queued.length;
    unwrap(await ask(world, person, roomId, discussionId, inhabitant));
    expect(world.queued).toHaveLength(before + 1);
    return world.queued[before]!;
  }

  const requestState = (requestId: string) =>
    world.db.selectFrom('rooms.ai_turns').selectAll().where('turn_id', '=', requestId).executeTakeFirstOrThrow();

  const messagesOf = async (person: Friend, roomId: string, discussionId: string) => {
    const view = await readDiscussion(world, person, roomId, discussionId);
    if (view.status !== 'ready') throw new Error('expected ready');
    return view;
  };

  it('never speaks unasked: a room full of people and an inhabitant with nothing queued stays quiet', async () => {
    const { roomId, asha, discussionId } = await conversation(() => answer('explanation', 'unused'));
    const view = await messagesOf(asha, roomId, discussionId);
    expect(view.messages.every((message) => message.status === 'available' && message.author.kind === 'person')).toBe(
      true,
    );
    expect(view.inhabitants.map((entry) => entry.ask)).toEqual(['available', 'available']);
    const requests = await world.db
      .selectFrom('rooms.ai_turns')
      .select('turn_id')
      .where('room_id', '=', roomId)
      .execute();
    expect(requests).toEqual([]);
  });

  it('answers a member’s ask with one labelled message, stored with its role, model and attempt', async () => {
    const { roomId, asha, ravi, discussionId, model, contribute } = await conversation(() =>
      answer('counterexample', 'Batching can hurt latency when requests arrive one at a time.'),
    );
    const before = await consumptionRows(world.db);
    const jobsBefore = await countJobs('content.produce-scroll');
    const job = await askAndTake(ravi, roomId, discussionId);
    // The ask is queued, not answered: the discussion shows it is being prepared and nothing else.
    expect((await messagesOf(asha, roomId, discussionId)).inhabitants.map((entry) => entry.ask)).toEqual([
      'preparing',
      'preparing',
    ]);
    expect(await countJobs('rooms.contribute')).toBeGreaterThan(0);
    expect(JSON.stringify(job)).not.toMatch(/batching|bill/i);

    await contribute(job);

    const view = await messagesOf(asha, roomId, discussionId);
    const spoken = view.messages.at(-1);
    expect(spoken).toMatchObject({
      status: 'available',
      author: { kind: 'ai', inhabitant: 'skeptic', label: 'AI · Skeptic' },
      body: { kind: 'text', text: 'Batching can hurt latency when requests arrive one at a time.' },
      suggestion: 'counterexample',
    });
    expect(view.messages).toHaveLength(3);
    const request = await requestState(job.requestId);
    expect(request).toMatchObject({
      state: 'completed',
      inhabitant: 'skeptic',
      role_version: 'inhabitant.2',
      model: 'fixture-model-v1',
    });
    expect(request.prompt_version).toMatch(/\S/);
    expect(request.attempt_id).not.toBeNull();
    expect((await attemptsOf(world.db, ravi.universeId)).map((attempt) => attempt.id)).toContain(request.attempt_id);
    // A member asked for it, so it counts against the whole allowance, never the background share.
    expect(await receiptClassesOf(world.db, ravi.universeId)).toEqual([
      { role_id: 'rooms.skeptic', background: false },
    ]);
    expect(model.calls).toHaveLength(1);
    // Suggesting is not making: no production, no evidence, nothing else queued.
    expect(await consumptionRows(world.db)).toBe(before);
    expect(await countJobs('content.produce-scroll')).toBe(jobsBefore);
    expect((await messagesOf(asha, roomId, discussionId)).inhabitants.map((entry) => entry.ask)).toEqual([
      'available',
      'available',
    ]);
  });

  it('shows the model this room’s words with numbered speakers, and nothing private', async () => {
    const { roomId, asha, ravi, discussionId, model, contribute } = await conversation(() =>
      answer('explanation', 'Batching groups requests so the hardware stays busy.'),
    );
    await befriend(world.friends, asha, ravi);
    const reel = await seedReel(world.db, { title: 'Hidden Friend Reel' });
    const thread = unwrap(
      await world.threads.create(asha.authority, {
        version: 'content-thread.v1',
        commandId: randomUUID(),
        root: { assetId: reel.assetId, assetRevision: 1 },
        friendPersonIds: [ravi.person.personId],
      }),
    );
    unwrap(
      await world.threads.send(asha.authority, {
        version: 'content-thread.v1',
        commandId: randomUUID(),
        thread: thread.thread,
        body: { kind: 'text', text: 'PRIVATE-FRIEND-WORDS about batching' },
      }),
    );
    const job = await askAndTake(ravi, roomId, discussionId, 'explainer');
    await contribute(job);

    const sent = model.calls[0]!.request.user;
    expect(sent).toContain('More traffic means a bigger bill, linearly?');
    expect(sent).toContain('Member 1');
    expect(sent).toContain('Member 2');
    expect(sent).toContain('Does batching always help?');
    for (const secret of [
      'PRIVATE-FRIEND-WORDS',
      'Hidden Friend Reel',
      'Fixture friend',
      asha.person.handle,
      asha.accountId,
      ravi.accountId,
    ])
      expect(sent, secret).not.toContain(secret);
    expect(model.calls[0]!.request.system).toContain('You are not a person');
  });

  it('says honestly when an inhabitant has nothing to add, and posts nothing', async () => {
    const { roomId, asha, ravi, discussionId, contribute } = await conversation(() => answer('nothing_to_add', ''));
    const job = await askAndTake(ravi, roomId, discussionId);
    await contribute(job);
    expect((await requestState(job.requestId)).state).toBe('declined');
    const mine = await messagesOf(ravi, roomId, discussionId);
    expect(mine.messages).toHaveLength(2);
    expect(mine.yourAsk).toEqual({ inhabitant: 'skeptic', outcome: 'nothing_to_add' });
    expect((await messagesOf(asha, roomId, discussionId)).yourAsk).toBeUndefined();
  });

  it('refuses a link or a claim to be a person with one repair, and posts nothing if the repair fails too', async () => {
    const repaired = await conversation((sequence) =>
      sequence === 1
        ? answer('assumption', 'Have you read https://example.invalid/batching?')
        : answer('assumption', 'Does that assume requests arrive in bursts?'),
    );
    const job = await askAndTake(repaired.ravi, repaired.roomId, repaired.discussionId);
    await repaired.contribute(job);
    expect(repaired.model.calls).toHaveLength(2);
    const view = await messagesOf(repaired.asha, repaired.roomId, repaired.discussionId);
    expect(view.messages.at(-1)).toMatchObject({ body: { text: 'Does that assume requests arrive in bursts?' } });

    const refused = await conversation(() => answer('perspective', 'As a student I have seen this often.'));
    const refusedJob = await askAndTake(refused.ravi, refused.roomId, refused.discussionId);
    await refused.contribute(refusedJob);
    expect(refused.model.calls).toHaveLength(2);
    expect((await requestState(refusedJob.requestId)).state).toBe('failed');
    const quiet = await messagesOf(refused.ravi, refused.roomId, refused.discussionId);
    expect(quiet.messages).toHaveLength(2);
    expect(quiet.yourAsk).toEqual({ inhabitant: 'skeptic', outcome: 'could_not_answer' });
  });

  it('lets each inhabitant use only its own kinds: an Explainer cannot challenge', async () => {
    const { roomId, ravi, discussionId, model, contribute } = await conversation((sequence) =>
      sequence === 1
        ? answer('counterexample', 'Here is a case where that fails.')
        : answer('explanation', 'Batching groups requests.'),
    );
    const job = await askAndTake(ravi, roomId, discussionId, 'explainer');
    await contribute(job);
    expect(model.calls).toHaveLength(2);
    const view = await messagesOf(ravi, roomId, discussionId);
    expect(view.messages.at(-1)).toMatchObject({
      author: { kind: 'ai', inhabitant: 'explainer', label: 'AI · Explainer' },
      suggestion: 'explanation',
    });
  });

  it('runs a delivered job once: a second delivery changes nothing and costs nothing', async () => {
    const { roomId, ravi, discussionId, model, contribute } = await conversation(() =>
      answer('perspective', 'Another way to see it is cost per answer.'),
    );
    const job = await askAndTake(ravi, roomId, discussionId);
    await contribute(job);
    await contribute(job);
    expect(model.calls).toHaveLength(1);
    expect((await messagesOf(ravi, roomId, discussionId)).messages).toHaveLength(3);
  });

  it('retries an ask safely, and holds one ask per discussion at a time', async () => {
    const { roomId, asha, ravi, discussionId } = await conversation(() => answer('explanation', 'unused'));
    const commandId = randomUUID();
    const command = { version, commandId, roomId, discussionId, inhabitant: 'skeptic' as const };
    unwrap(await world.rooms.ask(ravi.authority, command));
    expect(unwrap(await world.rooms.ask(ravi.authority, command))).toMatchObject({ replayed: true });
    const open = await ask(world, asha, roomId, discussionId, 'explainer');
    expect(open.kind === 'refused' ? open.code : 'ok').toBe('unavailable');
    const requests = await world.db
      .selectFrom('rooms.ai_turns')
      .select('turn_id')
      .where('discussion_id', '=', discussionId)
      .execute();
    expect(requests).toHaveLength(1);
  });

  it('bounds a person per hour and a room per day, and starts again later (D-068)', async () => {
    const { roomId, asha, ravi, discussionId, contribute } = await conversation(() => answer('nothing_to_add', ''));
    // Ten asks settle; the eleventh is over the person's hourly bound.
    for (let index = 0; index < 10; index++) await contribute(await askAndTake(ravi, roomId, discussionId));
    const eleventh = await ask(world, ravi, roomId, discussionId);
    expect(eleventh.kind === 'refused' ? eleventh.code : 'ok').toBe('rate_limited');
    expect((await messagesOf(ravi, roomId, discussionId)).inhabitants.map((entry) => entry.ask)).toEqual([
      'resting',
      'resting',
    ]);
    // Someone else can still ask until the room's own bound.
    await contribute(await askAndTake(asha, roomId, discussionId));
    // An hour later the same person can ask again.
    world.clock.now = new Date('2026-10-24T09:05:00Z');
    await contribute(await askAndTake(ravi, roomId, discussionId));
    // Fill the room's bound with answered asks of other people, as a busy day would.
    const filler = await seedFriend(world.db, world.friends);
    const used = await world.db
      .selectFrom('rooms.ai_turns')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('room_id', '=', roomId)
      .executeTakeFirstOrThrow();
    for (let index = Number(used.n); index < 80; index++)
      await world.db
        .insertInto('rooms.ai_turns')
        .values({
          turn_id: randomUUID(),
          room_id: roomId,
          discussion_id: discussionId,
          inhabitant: 'skeptic',
          requested_by_account_id: filler.accountId,
          command_id: randomUUID(),
          ask_kind: 'ask',
          state: 'declined',
          dispatched: true,
          created_at: world.clock.now,
          settled_at: world.clock.now,
        })
        .execute();
    const roomFull = await ask(world, asha, roomId, discussionId);
    expect(roomFull.kind === 'refused' ? roomFull.code : 'ok').toBe('rate_limited');
    world.clock.now = new Date('2026-10-25T00:30:00Z');
    try {
      expect((await ask(world, ravi, roomId, discussionId)).kind).toBe('ok');
    } finally {
      world.clock.now = new Date('2026-10-24T08:00:00Z');
    }
  }, 60_000);

  it('does nothing for an asker who has left, a room that was paused, or a universe that is not theirs', async () => {
    const left = await conversation(() => answer('explanation', 'must not be said'));
    const leaveJob = await askAndTake(left.ravi, left.roomId, left.discussionId, 'explainer');
    unwrap(await world.rooms.leave(left.ravi.authority, { version, commandId: randomUUID(), roomId: left.roomId }));
    await left.contribute(leaveJob);
    expect(left.model.calls).toHaveLength(0);
    expect((await requestState(leaveJob.requestId)).state).toBe('failed');
    expect((await messagesOf(left.asha, left.roomId, left.discussionId)).messages).toHaveLength(2);

    const paused = await conversation(() => answer('explanation', 'must not be said'));
    const pauseJob = await askAndTake(paused.ravi, paused.roomId, paused.discussionId, 'explainer');
    await world.db.updateTable('rooms.rooms').set({ status: 'paused' }).where('room_id', '=', paused.roomId).execute();
    await paused.contribute(pauseJob);
    expect(paused.model.calls).toHaveLength(0);
    expect((await requestState(pauseJob.requestId)).state).toBe('failed');

    const wrong = await conversation(() => answer('explanation', 'must not be said'));
    const wrongJob = await askAndTake(wrong.ravi, wrong.roomId, wrong.discussionId, 'explainer');
    await wrong.contribute({ ...wrongJob, universeId: wrong.asha.universeId, privacyEpoch: 1 });
    expect(wrong.model.calls).toHaveLength(0);
    expect((await requestState(wrongJob.requestId)).state).toBe('queued');
  });

  it('drops an answer that arrives after the asker was removed, and keeps the run honest', async () => {
    let release: (scenario: FixtureScenario) => void = () => undefined;
    const held = new Promise<FixtureScenario>((resolve) => (release = resolve));
    const { roomId, slug, ravi, asha, discussionId, model, contribute } = await conversation(() => ({
      kind: 'hold',
      until: held,
    }));
    const { makeModerator } = await import('../support/rooms.js');
    const moderator = await seedFriend(world.db, world.friends);
    await makeModerator(world, slug, moderator);
    const job = await askAndTake(ravi, roomId, discussionId, 'explainer');
    const running = contribute(job);
    // The model call is in flight, outside any transaction, when the moderator removes the asker.
    await expect.poll(() => model.calls.length).toBe(1);
    unwrap(
      await world.rooms.moderate(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        action: { kind: 'remove_member', personId: ravi.person.personId },
      }),
    );
    release(answer('explanation', 'too late'));
    await running;
    // The model was called, so the ask is dropped but stays counted against the day.
    expect(await requestState(job.requestId)).toMatchObject({ state: 'failed', dispatched: true });
    expect(JSON.stringify(await messagesOf(asha, roomId, discussionId))).not.toContain('too late');
  });

  /** One ask whose model call is held in flight until `finish` runs; the asker's standing may change meanwhile. */
  async function askWhileModelRuns(
    person: Friend,
    roomId: string,
    discussionId: string,
    meanwhile: () => Promise<void>,
  ) {
    let release: (scenario: FixtureScenario) => void = () => undefined;
    const held = new Promise<FixtureScenario>((resolve) => (release = resolve));
    const model = fixtureModel(() => ({ kind: 'hold', until: held }), { label: 'rooms-bound' });
    const { harness } = fixtureRecordingHarness(database.db, { model });
    const job = await askAndTake(person, roomId, discussionId);
    const running = world.contribute(harness)(job);
    await expect.poll(() => model.calls.length).toBe(1);
    await meanwhile();
    release(answer('assumption', 'discarded'));
    await running;
    return { job, calls: model.calls.length };
  }

  it('does not give an ask back when the asker leaves while the model runs: ten calls an hour, not more', async () => {
    const { roomId, ravi, discussionId } = await conversation(() => answer('assumption', 'unused'));
    let modelCalls = 0;
    for (let round = 1; round <= 10; round++) {
      const { job, calls } = await askWhileModelRuns(ravi, roomId, discussionId, async () => {
        unwrap(await world.rooms.leave(ravi.authority, { version, commandId: randomUUID(), roomId }));
      });
      modelCalls += calls;
      expect(await requestState(job.requestId)).toMatchObject({ state: 'failed', dispatched: true });
      unwrap(await joinRoom(world, ravi, roomId));
    }
    expect(modelCalls).toBe(10);
    const eleventh = await ask(world, ravi, roomId, discussionId);
    expect(eleventh.kind === 'refused' ? eleventh.code : 'ok').toBe('rate_limited');
  }, 120_000);

  it('counts an ask whose answer was dropped by a pause or a Clear, and refunds one that never reached the provider', async () => {
    const paused = await conversation(() => answer('assumption', 'unused'));
    const pausedRun = await askWhileModelRuns(paused.ravi, paused.roomId, paused.discussionId, async () => {
      await world.db
        .updateTable('rooms.rooms')
        .set({ status: 'paused' })
        .where('room_id', '=', paused.roomId)
        .execute();
    });
    expect(await requestState(pausedRun.job.requestId)).toMatchObject({ state: 'failed', dispatched: true });
    await world.db.updateTable('rooms.rooms').set({ status: 'open' }).where('room_id', '=', paused.roomId).execute();
    const asked = await world.db
      .selectFrom('rooms.ai_turns')
      .select(['state', 'dispatched'])
      .where('requested_by_account_id', '=', paused.ravi.accountId)
      .execute();
    expect(asked.filter((row) => row.state !== 'failed' || row.dispatched)).toHaveLength(1);

    // Leaving before the worker starts costs no call, so that ask is handed back.
    const early = await conversation(() => answer('assumption', 'unused'));
    const job = await askAndTake(early.ravi, early.roomId, early.discussionId);
    unwrap(await world.rooms.leave(early.ravi.authority, { version, commandId: randomUUID(), roomId: early.roomId }));
    await early.contribute(job);
    expect(early.model.calls).toHaveLength(0);
    expect(await requestState(job.requestId)).toMatchObject({ state: 'failed', dispatched: false });
  });

  it('caps every ask a person makes in an hour, so asks that never reach the provider cannot pile up', async () => {
    const { roomId, ravi, discussionId, model, contribute } = await conversation(() => answer('assumption', 'unused'));
    // Each ask is made and the asker leaves before the worker starts: nothing is dispatched, nothing is counted.
    for (let round = 1; round <= 20; round++) {
      const job = await askAndTake(ravi, roomId, discussionId);
      unwrap(await world.rooms.leave(ravi.authority, { version, commandId: randomUUID(), roomId }));
      await contribute(job);
      unwrap(await joinRoom(world, ravi, roomId));
    }
    expect(model.calls).toHaveLength(0);
    const next = await ask(world, ravi, roomId, discussionId);
    expect(next.kind === 'refused' ? next.code : 'ok').toBe('rate_limited');
    expect((await messagesOf(ravi, roomId, discussionId)).inhabitants.map((entry) => entry.ask)).toEqual([
      'resting',
      'resting',
    ]);
  }, 120_000);

  it('accepts the same command ID in another room as another ask, not as an error', async () => {
    const first = await conversation(() => answer('assumption', 'unused'));
    const { roomId: otherRoom } = await seedRoom(world);
    unwrap(await joinRoom(world, first.ravi, otherRoom));
    const otherDiscussion = await startTopic(world, first.ravi, otherRoom, 'Another room, another topic');
    const commandId = randomUUID();
    unwrap(
      await world.rooms.ask(first.ravi.authority, {
        version,
        commandId,
        roomId: first.roomId,
        discussionId: first.discussionId,
        inhabitant: 'skeptic',
      }),
    );
    const second = await world.rooms.ask(first.ravi.authority, {
      version,
      commandId,
      roomId: otherRoom,
      discussionId: otherDiscussion,
      inhabitant: 'skeptic',
    });
    expect(second.kind).toBe('ok');
    const rows = await world.db
      .selectFrom('rooms.ai_turns')
      .select('room_id')
      .where('command_id', '=', commandId)
      .execute();
    expect(rows.map((row) => row.room_id).sort()).toEqual([first.roomId, otherRoom].sort());
  });

  it('never sends a message a moderator removed to the model', async () => {
    const { roomId, slug, asha, ravi, discussionId, model, contribute } = await conversation(() =>
      answer('assumption', 'Is that so?'),
    );
    const moderator = await seedFriend(world.db, world.friends);
    const { makeModerator } = await import('../support/rooms.js');
    await makeModerator(world, slug, moderator);
    const said = unwrap(await say(world, asha, roomId, discussionId, 'SECRET-HIDDEN-WORDS'));
    unwrap(
      await world.rooms.hideMessage(moderator.authority, {
        version,
        commandId: randomUUID(),
        roomId,
        discussionId,
        messageId: said.messageId,
        hidden: true,
      }),
    );
    await contribute(await askAndTake(ravi, roomId, discussionId));
    expect(model.calls[0]!.request.user).not.toContain('SECRET-HIDDEN-WORDS');
    expect(model.calls[0]!.request.user).toContain('I think batching makes it cheaper.');
  });

  async function countJobs(queue: string): Promise<number> {
    const row = await sql<{ n: string }>`select count(*)::text as n from pgboss.job where name = ${queue}`.execute(
      database.db,
    );
    return Number(row.rows[0]?.n ?? 0);
  }

  /**
   * An AI inhabitant's answer to a member's ask runs in the asker's own scope, at the generation their recording is at when the
   * job starts (D-270). Generation 1 is on, 2 is off, and 3 is on again after a pause and a resume. A resident speaking on its
   * own runs in the room's scope and is not in question here.
   */
  describe('for a member who paused and resumed recording (D-270)', () => {
    let beforeApply: () => Promise<void> = () => Promise.resolve();

    /** A room whose asker can pause and clear recording, with the harness playing `script`. */
    async function recordingConversation(script: (sequence: number) => FixtureScenario | Promise<FixtureScenario>) {
      const { roomId } = await seedRoom(world);
      const ravi = await seedFriend(world.db, world.friends, { person: await recordingPerson(database) });
      unwrap(await joinRoom(world, ravi, roomId));
      const discussionId = await startTopic(world, ravi, roomId, 'Does batching always help?');
      unwrap(await say(world, ravi, roomId, discussionId, 'I think batching makes it cheaper.'));
      const model = fixtureModel(script, { label: 'rooms-inhabitants-recording' });
      const { harness } = fixtureRecordingHarness(database.db, { model, beforeApply: () => beforeApply() });
      return { roomId, ravi, discussionId, model, contribute: world.contribute(harness) };
    }
    const runsOf = async (turnId: string) =>
      (
        await sql<{
          purpose: string;
          state: string;
          recording_generation: number;
        }>`select purpose, state, recording_generation from reasoning.business_runs where id = ${turnId}::uuid`.execute(
          database.db,
        )
      ).rows;
    const noRunAtTheNewGeneration = async (ravi: Friend) =>
      (
        await sql<{
          n: string;
        }>`select count(*)::text as n from reasoning.business_runs where universe_id = ${ravi.universeId}::uuid and recording_generation = 3`.execute(
          database.db,
        )
      ).rows[0]!.n;
    beforeEach(() => {
      beforeApply = () => Promise.resolve();
    });

    it('answers the ask, and stamps the run with the generation recording was at when the job started', async () => {
      const { roomId, ravi, discussionId, model, contribute } = await recordingConversation(() =>
        answer('counterexample', 'Batching can hurt latency when requests arrive one at a time.'),
      );
      await pauseAndResume(database, ravi);
      const job = await askAndTake(ravi, roomId, discussionId);
      await contribute(job);
      expect(model.calls).toHaveLength(1);
      const view = await messagesOf(ravi, roomId, discussionId);
      expect(view.messages.at(-1)).toMatchObject({
        author: { kind: 'ai', inhabitant: 'skeptic' },
        body: { kind: 'text', text: 'Batching can hurt latency when requests arrive one at a time.' },
      });
      expect(await requestState(job.requestId)).toMatchObject({ state: 'completed' });
      expect(await runsOf(job.requestId)).toEqual([
        { purpose: 'inhabitant-contribution', state: 'completed', recording_generation: 3 },
      ]);
    });

    it('drops an answer that comes back after a pause and a resume: no message, the ask fails and the new generation holds no run', async () => {
      let release: (scenario: FixtureScenario) => void = () => undefined;
      const held = new Promise<FixtureScenario>((resolve) => (release = resolve));
      const { roomId, ravi, discussionId, model, contribute } = await recordingConversation(() => ({
        kind: 'hold',
        until: held,
      }));
      const job = await askAndTake(ravi, roomId, discussionId);
      const running = contribute(job);
      await expect.poll(() => model.calls.length).toBe(1);
      await pauseAndResume(database, ravi);
      release(answer('assumption', 'too late'));
      await running;
      expect(await requestState(job.requestId)).toMatchObject({ state: 'failed' });
      expect(JSON.stringify(await messagesOf(ravi, roomId, discussionId))).not.toContain('too late');
      expect(await noRunAtTheNewGeneration(ravi)).toBe('0');
    });

    it('stores nothing when recording is paused between the answer and the store', async () => {
      const { roomId, ravi, discussionId, model, contribute } = await recordingConversation(() =>
        answer('assumption', 'unstored'),
      );
      const job = await askAndTake(ravi, roomId, discussionId);
      beforeApply = async () => {
        beforeApply = () => Promise.resolve();
        await setRecording(database, ravi, 1, false);
      };
      await contribute(job);
      expect(model.calls).toHaveLength(1);
      expect(await requestState(job.requestId)).toMatchObject({ state: 'failed', dispatched: true });
      expect(JSON.stringify(await messagesOf(ravi, roomId, discussionId))).not.toContain('unstored');
      expect((await runsOf(job.requestId)).map((run) => run.state)).toEqual(['admitted']);
    });

    it('stores nothing for an answer in flight across Clear: nothing is written for the new epoch', async () => {
      let release: (scenario: FixtureScenario) => void = () => undefined;
      const held = new Promise<FixtureScenario>((resolve) => (release = resolve));
      const { roomId, ravi, discussionId, model, contribute } = await recordingConversation(() => ({
        kind: 'hold',
        until: held,
      }));
      const job = await askAndTake(ravi, roomId, discussionId);
      const running = contribute(job);
      await expect.poll(() => model.calls.length).toBe(1);
      await clearRecordingPerson(database, world.boss, ravi);
      release(answer('assumption', 'too late'));
      await running;
      const written = await sql<{
        n: string;
      }>`select count(*)::text as n from reasoning.business_runs where universe_id = ${ravi.universeId}::uuid and privacy_epoch > 1`.execute(
        database.db,
      );
      expect(written.rows[0]!.n).toBe('0');
      expect(JSON.stringify(await world.db.selectFrom('rooms.messages').selectAll().execute())).not.toContain(
        'too late',
      );
    });

    it('is refused without a model call while recording is paused: the ask ends as failed and is not counted', async () => {
      const { roomId, ravi, discussionId, model, contribute } = await recordingConversation(() =>
        answer('assumption', 'unused'),
      );
      await pauseAndResume(database, ravi);
      await setRecording(database, ravi, 3, false);
      const job = await askAndTake(ravi, roomId, discussionId);
      await contribute(job);
      expect(model.calls).toHaveLength(0);
      expect(await requestState(job.requestId)).toMatchObject({ state: 'failed', dispatched: false });
      expect(await runsOf(job.requestId)).toEqual([]);
    });
  });
});
