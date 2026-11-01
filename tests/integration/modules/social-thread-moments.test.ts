/** Share a moment: a whole read stop of a v2 Scroll shared into a content thread, over real PostgreSQL (D-292). */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorIsMoment,
  computeIntegrityV2,
  momentAnchorOf,
  momentOf,
  quoteHash,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import type { ContentThreadRef, SnippetAnchor } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { assembleScrollV2 } from '../../../packages/scroll-model/src/producer/v2/assemble.js';
import { authoredV2, PUBLICATION_V2, recipeV2 } from '../../../packages/scroll-model/src/test-support/v2-fixtures.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { befriend, seedFriend, talkCases, withdraw, type Friend } from '../support/talk.js';

const version = 'content-thread.v1' as const;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('a moment of a v2 Scroll in a thread (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('social_thread_moments');
    cases = talkCases(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** The labelled assembled v2 fixture, admitted under a fresh asset with its integrity hash made right. */
  async function seedStageScroll(): Promise<{ assetId: string; document: ScrollDocumentV2 }> {
    const assembled = assembleScrollV2(authoredV2('plain'), PUBLICATION_V2, recipeV2('plain'));
    if (assembled.kind !== 'assembled') throw new Error('CI v2 fixture did not assemble');
    const assetId = randomUUID();
    const document = JSON.parse(JSON.stringify(assembled.document)) as ScrollDocumentV2;
    Object.assign(document, { assetId, revision: 1 });
    document.integrity.sha256 = computeIntegrityV2(document);
    await database.db
      .insertInto('content.assets')
      .values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' })
      .execute();
    await database.db
      .insertInto('content.asset_revisions')
      .values({
        asset_id: assetId,
        revision: 1,
        provenance_kind: 'authored_editorial',
        document_version: 'scroll-document.v2',
        document: JSON.stringify(document),
        document_sha256: document.integrity.sha256,
        explanation_unit_id: `ci-moment-${assetId.slice(0, 8)}`,
        language: 'en',
        title: document.title,
        reading_facts: '{}',
      })
      .execute();
    return { assetId, document };
  }

  async function momentThread() {
    const a = await seedFriend(database.db, cases.friends);
    const b = await seedFriend(database.db, cases.friends);
    await befriend(cases.friends, a, b);
    const scroll = await seedStageScroll();
    const created = unwrap(
      await cases.threads.create(a.authority, {
        version,
        commandId: randomUUID(),
        root: { assetId: scroll.assetId, assetRevision: 1 },
        friendPersonIds: [b.person.personId],
      }),
    );
    const [invitation] = unwrap(
      await cases.threads.inbox(b.authority, { version, readId: randomUUID(), limit: 50 }),
    ).items;
    if (!invitation) throw new Error('CI invitation missing');
    unwrap(
      await cases.threads.respond(b.authority, {
        version,
        commandId: randomUUID(),
        thread: invitation.thread,
        response: 'join',
      }),
    );
    return { a, b, aRef: created.thread, bRef: invitation.thread, scroll };
  }

  const send = (actor: Friend, thread: ContentThreadRef, assetId: string, anchor: SnippetAnchor) =>
    cases.threads.send(actor.authority, {
      version,
      commandId: randomUUID(),
      thread,
      body: { kind: 'snippet', target: { assetId, assetRevision: 1 }, anchor },
    });
  const ready = async (actor: Friend, thread: ContentThreadRef) => {
    const found = unwrap(
      await cases.threads.read(actor.authority, { version, readId: randomUUID(), thread, limit: 50 }),
    );
    if (found.status !== 'ready') throw new Error(`CI thread is ${found.status}`);
    return found;
  };
  const refused = (code: string) => ({ kind: 'refused', code });
  const readStop = (document: ScrollDocumentV2) => {
    const stop = document.stops.find((candidate) => candidate.kind === 'read');
    if (stop === undefined) throw new Error('CI fixture has no read stop');
    const moment = momentOf(document, stop.id);
    if (moment === undefined) throw new Error('CI fixture stop is not a moment');
    return moment;
  };

  it('shares a read stop: the message carries the exact revision and an anchor with a hash, and the card quotes the stop', async () => {
    const { a, b, aRef, bRef, scroll } = await momentThread();
    const moment = readStop(scroll.document);
    const anchor = momentAnchorOf(moment);
    // What the sender sends holds no words of the stop.
    expect(JSON.stringify(anchor)).not.toContain(moment.quote.slice(0, 12));
    const sent = unwrap(await send(a, aRef, scroll.assetId, anchor));
    expect(sent).toMatchObject({ sent: { kind: 'snippet', anchor: 'scroll_passage' } });
    const message = (await ready(b, bRef)).messages[0];
    expect(message).toMatchObject({
      body: {
        snippet: {
          kind: 'scroll_passage',
          blockId: moment.stopId,
          quote: moment.quote,
          content: { status: 'available' },
        },
      },
    });
    const opened = unwrap(
      await cases.threads.openSnippet(b.authority, {
        version,
        readId: randomUUID(),
        thread: bRef,
        messageId: (message as { messageId: string }).messageId,
      }),
    );
    expect(opened).toMatchObject({
      status: 'ready',
      content: { kind: 'scroll', assetId: scroll.assetId },
      anchor: { kind: 'scroll_passage', blockId: moment.stopId, start: 0, end: moment.quote.length },
    });
  });

  it('refuses what is not exactly one whole read stop, and writes nothing', async () => {
    const { a, aRef, scroll } = await momentThread();
    const moment = readStop(scroll.document);
    const anchor = momentAnchorOf(moment);
    const call = scroll.document.stops.find((stop) => stop.kind !== 'read');
    if (call === undefined) throw new Error('CI fixture has no call');
    // Part of a stop, a changed hash, a stop that is not there, a call (it would give its answer away) and a block anchor.
    expect(await send(a, aRef, scroll.assetId, { ...anchor, end: anchor.end - 1 })).toEqual(refused('invalid_input'));
    expect(await send(a, aRef, scroll.assetId, { ...anchor, start: 1 })).toEqual(refused('invalid_input'));
    expect(await send(a, aRef, scroll.assetId, { ...anchor, quoteHash: quoteHash('something else') })).toEqual(
      refused('invalid_input'),
    );
    expect(await send(a, aRef, scroll.assetId, { ...anchor, blockId: 'no-such-stop' })).toEqual(
      refused('invalid_input'),
    );
    expect(await send(a, aRef, scroll.assetId, { ...anchor, blockId: call.id })).toEqual(refused('invalid_input'));
    expect(
      await send(a, aRef, scroll.assetId, {
        kind: 'scroll_block',
        blockId: moment.stopId,
        blockType: 'paragraph',
        blockVersion: 1,
      }),
    ).toEqual(refused('invalid_input'));
    expect((await ready(a, aRef)).latestMessageSequence).toBe(0);
    expect(anchorIsMoment(moment, anchor)).toBe(true);
  });

  it('is refused by a thread whose series does not hold the Scroll, which the thread view says by its episodes', async () => {
    const { a, b, aRef, scroll } = await momentThread();
    const elsewhere = await seedStageScroll();
    const other = unwrap(
      await cases.threads.create(a.authority, {
        version,
        commandId: randomUUID(),
        root: { assetId: elsewhere.assetId, assetRevision: 1 },
        friendPersonIds: [b.person.personId],
      }),
    );
    const anchor = momentAnchorOf(readStop(scroll.document));
    // The anchor is a valid moment of this Scroll, yet a thread about another Scroll is not a place to post it.
    expect(await send(a, other.thread, scroll.assetId, anchor)).toEqual(refused('invalid_input'));
    expect((await ready(a, other.thread)).latestMessageSequence).toBe(0);
    // What the client reads to offer only threads that hold the Scroll: each thread's own episodes.
    expect((await ready(a, aRef)).episodes.map((episode) => episode.assetId)).toContain(scroll.assetId);
    expect((await ready(a, other.thread)).episodes.map((episode) => episode.assetId)).not.toContain(scroll.assetId);
    unwrap(await send(a, aRef, scroll.assetId, anchor));
  });

  it('stops showing the quote when the Scroll is withdrawn, while the card stays', async () => {
    const { a, b, aRef, bRef, scroll } = await momentThread();
    const moment = readStop(scroll.document);
    unwrap(await send(a, aRef, scroll.assetId, momentAnchorOf(moment)));
    await withdraw(database.db, scroll.assetId);
    const card = (await ready(b, bRef)).messages[0];
    expect(card).toMatchObject({ body: { snippet: { kind: 'scroll_passage', content: { status: 'unavailable' } } } });
    expect(JSON.stringify(card)).not.toContain(moment.quote);
  });
});
