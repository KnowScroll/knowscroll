/**
 * A Launch's deck (v3 R-6, D-179) over real PostgreSQL: drafted by code from the library's calls, never by a model, waiting for an
 * operator, and approved only while every cited Scroll still says what the deck says. The library's calls here are labelled CI
 * fixtures (a fake read of the content module), never library content or provider output; the content read itself is tested in
 * `content-library-calls.test.ts` over a real admitted Scroll.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeReadLibraryPassageText,
  makeReadLibraryPassages,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { LibraryCallSource, ReadLibraryCalls } from '@knowscroll/backend/modules/content';
import { composeRitualOperator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import { roomScope, roomWorld, seedRoom, type RoomWorld } from '../support/rooms.js';

const START = new Date('2026-11-01T09:00:00Z');
const never = new AbortController().signal;
const ID = (n: number) => `0199b000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A labelled fixture Scroll with `count` calls. Not library content. */
const scroll = (n: number, count: number, over: { answer?: number } = {}): LibraryCallSource => ({
  assetId: ID(n),
  assetRevision: 1,
  title: `CI fixture Scroll ${String(n)}`,
  calls: Array.from({ length: count }, (_, index) => ({
    stopId: `s${String(index + 1)}`,
    prompt: `Fixture ${String(n)}.${String(index + 1)}: which option is the key?`,
    options: ['First fixture option', 'Second fixture option', 'Third fixture option'],
    answer: over.answer ?? 1,
    explain: `Fixture reason ${String(n)}.${String(index + 1)}: the Scroll says so. A second sentence follows.`,
  })),
});

describe('a Launch deck (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  /** What the library holds now; a test changes it to change what the Scrolls say. */
  let library: LibraryCallSource[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_launch_deck');
    world = await roomWorld(database, { now: START });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  const readCalls: ReadLibraryCalls = (_topic, limit, only) =>
    Promise.resolve(
      library
        .filter(
          (source) =>
            only === undefined || (source.assetId === only.assetId && source.assetRevision === only.assetRevision),
        )
        .slice(0, limit),
    );

  function operator() {
    const model = fixtureModel(() => ({ kind: 'success', text: '{}' }), { label: 'rooms-launch-deck' });
    const { harness, withScope } = roomScope(world.db, model);
    const ritual = composeRitualOperator({
      db: world.db,
      harness,
      withRoomScope: withScope,
      readPassages: makeReadLibraryPassages(world.db),
      readPassageText: makeReadLibraryPassageText(world.db),
      readCalls,
      model: model.model,
      generation: 1,
      now: () => world.clock.now,
    });
    return { ritual, model };
  }
  const decks = (roomId: string) =>
    world.db
      .selectFrom('rooms.rituals')
      .selectAll()
      .where('room_id', '=', roomId)
      .where('kind', '=', 'launch')
      .orderBy('day')
      .execute();

  it('drafts a deck of five calls from different Scrolls with no model call, waiting for an operator', async () => {
    library = [scroll(1, 2), scroll(2, 2), scroll(3, 1), scroll(4, 1)];
    const { roomId, slug } = await seedRoom(world);
    const { ritual, model } = operator();
    const room = (await ritual.roomBySlug(slug))!;
    const draft = await ritual.draftRoom({ room, day: '2026-11-01', dryRun: false, signal: never });
    expect(draft.launch).toEqual({ kind: 'drafted' });
    // The library has no prose under this fixture room's topic, so nothing else was made and no model was asked.
    expect(draft).toMatchObject({ question: { kind: 'no_source' }, flaw: { kind: 'no_source' } });
    expect(model.calls).toHaveLength(0);
    const [row] = await decks(roomId);
    expect(row).toMatchObject({
      state: 'draft',
      made_by: 'template',
      model: null,
      role_version: null,
      attempt_id: null,
    });
    const payload = row!.payload as { questions: { source: { assetId: string; stopId: string }; explain: string }[] };
    expect(payload.questions).toHaveLength(5);
    expect(new Set(payload.questions.map((question) => question.source.assetId)).size).toBeGreaterThanOrEqual(4);
    // Nothing is shown until an operator approves it.
    expect(await ritual.list({ state: 'approved' }, 10)).toEqual([]);
    const [listed] = await ritual.list({ state: 'draft' }, 10);
    expect(listed).toMatchObject({ kind: 'launch', state: 'draft', madeBy: 'template' });
  });

  it('does nothing the second time, and nothing at all for a dry run, a library too small, or a room that is not there', async () => {
    library = [scroll(1, 2), scroll(2, 2), scroll(3, 1), scroll(4, 1)];
    const { roomId, slug } = await seedRoom(world);
    const { ritual } = operator();
    const room = (await ritual.roomBySlug(slug))!;
    expect(await ritual.draftRoom({ room, day: '2026-11-01', dryRun: true, signal: never })).toMatchObject({
      launch: { kind: 'dry_run' },
    });
    expect(await decks(roomId)).toEqual([]);
    await ritual.draftRoom({ room, day: '2026-11-01', dryRun: false, signal: never });
    expect((await ritual.draftRoom({ room, day: '2026-11-01', dryRun: false, signal: never })).launch).toEqual({
      kind: 'exists',
    });
    expect(await decks(roomId)).toHaveLength(1);
    // Four usable calls are not five: nothing is invented.
    library = [scroll(1, 2), scroll(2, 2)];
    expect((await ritual.draftRoom({ room, day: '2026-11-02', dryRun: false, signal: never })).launch).toEqual({
      kind: 'no_source',
    });
    library = [];
    expect((await ritual.draftRoom({ room, day: '2026-11-03', dryRun: false, signal: never })).launch).toEqual({
      kind: 'no_source',
    });
    expect(await decks(roomId)).toHaveLength(1);
    expect(await ritual.roomBySlug('no-such-room')).toBeUndefined();
  });

  it('asks the room a different set of calls the next night when the library allows it', async () => {
    library = Array.from({ length: 8 }, (_, index) => scroll(index + 1, 1));
    const { roomId, slug } = await seedRoom(world);
    const { ritual } = operator();
    const room = (await ritual.roomBySlug(slug))!;
    await ritual.draftRoom({ room, day: '2026-11-01', dryRun: false, signal: never });
    await ritual.draftRoom({ room, day: '2026-11-02', dryRun: false, signal: never });
    const [first, second] = (await decks(roomId)).map((row) =>
      (row.payload as { questions: { source: { assetId: string } }[] }).questions.map(
        (question) => question.source.assetId,
      ),
    );
    expect(first).toHaveLength(5);
    // Eight Scrolls: the second night uses the three that the first did not, before any that it did.
    const unused = library.map((source) => source.assetId).filter((asset) => !first!.includes(asset));
    for (const asset of unused) expect(second).toContain(asset);
  });

  it('approves a deck only while every Scroll still says what it said, and refuses a changed, corrected or withdrawn one', async () => {
    library = [scroll(1, 2), scroll(2, 2), scroll(3, 1)];
    const { roomId, slug } = await seedRoom(world);
    const { ritual } = operator();
    const room = (await ritual.roomBySlug(slug))!;
    await ritual.draftRoom({ room, day: '2026-11-01', dryRun: false, signal: never });
    const first = (await decks(roomId))[0]!;
    // The key of a call changed in a Scroll that was corrected: the deck no longer holds.
    const changed = library.map((source) => ({
      ...source,
      calls: source.calls.map((call) => ({ ...call, answer: 2 })),
    }));
    const before = library;
    library = changed;
    expect(await ritual.review({ ritualId: first.ritual_id, decision: 'approved', by: 'cli:ci' })).toEqual({
      kind: 'citation_changed',
    });
    // A cited Scroll that is no longer served.
    library = before.slice(1);
    expect(await ritual.review({ ritualId: first.ritual_id, decision: 'approved', by: 'cli:ci' })).toEqual({
      kind: 'citation_changed',
    });
    expect((await decks(roomId))[0]!.state).toBe('draft');
    // As it was: approved, by a named operator, once.
    library = before;
    expect(await ritual.review({ ritualId: first.ritual_id, decision: 'approved', by: 'cli:ci' })).toEqual({
      kind: 'decided',
    });
    expect(await ritual.review({ ritualId: first.ritual_id, decision: 'rejected', by: 'cli:ci' })).toEqual({
      kind: 'not_draft',
    });
    const [approved] = await decks(roomId);
    expect(approved).toMatchObject({ state: 'approved', decided_by: 'cli:ci' });
    expect(await ritual.review({ ritualId: randomUUID(), decision: 'approved', by: 'cli:ci' })).toEqual({
      kind: 'unknown',
    });
    // A rejected deck is not made again for that day.
    await ritual.draftRoom({ room, day: '2026-11-02', dryRun: false, signal: never });
    const second = (await decks(roomId))[1]!;
    expect(await ritual.review({ ritualId: second.ritual_id, decision: 'rejected', by: 'cli:ci' })).toEqual({
      kind: 'decided',
    });
    expect((await ritual.draftRoom({ room, day: '2026-11-02', dryRun: false, signal: never })).launch).toEqual({
      kind: 'exists',
    });
  });

  it('refuses to approve a stored deck that is not five questions, as invalid', async () => {
    library = [scroll(1, 2), scroll(2, 2), scroll(3, 1)];
    const { roomId } = await seedRoom(world);
    const ritualId = randomUUID();
    await world.db
      .insertInto('rooms.rituals')
      .values({
        ritual_id: ritualId,
        room_id: roomId,
        day: '2026-11-01',
        kind: 'launch',
        payload: JSON.stringify({ questions: [] }),
        payload_version: 'ritual.v1',
        state: 'draft',
        made_by: 'template',
        created_at: START,
      })
      .execute();
    const { ritual } = operator();
    expect(await ritual.review({ ritualId, decision: 'approved', by: 'cli:ci' })).toEqual({ kind: 'invalid' });
    expect(await ritual.review({ ritualId, decision: 'rejected', by: 'cli:ci' })).toEqual({ kind: 'decided' });
  });
});
