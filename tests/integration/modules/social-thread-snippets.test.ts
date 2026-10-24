/** Snippets, episodes and erasure of content threads over real PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBlockStateSnapshot,
  defaultBlockState,
  findBlock,
  projectText,
  quoteHash,
  type ScrollDocument,
} from '@knowscroll/scroll-model';
import { DELETED_ACCOUNT_LABEL, type ContentThreadRef, type SnippetAnchor } from '@knowscroll/contracts';
import { eraseCurrentAccount, personalStores } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { befriend, consumptionRows, seedFriend, talkCases, withdraw, type Friend } from '../support/talk.js';
import {
  activateFor,
  addReelRevision,
  addScrollRevision,
  declareSeries,
  seedReel,
  seedScroll,
  type SeededAsset,
  type SeededScroll,
} from '../support/thread-fixtures.js';

const version = 'content-thread.v1' as const;
const socialErasure = personalStores.find((declaration) => declaration.module === 'social')!;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

const blockOf = (document: ScrollDocument, id: string) => {
  const found = findBlock(document, id);
  if (found === null) throw new Error(`CI fixture has no block ${id}`);
  return found.block;
};

describe('thread snippets and episodes (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_thread_snippets');
    cases = talkCases(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const threads = () => cases.threads;
  const view = (actor: Friend, thread: ContentThreadRef, limit = 50) =>
    threads().read(actor.authority, { version, readId: randomUUID(), thread, limit });
  async function ready(actor: Friend, thread: ContentThreadRef) {
    const found = unwrap(await view(actor, thread));
    if (found.status !== 'ready') throw new Error(`CI thread is ${found.status}`);
    return found;
  }
  const sendSnippet = (
    actor: Friend,
    thread: ContentThreadRef,
    target: { assetId: string; assetRevision: number },
    anchor: SnippetAnchor,
    note?: string,
    commandId = randomUUID(),
  ) =>
    threads().send(actor.authority, {
      version,
      commandId,
      thread,
      body: { kind: 'snippet', target, anchor, ...(note === undefined ? {} : { note }) },
    });
  const open = (actor: Friend, thread: ContentThreadRef, messageId: string) =>
    threads().openSnippet(actor.authority, { version, readId: randomUUID(), thread, messageId });

  interface Series {
    readonly a: Friend;
    readonly b: Friend;
    readonly aRef: ContentThreadRef;
    readonly bRef: ContentThreadRef;
    readonly reel: SeededAsset;
    readonly attention: SeededScroll;
    readonly weight: SeededScroll;
  }

  /** Asha and Ravi in a thread on a three-part series: a Reel, then two Scrolls. */
  async function seriesThread(): Promise<Series> {
    const a = await seedFriend(database.db, cases.friends);
    const b = await seedFriend(database.db, cases.friends);
    await befriend(cases.friends, a, b);
    const reel = await seedReel(database.db, { durationMs: 30_000, title: 'The edge' });
    const attention = await seedScroll(database.db, 'attention-slowly');
    const weight = await seedScroll(database.db, 'weight-other-worlds');
    await declareSeries(database.db, `ci-series-${randomUUID()}`, [reel, attention, weight]);
    const created = unwrap(
      await threads().create(a.authority, {
        version,
        commandId: randomUUID(),
        root: { assetId: reel.assetId, assetRevision: 1 },
        friendPersonIds: [b.person.personId],
      }),
    );
    const [invitation] = unwrap(await threads().inbox(b.authority, { version, readId: randomUUID(), limit: 50 })).items;
    if (!invitation) throw new Error('CI invitation missing');
    unwrap(
      await threads().respond(b.authority, {
        version,
        commandId: randomUUID(),
        thread: invitation.thread,
        response: 'join',
      }),
    );
    return { a, b, aRef: created.thread, bRef: invitation.thread, reel, attention, weight };
  }

  const snippetRows = async (thread: ContentThreadRef) =>
    (
      await database.db
        .selectFrom('social.message_snippets as s')
        .innerJoin('social.messages as m', 'm.message_id', 's.message_id')
        .select('s.message_id')
        .where('m.conversation_id', '=', thread.threadId)
        .execute()
    ).length;
  const exact = (asset: SeededAsset) => ({ assetId: asset.assetId, assetRevision: 1 });
  const refused = (code: string) => ({ kind: 'refused', code });

  describe('episodes', () => {
    it('lists the declared series by part with the caller’s own visited marker only', async () => {
      const { a, b, aRef, bRef, reel, attention, weight } = await seriesThread();
      const asha = await ready(a, aRef);
      expect(asha.sequence).toEqual({ kind: 'series', total: 3 });
      expect(asha.episodes.map((episode) => [episode.part, episode.kind, episode.state, episode.visited])).toEqual([
        [1, 'reel', 'ready', false],
        [2, 'scroll', 'ready', false],
        [3, 'scroll', 'ready', false],
      ]);
      expect(asha.episodes[0]).toMatchObject({ assetId: reel.assetId, title: 'The edge' });

      // Asha opened and activated Part 1: her own marker, never visible in Ravi's view.
      await activateFor(database.db, a, reel.assetId, 'reel');
      expect((await ready(a, aRef)).episodes.map((episode) => episode.visited)).toEqual([true, false, false]);
      expect((await ready(b, bRef)).episodes.map((episode) => episode.visited)).toEqual([false, false, false]);

      // A corrected unit says so, a withdrawn one says so, and nothing is substituted.
      await addScrollRevision(database.db, attention.assetId, 2, attention.document);
      await withdraw(database.db, weight.assetId);
      expect((await ready(a, aRef)).episodes.map((episode) => [episode.part, episode.state])).toEqual([
        [1, 'ready'],
        [2, 'corrected'],
        [3, 'unavailable'],
      ]);
    });

    it('is the one item alone when the root is in no series', async () => {
      const a = await seedFriend(database.db, cases.friends);
      const b = await seedFriend(database.db, cases.friends);
      await befriend(cases.friends, a, b);
      const scroll = await seedScroll(database.db, 'weight-other-worlds');
      const created = unwrap(
        await threads().create(a.authority, {
          version,
          commandId: randomUUID(),
          root: exact(scroll),
          friendPersonIds: [b.person.personId],
        }),
      );
      const asha = await ready(a, created.thread);
      expect(asha.sequence).toEqual({ kind: 'single' });
      expect(asha.episodes).toHaveLength(1);
      expect(asha.episodes[0]).not.toHaveProperty('part');
    });
  });

  describe('a Reel moment', () => {
    it('is stored against the exact revision and shown to the other member', async () => {
      const { a, b, aRef, bRef, reel } = await seriesThread();
      const commandId = randomUUID();
      const range: SnippetAnchor = { kind: 'reel_range', startMs: 18_000, endMs: 29_000 };
      const sent = unwrap(await sendSnippet(a, aRef, exact(reel), range, 'Look at this moment', commandId));
      expect(sent).toMatchObject({ sent: { kind: 'snippet', anchor: 'reel_range' }, messageSequence: 1 });
      expect(unwrap(await sendSnippet(a, aRef, exact(reel), range, 'Look at this moment', commandId))).toMatchObject({
        replayed: true,
        messageSequence: 1,
      });
      const ravi = await ready(b, bRef);
      expect(ravi.messages).toHaveLength(1);
      expect(ravi.messages[0]).toMatchObject({
        status: 'available',
        author: { handle: a.person.handle },
        body: {
          kind: 'snippet',
          note: 'Look at this moment',
          snippet: { kind: 'reel_range', startMs: 18_000, endMs: 29_000, content: { status: 'available' } },
        },
      });
    });

    it('refuses what does not fit the Reel, and writes nothing', async () => {
      const { a, aRef, reel, attention } = await seriesThread();
      const range = (startMs: number, endMs: number): SnippetAnchor => ({ kind: 'reel_range', startMs, endMs });
      const invalid = refused('invalid_input');
      expect(await sendSnippet(a, aRef, exact(reel), range(25_000, 31_000))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(reel), range(10_000, 10_500))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(reel), range(20_000, 10_000))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(reel), range(1_000.5, 9_000))).toEqual(invalid);
      // A moment of a Scroll is not a thing, and neither is anchoring outside the thread's own series.
      expect(await sendSnippet(a, aRef, exact(attention), range(1_000, 9_000))).toEqual(invalid);
      const stranger = await seedReel(database.db);
      expect(await sendSnippet(a, aRef, exact(stranger), range(1_000, 9_000))).toEqual(invalid);
      expect((await ready(a, aRef)).latestMessageSequence).toBe(0);
      expect(await snippetRows(aRef), 'no snippet row survives a refusal').toBe(0);
    });

    it('refuses a snippet of content that is not the current revision', async () => {
      const { a, aRef, reel } = await seriesThread();
      await addReelRevision(database.db, reel.assetId, 2);
      expect(
        await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 1_000, endMs: 9_000 }),
      ).toEqual(refused('unavailable'));
      const second = await seriesThread();
      await withdraw(database.db, second.reel.assetId);
      expect(
        await sendSnippet(second.a, second.aRef, exact(second.reel), { kind: 'reel_range', startMs: 1_000, endMs: 9_000 }),
      ).toEqual(refused('unavailable'));
    });
  });

  describe('a Scroll passage', () => {
    function passageOf(document: ScrollDocument, id = 'crowd-p1') {
      const text = projectText(blockOf(document, id))!;
      const start = 'Read this: '.length;
      const end = text.indexOf('tired.') + 'tired.'.length;
      return { text, start, end, quote: text.slice(start, end) };
    }

    it('is validated against the exact text and shows its quote', async () => {
      const { a, b, aRef, bRef, attention } = await seriesThread();
      const { start, end, quote } = passageOf(attention.document);
      const anchor: SnippetAnchor = {
        kind: 'scroll_passage',
        blockId: 'crowd-p1',
        start,
        end,
        quoteHash: quoteHash(quote),
      };
      unwrap(await sendSnippet(a, aRef, exact(attention), anchor));
      const message = (await ready(b, bRef)).messages[0];
      expect(message).toMatchObject({
        body: { snippet: { kind: 'scroll_passage', blockId: 'crowd-p1', quote, content: { status: 'available' } } },
      });
    });

    it('refuses a quote that does not match, a bad range, and a block that is not text', async () => {
      const { a, aRef, attention } = await seriesThread();
      const { start, end, quote } = passageOf(attention.document);
      const passage = (patch: Partial<Extract<SnippetAnchor, { kind: 'scroll_passage' }>>): SnippetAnchor => ({
        kind: 'scroll_passage',
        blockId: 'crowd-p1',
        start,
        end,
        quoteHash: quoteHash(quote),
        ...patch,
      });
      const invalid = refused('invalid_input');
      expect(await sendSnippet(a, aRef, exact(attention), passage({ quoteHash: quoteHash('something else') }))).toEqual(
        invalid,
      );
      expect(await sendSnippet(a, aRef, exact(attention), passage({ end: 100_000 }))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), passage({ start: end, end: start }))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), passage({ blockId: 'no-such-block' }))).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), passage({ blockId: 'it-diagram' }))).toEqual(invalid);
      expect((await ready(a, aRef)).latestMessageSequence).toBe(0);
    });

    it('stops showing its quote when the content is withdrawn, while the card stays', async () => {
      const { a, b, aRef, bRef, attention } = await seriesThread();
      const { start, end, quote } = passageOf(attention.document);
      unwrap(
        await sendSnippet(a, aRef, exact(attention), {
          kind: 'scroll_passage',
          blockId: 'crowd-p1',
          start,
          end,
          quoteHash: quoteHash(quote),
        }),
      );
      await withdraw(database.db, attention.assetId);
      const card = (await ready(b, bRef)).messages[0];
      expect(card).toMatchObject({ body: { snippet: { kind: 'scroll_passage', content: { status: 'unavailable' } } } });
      expect(JSON.stringify(card)).not.toContain(quote);
    });
  });

  describe('a block and its settings', () => {
    const block = (document: ScrollDocument, id: string) => blockOf(document, id);

    it('shares the block alone, with settings, or with the sender’s own values only when confirmed', async () => {
      const { a, b, aRef, bRef, attention, weight } = await seriesThread();
      const sim = block(attention.document, 'length-sim');
      const base = { kind: 'scroll_block' as const, blockId: 'length-sim', blockType: sim.type, blockVersion: sim.version };

      // No settings: the card says they are not included.
      unwrap(await sendSnippet(a, aRef, exact(attention), base));
      // Settings of a block with no personal values travel as set.
      const snapshot = buildBlockStateSnapshot(sim, { type: 'simulation', params: { len: 4096 } });
      if (snapshot.kind !== 'snapshot') throw new Error('CI snapshot');
      unwrap(await sendSnippet(a, aRef, exact(attention), { ...base, settings: { snapshot: snapshot.snapshot } }));
      // The diagram state travels the same way.
      const diagram = block(attention.document, 'it-diagram');
      const frame = defaultBlockState(diagram);
      if (!frame) throw new Error('CI diagram has no state');
      const diagramSnapshot = buildBlockStateSnapshot(diagram, frame);
      if (diagramSnapshot.kind !== 'snapshot') throw new Error('CI diagram snapshot');
      unwrap(
        await sendSnippet(a, aRef, exact(attention), {
          kind: 'scroll_block',
          blockId: 'it-diagram',
          blockType: diagram.type,
          blockVersion: diagram.version,
          settings: { snapshot: diagramSnapshot.snapshot },
        }),
      );
      const cards = (await ready(b, bRef)).messages.map((message) =>
        message.status === 'available' && message.body.kind === 'snippet' ? message.body.snippet : undefined,
      );
      expect(cards[0]).toMatchObject({ kind: 'scroll_block', blockType: 'simulation', settings: { included: false } });
      expect(cards[1]).toMatchObject({
        settings: { included: true, personalIncluded: false, description: expect.stringContaining('4,096') },
      });
      expect(cards[2]).toMatchObject({ blockType: 'diagram', settings: { included: true } });
      expect(cards[0]).toMatchObject({ label: 'Sentence length and the work of attention' });

      // A value the sender entered themselves is left out unless they include it and confirm.
      const personal = block(weight.document, 'weight-sim');
      const personalBase = {
        kind: 'scroll_block' as const,
        blockId: 'weight-sim',
        blockType: personal.type,
        blockVersion: personal.version,
      };
      const withValue = buildBlockStateSnapshot(
        personal,
        { type: 'simulation', params: { weightKg: 75 } },
        { includePersonal: true },
      );
      const withoutValue = buildBlockStateSnapshot(personal, { type: 'simulation', params: { weightKg: 75 } });
      if (withValue.kind !== 'snapshot' || withoutValue.kind !== 'snapshot') throw new Error('CI snapshots');
      expect(withoutValue.snapshot).toEqual({ state: { type: 'simulation', params: {} }, personalIncluded: false });
      expect(await sendSnippet(a, aRef, exact(weight), { ...personalBase, settings: { snapshot: withValue.snapshot } })).toEqual(
        refused('invalid_input'),
      );
      expect(
        await sendSnippet(a, aRef, exact(weight), {
          ...personalBase,
          settings: { snapshot: withValue.snapshot, confirmPersonal: false },
        }),
      ).toEqual(refused('invalid_input'));
      unwrap(
        await sendSnippet(a, aRef, exact(weight), {
          ...personalBase,
          settings: { snapshot: withoutValue.snapshot },
        }),
      );
      unwrap(
        await sendSnippet(a, aRef, exact(weight), {
          ...personalBase,
          settings: { snapshot: withValue.snapshot, confirmPersonal: true },
        }),
      );
      const last = (await ready(b, bRef)).messages.at(-1);
      expect(last).toMatchObject({
        body: { snippet: { settings: { included: true, personalIncluded: true } } },
      });
      // The snapshot that left the value out says so, and the value is not on the wire.
      const second = (await ready(b, bRef)).messages.at(-2);
      expect(second).toMatchObject({ body: { snippet: { settings: { included: true, personalIncluded: false } } } });
    });

    it('refuses settings that do not fit the block', async () => {
      const { a, aRef, attention } = await seriesThread();
      const sim = block(attention.document, 'length-sim');
      const base = { kind: 'scroll_block' as const, blockId: 'length-sim', blockType: sim.type, blockVersion: sim.version };
      const invalid = refused('invalid_input');
      const bad = (params: Record<string, number>) => ({
        snapshot: { state: { type: 'simulation' as const, params }, personalIncluded: false },
      });
      expect(await sendSnippet(a, aRef, exact(attention), { ...base, settings: bad({ len: 4097 }) })).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), { ...base, settings: bad({ unknown: 1 }) })).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), { ...base, blockType: 'diagram' })).toEqual(invalid);
      expect(await sendSnippet(a, aRef, exact(attention), { ...base, blockVersion: 9 })).toEqual(invalid);
      // A block with no state cannot carry settings.
      const paragraph = block(attention.document, 'crowd-p1');
      expect(
        await sendSnippet(a, aRef, exact(attention), {
          kind: 'scroll_block',
          blockId: 'crowd-p1',
          blockType: paragraph.type,
          blockVersion: paragraph.version,
          settings: bad({}),
        }),
      ).toEqual(invalid);
      expect((await ready(a, aRef)).latestMessageSequence).toBe(0);
    });
  });

  describe('opening a snippet', () => {
    it('leads to the content and the anchor, and records nothing', async () => {
      const { a, b, aRef, bRef, reel, attention } = await seriesThread();
      const before = await consumptionRows(database.db);
      const moment = unwrap(
        await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 5_000, endMs: 12_000 }),
      );
      const text = projectText(blockOf(attention.document, 'crowd-p1'))!;
      const passage = unwrap(
        await sendSnippet(a, aRef, exact(attention), {
          kind: 'scroll_passage',
          blockId: 'crowd-p1',
          start: 0,
          end: 9,
          quoteHash: quoteHash(text.slice(0, 9)),
        }),
      );
      expect(unwrap(await open(b, bRef, moment.messageId))).toMatchObject({
        status: 'ready',
        content: { kind: 'reel', assetId: reel.assetId, assetRevision: 1 },
        anchor: { kind: 'reel_range', startMs: 5_000, endMs: 12_000 },
        mapped: false,
        settingsReset: false,
      });
      expect(unwrap(await open(b, bRef, passage.messageId))).toMatchObject({
        status: 'ready',
        content: { kind: 'scroll', assetId: attention.assetId },
        anchor: { kind: 'scroll_passage', blockId: 'crowd-p1', start: 0, end: 9 },
      });
      expect(await consumptionRows(database.db)).toBe(before);
    });

    it('is unavailable to a stranger and for a message that is not a snippet', async () => {
      const { a, aRef, reel } = await seriesThread();
      const stranger = await seedFriend(database.db, cases.friends);
      const moment = unwrap(await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 2_000, endMs: 8_000 }));
      const plain = unwrap(
        await threads().send(a.authority, {
          version,
          commandId: randomUUID(),
          thread: aRef,
          body: { kind: 'text', text: 'just words' },
        }),
      );
      expect(unwrap(await open(stranger, aRef, moment.messageId))).toMatchObject({ status: 'unavailable' });
      expect(unwrap(await open(a, aRef, plain.messageId))).toMatchObject({ status: 'unavailable' });
      expect(unwrap(await open(a, aRef, randomUUID()))).toMatchObject({ status: 'unavailable' });
    });

    it('says a corrected Reel changed and never plays the old range', async () => {
      const { a, b, aRef, bRef, reel } = await seriesThread();
      const moment = unwrap(await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 5_000, endMs: 12_000 }));
      await addReelRevision(database.db, reel.assetId, 2);
      const card = (await ready(b, bRef)).messages[0];
      expect(card).toMatchObject({
        body: { snippet: { content: { status: 'corrected', target: { assetRevision: 1 }, current: { assetRevision: 2 } } } },
      });
      expect(unwrap(await open(b, bRef, moment.messageId))).toMatchObject({
        status: 'changed',
        current: { kind: 'reel', assetId: reel.assetId, assetRevision: 2 },
      });
    });

    it('follows a corrected Scroll only through the explicit mapping, and says when it did', async () => {
      const { a, b, aRef, bRef, attention } = await seriesThread();
      const paragraph = blockOf(attention.document, 'crowd-p1');
      const text = projectText(paragraph)!;
      const end = text.indexOf('tired.') + 'tired.'.length;
      const start = 'Read this: '.length;
      const quote = text.slice(start, end);
      const anchor = unwrap(
        await sendSnippet(a, aRef, exact(attention), {
          kind: 'scroll_passage',
          blockId: 'crowd-p1',
          start,
          end,
          quoteHash: quoteHash(quote),
        }),
      );
      const edit = (change: (sections: ScrollDocument['sections']) => void) => {
        const sections = structuredClone(attention.document.sections);
        change(sections);
        return sections;
      };
      const spansOf = (sections: ScrollDocument['sections']) => {
        const target = sections.flatMap((section) => section.blocks).find((candidate) => candidate.id === 'crowd-p1');
        if (target?.type !== 'paragraph') throw new Error('CI paragraph');
        return target.data.spans;
      };

      // Revision 2 leaves the block as it was: the anchor holds, on the new revision.
      await addScrollRevision(database.db, attention.assetId, 2, attention.document);
      expect(unwrap(await open(b, bRef, anchor.messageId))).toMatchObject({
        status: 'ready',
        content: { assetRevision: 2 },
        anchor: { kind: 'scroll_passage', start, end },
        mapped: false,
      });
      // Revision 3 adds a sentence after the quote: the quote is found again, and the card says it moved.
      await addScrollRevision(
        database.db,
        attention.assetId,
        3,
        attention.document,
        edit((sections) => spansOf(sections).push({ text: ' It then walked on.' })),
      );
      expect(unwrap(await open(b, bRef, anchor.messageId))).toMatchObject({
        status: 'ready',
        content: { assetRevision: 3 },
        anchor: { kind: 'scroll_passage', start, end },
        mapped: true,
      });
      // Revision 4 rewrites the paragraph: the moment is gone, and the card offers the current Scroll.
      await addScrollRevision(
        database.db,
        attention.assetId,
        4,
        attention.document,
        edit((sections) => spansOf(sections).splice(0, spansOf(sections).length, { text: 'Rewritten from scratch.' })),
      );
      expect(unwrap(await open(b, bRef, anchor.messageId))).toMatchObject({
        status: 'changed',
        current: { kind: 'scroll', assetId: attention.assetId, assetRevision: 4 },
      });
    });

    it('is unavailable once the content is withdrawn', async () => {
      const { a, b, aRef, bRef, reel } = await seriesThread();
      const moment = unwrap(await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 5_000, endMs: 12_000 }));
      await withdraw(database.db, reel.assetId);
      expect(unwrap(await open(b, bRef, moment.messageId))).toMatchObject({ status: 'unavailable' });
    });
  });

  describe('erasure', () => {
    it('declares every thread store, with a Clear disposition that keeps it', () => {
      const declared = socialErasure.accountTables?.map((table) => `${table.schema}.${table.table}`);
      for (const store of ['social.content_threads', 'social.message_snippets'])
        expect(declared).toContain(store);
      for (const store of ['social.content_threads', 'social.message_snippets', 'social.conversation_members'])
        expect(socialErasure.clearExploration?.dispositions[store]).toBe('preserve');
    });

    it('lets the thread go on for the others when the starter deletes their account', async () => {
      const { a, b, reel } = await seriesThread();
      const c = await seedFriend(database.db, cases.friends);
      await befriend(cases.friends, a, c);
      const second = unwrap(
        await threads().create(a.authority, {
          version,
          commandId: randomUUID(),
          root: exact(reel),
          friendPersonIds: [b.person.personId, c.person.personId],
        }),
      );
      const [invitation] = unwrap(
        await threads().inbox(c.authority, { version, readId: randomUUID(), limit: 50 }),
      ).items;
      const [bSecond] = unwrap(await threads().inbox(b.authority, { version, readId: randomUUID(), limit: 50 })).items.filter(
        (item) => item.thread.threadId === second.thread.threadId,
      );
      if (!invitation || !bSecond) throw new Error('CI invitations missing');
      unwrap(
        await threads().respond(b.authority, {
          version,
          commandId: randomUUID(),
          thread: bSecond.thread,
          response: 'join',
        }),
      );
      unwrap(await threads().send(b.authority, { version, commandId: randomUUID(), thread: bSecond.thread, body: { kind: 'text', text: 'ravi stays' } }));
      unwrap(await threads().send(a.authority, { version, commandId: randomUUID(), thread: second.thread, body: { kind: 'text', text: 'asha secret words' } }));
      unwrap(await sendSnippet(a, second.thread, exact(reel), { kind: 'reel_range', startMs: 2_000, endMs: 9_000 }));
      expect(await snippetRows(second.thread)).toBe(1);

      const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        const receiptId = randomUUID();
        expect((await deleting.request(a.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      } finally {
        await boss.stop({ graceful: false });
      }

      // Asha's words and her snippet are gone from the thread; Ravi's remain.
      const ravi = await ready(b, bSecond.thread);
      expect(ravi.messages.map((message) => message.status)).toEqual(['available', 'unavailable', 'unavailable']);
      expect(JSON.stringify(ravi)).not.toContain('asha secret words');
      expect(JSON.stringify(ravi)).not.toContain(a.person.handle);
      expect(JSON.stringify(ravi)).not.toContain(a.person.personId);
      expect(ravi.participants.map((participant) => participant.person.handle)).not.toContain(a.person.handle);
      expect(ravi.participants.every((participant) => participant.role === 'member')).toBe(true);
      expect(await snippetRows(second.thread)).toBe(0);

      // Meera's open invitation names the neutral deleted person, and she can still join: nothing hangs on the deleted friend.
      expect(unwrap(await view(c, invitation.thread))).toMatchObject({
        status: 'invitation',
        invitedBy: { displayName: DELETED_ACCOUNT_LABEL },
      });
      unwrap(
        await threads().respond(c.authority, {
          version,
          commandId: randomUUID(),
          thread: invitation.thread,
          response: 'join',
        }),
      );
      expect((await ready(c, invitation.thread)).messages.map((message) => message.status)).toEqual([
        'available',
        'unavailable',
        'unavailable',
      ]);

      // No link to the deleted account is left anywhere in the thread tables.
      const links = await database.db
        .selectFrom('social.conversation_members')
        .select('conversation_id')
        .where((eb) => eb.or([eb('account_id', '=', a.accountId), eb('invited_by_account_id', '=', a.accountId)]))
        .execute();
      expect(links).toEqual([]);
      expect(
        await database.db
          .selectFrom('social.content_threads')
          .select('thread_id')
          .where('starter_account_id', '=', a.accountId)
          .execute(),
      ).toEqual([]);
    });

    it('exports a person’s own words, thread names and what they shared, and nothing of anyone else', async () => {
      const { a, b, aRef, bRef, reel } = await seriesThread();
      unwrap(await threads().send(b.authority, { version, commandId: randomUUID(), thread: bRef, body: { kind: 'text', text: 'what ravi wrote' } }));
      unwrap(await threads().send(a.authority, { version, commandId: randomUUID(), thread: aRef, body: { kind: 'text', text: 'what asha wrote' } }));
      unwrap(await sendSnippet(a, aRef, exact(reel), { kind: 'reel_range', startMs: 2_000, endMs: 9_000 }, 'look here'));
      const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 10_000 });
      const outcome = await withScope(a.authority, (scope) =>
        socialErasure.export!.read(scope, { accountId: a.accountId }),
      );
      if (outcome.kind !== 'entered') throw new Error('CI export');
      const file = JSON.stringify(outcome.value);
      expect(file).toContain('what asha wrote');
      expect(file).toContain('a moment of a Reel');
      expect(file).toContain('look here');
      expect(file).not.toContain('what ravi wrote');
      expect(file).not.toContain(b.person.handle);
      expect(file).not.toContain(b.person.personId);
      expect(outcome.value['threads']).toMatchObject({ started: expect.arrayContaining([expect.any(Object)]) });
    });
  });
});
