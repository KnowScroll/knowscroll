/**
 * A room's daily items (v3 R-5, D-176) over real PostgreSQL, the real reasoning harness with a CI fixture model (never
 * provider output) and Scrolls admitted through the real import use case. The day's question is a template and costs no
 * call; Spot the flaw is one call that writes only an altered sentence, checked by code; both are drafts until an operator
 * approves them after the cited passage is read again.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  importEditorialScrollUseCase,
  makeReadLibraryPassageText,
  makeReadLibraryPassages,
} from '@knowscroll/backend/modules/content/nest-providers';
import { CONCEPTS, type ReadLibraryPassages } from '@knowscroll/backend/modules/content';
import { composeRitualOperator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel } from '../support/fixture-model.js';
import type { FixtureCall, FixtureModelPort, FixtureScenario } from '../support/fixture-model-port.js';
import {
  joined,
  PERSONAL_UNIVERSE_SCHEMAS,
  roomScope,
  roomWorld,
  rowsIn,
  seedRoom,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { starterSource } from '../support/scroll.js';
import type { Friend } from '../support/talk.js';

const START = new Date('2026-11-01T09:00:00Z');
const DAY = '2026-11-01';
const NEXT_DAY = '2026-11-02';
const never = new AbortController().signal;
/** A planet of the Machine learning system: a Scroll whose primary topic it is belongs to that system's room. */
const PLANET = CONCEPTS.find((concept) => concept.parent === 'machine-learning')!.id;

type StarterSource = {
  assetId: string;
  publication: { explanationUnitId: string };
  draft: { title: string; dek: string; sections: { blocks: { id: string; data: { spans: unknown } }[] }[] };
};

/** An authored CI fixture Scroll (the shipped starter under another identity), with paragraphs of several sentences. */
function scrollSource(assetId: string, unit: string, title: string): StarterSource {
  const source = starterSource() as unknown as StarterSource;
  source.assetId = assetId;
  source.publication.explanationUnitId = unit;
  source.draft.title = title;
  return source;
}

describe('a room’s daily items (real PostgreSQL, CI fixture model)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  const admit = () => importEditorialScrollUseCase(database.db);

  beforeAll(async () => {
    database = await createTestDatabase<Database>('rooms_rituals');
    world = await roomWorld(database, { now: START });
  });
  afterAll(async () => {
    await world.close();
    await database.drop();
  });

  /** Admits a CI Scroll as a library Scroll of the Machine learning system and returns its ID. */
  async function libraryScroll(title: string): Promise<string> {
    const assetId = randomUUID();
    const result = await admit()(scrollSource(assetId, `ci-ritual-${assetId.slice(0, 8)}`, title));
    expect(result.kind).toBe('imported');
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: assetId, asset_revision: 1, topic_id: PLANET, role: 'primary', weight: 0.8 })
      .execute();
    return assetId;
  }

  /** The operator over a fixture model that alters the sentence it is shown by swapping one word. */
  function operator(
    script?: (sequence: number, call: FixtureCall) => FixtureScenario,
    options: { readonly readPassages?: ReadLibraryPassages } = {},
  ) {
    const model: FixtureModelPort = fixtureModel(
      script ??
        ((_sequence, call) => ({
          kind: 'success',
          text: JSON.stringify({ kind: 'altered', text: alteredFrom(call.bytes) }),
        })),
      { label: 'rooms-ritual' },
    );
    const { harness, withScope } = roomScope(world.db, model);
    const ritual = composeRitualOperator({
      db: world.db,
      harness,
      withRoomScope: withScope,
      readPassages: options.readPassages ?? makeReadLibraryPassages(world.db),
      readPassageText: makeReadLibraryPassageText(world.db),
      model: model.model,
      generation: 1,
      now: () => world.clock.now,
    });
    return { ritual, model };
  }

  /** The sentence the request asks to alter, with one word swapped: a believable one-word change that passes the checks. */
  function alteredFrom(bytes: Uint8Array): string {
    const { user } = JSON.parse(Buffer.from(bytes).toString('utf8')) as { user: string };
    const passage = /<context-item ref="passage"[^>]*>\n([\s\S]*?)\n<\/context-item>/.exec(user)![1]!.split('\n');
    const asked = Number(/Rewrite sentence (\d) only/.exec(user)![1]);
    const original = passage[asked - 1]!.replace(/^\d+\. /, '');
    return original.replace(/\b([a-z]{4,})\b/, 'copper');
  }

  const room = async (topicId = 'machine-learning') => seedRoom(world, { topic: { kind: 'system', id: topicId } });
  const rituals = (roomId: string) =>
    world.db.selectFrom('rooms.rituals').selectAll().where('room_id', '=', roomId).orderBy('kind').execute();

  describe('drafting', () => {
    it('drafts a question (no call) and a Spot the flaw (one call), both waiting for an operator', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      await joined(world, roomId, 1);
      const personal = await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS);
      const { ritual, model } = operator();
      const found = (await ritual.roomBySlug(slug))!;
      const draft = await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(draft).toMatchObject({ room: slug, day: DAY, question: { kind: 'drafted' }, flaw: { kind: 'drafted' } });
      expect(model.calls).toHaveLength(1);
      const rows = await rituals(roomId);
      expect(rows.map((row) => [row.kind, row.state, row.made_by, row.decided_by])).toEqual([
        ['flaw', 'draft', 'model', null],
        ['question', 'draft', 'template', null],
      ]);
      const flaw = rows[0]!;
      expect(flaw.role_version).toBe('ritual.1');
      expect(flaw.attempt_id).not.toBeNull();
      const payload = flaw.payload as {
        sentences: string[];
        flawIndex: number;
        original: string;
        source: { blockId: string };
      };
      expect(payload.sentences.length).toBeGreaterThanOrEqual(3);
      expect(payload.sentences).not.toContain(payload.original);
      expect(payload.source.blockId).toMatch(/^[a-z]/);
      expect(await ritual.list({ state: 'approved' }, 10)).toEqual([]);
      expect(await rowsIn(world.db, PERSONAL_UNIVERSE_SCHEMAS)).toBe(personal);
    });

    it('sends the model the Scroll’s passage and nothing of the room: no member, no name, no ID', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const [member] = await joined(world, roomId, 1);
      const { ritual, model } = operator();
      await ritual.draftRoom({ room: (await ritual.roomBySlug(slug))!, day: DAY, dryRun: false, signal: never });
      const sent = Buffer.from(model.calls[0]!.bytes).toString('utf8');
      expect(sent).toContain('passage');
      expect(sent).not.toContain(member!.accountId);
      expect(sent).not.toContain(slug);
      expect(sent).not.toContain(roomId);
    });

    it('does nothing the second time: no call, no new row, however often the day is run', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      await joined(world, roomId, 1);
      const { ritual, model } = operator();
      const found = (await ritual.roomBySlug(slug))!;
      await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      const again = await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(again).toMatchObject({ question: { kind: 'exists' }, flaw: { kind: 'exists' } });
      // A fresh operator, as a retried job would build: the stored items and the ended run stop it.
      const retried = operator();
      await retried.ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(model.calls).toHaveLength(1);
      expect(retried.model.calls).toHaveLength(0);
      expect(await rituals(roomId)).toHaveLength(2);
    });

    it('shows what it would ask on a dry run, and stores and calls nothing', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const { ritual, model } = operator();
      const draft = await ritual.draftRoom({
        room: (await ritual.roomBySlug(slug))!,
        day: DAY,
        dryRun: true,
        signal: never,
      });
      expect(draft).toMatchObject({
        question: { kind: 'dry_run' },
        flaw: { kind: 'dry_run' },
      });
      expect(draft.flaw).toHaveProperty('plan.flawIndex');
      expect(model.calls).toHaveLength(0);
      expect(await rituals(roomId)).toEqual([]);
    });

    it('drafts a different Scroll on the next day when the library has another', async () => {
      const library = await world.db
        .selectFrom('content.encounter_topics')
        .select('asset_id')
        .where('topic_id', '=', PLANET)
        .execute();
      if (library.length < 2) await libraryScroll('CI fixture Scroll about tides');
      const { roomId, slug } = await room();
      await joined(world, roomId, 1);
      const { ritual } = operator();
      const found = (await ritual.roomBySlug(slug))!;
      await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      await ritual.draftRoom({ room: found, day: NEXT_DAY, dryRun: false, signal: never });
      const questions = (await rituals(roomId)).filter((row) => row.kind === 'question');
      const cited = questions.map((row) => (row.payload as { source: { assetId: string } }).source.assetId);
      expect(new Set(cited).size).toBe(2);
    });
  });

  describe('what costs nothing', () => {
    it('drafts for no empty room, no paused room and no room whose library has nothing under its topic', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const empty = await room();
      const paused = await room();
      await joined(world, paused.roomId, 1);
      await world.db
        .updateTable('rooms.rooms')
        .set({ status: 'paused' })
        .where('room_id', '=', paused.roomId)
        .execute();
      const bare = await room('history');
      await joined(world, bare.roomId, 1);
      const { ritual, model } = operator();
      // The night's batch: only an open room with a member, and it has nothing to draw on in History.
      const night = await ritual.draftAll({ day: '2026-12-24', signal: never });
      expect(night.map((entry) => entry.room)).not.toContain(empty.slug);
      expect(night.map((entry) => entry.room)).not.toContain(paused.slug);
      const history = night.find((entry) => entry.room === bare.slug);
      expect(history).toMatchObject({ question: { kind: 'no_source' }, flaw: { kind: 'no_source' } });
      expect(
        (await rituals(empty.roomId)).length +
          (await rituals(paused.roomId)).length +
          (await rituals(bare.roomId)).length,
      ).toBe(0);
      // Every call the night made was for a room that had a member and a Scroll.
      expect(night.length).toBeGreaterThan(0);
      expect(model.calls.length).toBe(night.filter((entry) => entry.flaw.kind === 'drafted').length);
    });

    it('makes no call when no passage has three readable sentences in a row, and still drafts the question', async () => {
      const short: ReadLibraryPassages = () =>
        Promise.resolve([
          {
            assetId: randomUUID(),
            assetRevision: 1,
            title: 'CI fixture short Scroll',
            summary: 'A fixture summary.',
            blocks: [{ blockId: 'short-block', text: 'One short line. Another.' }],
          },
        ]);
      const { roomId, slug } = await room();
      await joined(world, roomId, 1);
      const { ritual, model } = operator(undefined, { readPassages: short });
      const draft = await ritual.draftRoom({
        room: (await ritual.roomBySlug(slug))!,
        day: DAY,
        dryRun: false,
        signal: never,
      });
      expect(draft.flaw).toEqual({ kind: 'no_source' });
      expect(draft.question).toEqual({ kind: 'drafted' });
      expect(model.calls).toHaveLength(0);
      expect((await rituals(roomId)).map((row) => row.kind)).toEqual(['question']);
    });
  });

  describe('what the model proposes is checked by code', () => {
    it('refuses an alteration that fails the code’s checks: one repair, then no puzzle is stored and no third call is made', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const { ritual, model } = operator(() => ({
        kind: 'success',
        text: JSON.stringify({ kind: 'altered', text: 'The same words.' }),
      }));
      const found = (await ritual.roomBySlug(slug))!;
      const draft = await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(draft.flaw).toMatchObject({ kind: 'not_made' });
      expect(model.calls).toHaveLength(2);
      expect((await rituals(roomId)).map((row) => row.kind)).toEqual(['question']);
      // The run ended: asking again the same day pays for nothing.
      await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(model.calls).toHaveLength(2);
    });

    it('accepts the repair when it fixes the sentence: two calls, one stored puzzle', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const { ritual, model } = operator((sequence, call) =>
        sequence === 1
          ? {
              kind: 'success',
              text: JSON.stringify({ kind: 'altered', text: alteredFrom(call.bytes) + ' This is wrong.' }),
            }
          : { kind: 'success', text: JSON.stringify({ kind: 'altered', text: alteredFrom(call.bytes) }) },
      );
      const draft = await ritual.draftRoom({
        room: (await ritual.roomBySlug(slug))!,
        day: DAY,
        dryRun: false,
        signal: never,
      });
      expect(draft.flaw).toEqual({ kind: 'drafted' });
      expect(model.calls).toHaveLength(2);
      expect((await rituals(roomId)).map((row) => row.kind)).toEqual(['flaw', 'question']);
    });

    it('stores nothing for a model that finds nothing to alter, and does not ask again that day', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const { ritual, model } = operator(() => ({
        kind: 'success',
        text: JSON.stringify({ kind: 'nothing_to_add', text: '' }),
      }));
      const found = (await ritual.roomBySlug(slug))!;
      expect((await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never })).flaw).toEqual({
        kind: 'not_made',
        reason: 'nothing_to_add',
      });
      await ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(model.calls).toHaveLength(1);
      expect((await rituals(roomId)).map((row) => row.kind)).toEqual(['question']);
    });

    it('never sends a call whose outcome is unknown again, however often the night runs', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const lost = operator(() => ({ kind: 'timeout_after_dispatch' }));
      const found = (await lost.ritual.roomBySlug(slug))!;
      expect((await lost.ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never })).flaw).toMatchObject(
        {
          kind: 'not_made',
        },
      );
      expect(lost.model.calls).toHaveLength(1);
      const later = operator();
      await later.ritual.draftRoom({ room: found, day: DAY, dryRun: false, signal: never });
      expect(later.model.calls).toHaveLength(0);
      expect((await rituals(roomId)).map((row) => row.kind)).toEqual(['question']);
    });
  });

  describe('an operator approves what a member will see', () => {
    it('approves a draft after reading its passage again, and records who decided', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const { ritual } = operator();
      await ritual.draftRoom({ room: (await ritual.roomBySlug(slug))!, day: DAY, dryRun: false, signal: never });
      for (const row of await rituals(roomId)) {
        expect(await ritual.review({ ritualId: row.ritual_id, decision: 'approved', by: 'cli:ci' })).toEqual({
          kind: 'decided',
        });
        expect(await ritual.review({ ritualId: row.ritual_id, decision: 'rejected', by: 'cli:ci' })).toEqual({
          kind: 'not_draft',
        });
      }
      expect((await rituals(roomId)).map((row) => [row.state, row.decided_by])).toEqual([
        ['approved', 'cli:ci'],
        ['approved', 'cli:ci'],
      ]);
      expect(await ritual.review({ ritualId: randomUUID(), decision: 'approved', by: 'cli:ci' })).toEqual({
        kind: 'unknown',
      });
    });

    it('refuses to approve a puzzle whose Scroll was corrected, and a question whose Scroll was replaced', async () => {
      const assetId = await libraryScroll('CI fixture Scroll that will be corrected');
      const { roomId, slug } = await room('machine-learning');
      await world.db.deleteFrom('content.encounter_topics').where('asset_id', '<>', assetId).execute();
      const { ritual } = operator();
      await ritual.draftRoom({ room: (await ritual.roomBySlug(slug))!, day: DAY, dryRun: false, signal: never });
      const drafts = await rituals(roomId);
      expect(drafts).toHaveLength(2);
      // The Scroll is corrected: every paragraph reads differently, as a new revision.
      const corrected = scrollSource(assetId, `ci-ritual-${assetId.slice(0, 8)}`, 'CI fixture Scroll, corrected');
      for (const section of corrected.draft.sections)
        for (const block of section.blocks)
          if (typeof block.data.spans === 'string') block.data.spans = `${block.data.spans} This was added later.`;
          else if (Array.isArray(block.data.spans))
            block.data.spans = [{ text: 'A new first line that replaces the old one entirely.' }];
      expect(await admit()(corrected)).toMatchObject({ kind: 'imported', revision: 2 });
      for (const row of drafts)
        expect(await ritual.review({ ritualId: row.ritual_id, decision: 'approved', by: 'cli:ci' })).toEqual({
          kind: 'citation_changed',
        });
      expect((await rituals(roomId)).every((row) => row.state === 'draft')).toBe(true);
      // Rejecting is always allowed: it needs no Scroll.
      expect(await ritual.review({ ritualId: drafts[0]!.ritual_id, decision: 'rejected', by: 'cli:ci' })).toEqual({
        kind: 'decided',
      });
    });

    it('reaches a member only once approved: Today serves the question and the puzzle, and the first right tap earns the room a star', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { roomId, slug } = await room();
      const [asha, ravi] = (await joined(world, roomId, 2)) as [Friend, Friend];
      const { ritual } = operator();
      await ritual.draftRoom({ room: (await ritual.roomBySlug(slug))!, day: DAY, dryRun: false, signal: never });
      const today = (person: Friend) =>
        world.rooms.today(person.authority, { version: 'rooms.v1', readId: randomUUID(), roomId }).then(unwrap);
      // A draft is shown to no one.
      expect(await today(asha)).not.toHaveProperty('question');
      expect(await today(asha)).not.toHaveProperty('flaw');
      for (const row of await rituals(roomId))
        await ritual.review({ ritualId: row.ritual_id, decision: 'approved', by: 'cli:ci' });
      const view = await today(asha);
      if (view.status !== 'ready' || view.flaw?.state !== 'open') throw new Error('expected an open puzzle');
      expect(view.day).toBe(DAY);
      expect(view.question?.source).toMatchObject({ status: 'available' });
      const key = (await rituals(roomId)).find((row) => row.kind === 'flaw')!.payload as { flawIndex: number };
      expect(JSON.stringify(view)).not.toContain('flawIndex');
      const tap = (person: Friend, sentence: number) =>
        world.rooms.solveFlaw(person.authority, {
          version: 'rooms.v1',
          commandId: randomUUID(),
          roomId,
          ritualId: view.flaw!.ritualId,
          sentence,
        });
      const wrong = (key.flawIndex + 1) % view.flaw.sentences.length;
      expect(unwrap(await tap(asha, wrong))).toMatchObject({ correct: false, star: false });
      expect(unwrap(await tap(ravi, key.flawIndex))).toMatchObject({ correct: true, star: true });
      const after = await today(ravi);
      expect(after.status === 'ready' && after.flaw).toMatchObject({ state: 'done', correct: true, found: 1 });
      expect(after.status === 'ready' && after.flaw?.state === 'done' && after.flaw.source).toMatchObject({
        status: 'available',
      });
    });

    it('lists the items by state with their words and cited Scroll, and no person', async () => {
      await libraryScroll('CI fixture Scroll about the Moon');
      const { slug } = await room();
      const { ritual } = operator();
      await ritual.draftRoom({ room: (await ritual.roomBySlug(slug))!, day: DAY, dryRun: false, signal: never });
      const drafts = await ritual.list({ state: 'draft' }, 50);
      expect(drafts.filter((row) => row.room.slug === slug)).toHaveLength(2);
      expect(JSON.stringify(drafts)).not.toMatch(/account|email|handle/i);
    });
  });
});
