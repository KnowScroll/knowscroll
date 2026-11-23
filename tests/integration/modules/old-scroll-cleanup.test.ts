import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { checkLibrarySupportJob, checkLibrarySupportQueue } from '@knowscroll/backend/modules/content';
import { makeEnqueueLibrarySupport } from '@knowscroll/backend/modules/content/nest-providers';
import { DEFAULT_CAST } from '@knowscroll/backend/modules/rooms';
import { seedRooms } from '@knowscroll/backend/modules/rooms/nest-providers';
import { cleanupOldScrollsCommand } from '../../../apps/worker/src/old-scroll-cleanup-operator.js';
import { cleanupOldScrolls, type CleanupSummary } from '../../../apps/worker/src/old-scroll-cleanup.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { everyStoreSeeder } from '../support/every-store.js';
import type { FixturePerson } from '../support/fixtures.js';
import { recordingPerson } from '../support/recording-person.js';
import { recordProductionRun } from '../support/held-v3.js';
import { seedDocumentV2, seedDocumentV3 } from '../support/scroll-v3.js';
import { befriend, seedFriend, talkCases, type Friend } from '../support/talk.js';
import { declareSeries, seedReel, seedScroll } from '../support/thread-fixtures.js';

/**
 * `content cleanup-old-scrolls` (#791, D-437) over real PostgreSQL: every v1 and v2 Scroll leaves, with everything that points at it,
 * and the accounts, the document v3 Scrolls and the Reels stay. The data is built with the product's own use cases and the
 * existing fixtures; a few rows with no use case of their own (a branch card, a room's discussion, an order) are authored CI rows.
 * One scenario, in order: the guard checks, the refusals, the dry run, the run, the checks, a second run.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const version = 'content-thread.v1' as const;

function unwrap<T>(result: { kind: 'ok'; value: T } | { kind: 'refused'; code: string }): T {
  if (result.kind !== 'ok') throw new Error(`refused: ${result.code}`);
  return result.value;
}

/** The error a statement raised, by its message, inside its own transaction (which it aborts). */
async function refusedWith(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { message?: string }).message ?? 'error';
  }
  return 'not refused';
}

/** What the command wrote to its diagnostic log, so a failure says why. */
const diagnostics: unknown[] = [];
const logEvent = (event: string, fields?: unknown) => {
  const error = (fields as { error?: unknown } | undefined)?.error;
  diagnostics.push({ event, message: error instanceof Error ? error.message : '' });
};

describe('content cleanup-old-scrolls (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let cases: ReturnType<typeof talkCases>;
  let seeder: Awaited<ReturnType<typeof everyStoreSeeder>>;
  let boss: ReturnType<typeof createBoss>;
  const db = () => database.db;

  // People.
  let a: Friend;
  let b: Friend;
  let c: Friend;
  // Scrolls and Reels.
  let starter: string; // the authored v1 Scroll with coverage the shared fixture seeds
  let askScroll: string; // a v1 made-to-order "You asked" Scroll
  let libraryV1: string;
  let libraryV2: string;
  let mixedAsset: string; // a v2 revision 1 and a v3 revision 2, current 1
  let mixedHeld: string; // the same, but the v3 revision still waits at the review gate
  let v3Asset: string;
  let reelAsset: string;
  // Conversations.
  let removedThread: string; // rooted at the v2 Scroll
  let keptThread: string; // rooted at the v3 Scroll, holds cards to old Scrolls and a branch card
  let reelThread: string; // rooted at the Reel
  let direct: string;
  let tombstoneBefore: { sequence: number; changeSequence: number }[];
  let nodeKept: string;
  let nodeInRemovedThread: string;
  // Rooms.
  let roomId: string;
  let removedDiscussion: string;
  let keptDiscussion: string;
  // Summaries.
  let plan: CleanupSummary;
  let done: CleanupSummary;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('old_scroll_cleanup');
    cases = talkCases(db());
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    seeder = await everyStoreSeeder(database);
    // Accounts born the way a real one is (a verified address), so the recording lifecycle the readings need is there.
    const first = await recordingPerson(database);
    const second = await recordingPerson(database);
    // Two accounts with readings, offers, a Keep, play, evidence, a share and an ask, on the authored v1 Scroll.
    await seeder.seed(first);
    await seeder.seed(second);
    starter = (
      await db().selectFrom('content.assets').select('id').where('kind', '=', 'scroll').executeTakeFirstOrThrow()
    ).id;
    a = await seedFriend(db(), cases.friends, { person: first });
    b = await seedFriend(db(), cases.friends, { person: second });
    c = await seedFriend(db(), cases.friends);
    await befriend(cases.friends, a, b);
    await befriend(cases.friends, a, c);

    askScroll = (await seedScroll(db(), 'attention-slowly')).assetId;
    libraryV1 = (await seedScroll(db(), 'weight-other-worlds')).assetId;
    libraryV2 = (await seedDocumentV2(db(), 'seasons-stage-ci')).assetId;
    mixedAsset = (await seedDocumentV2(db(), 'scale-chart-blocks-ci')).assetId;
    await seedDocumentV3(db(), 'seasons-v3-ci', {
      assetId: mixedAsset,
      revision: 2,
      unit: `ci-mixed-${mixedAsset.slice(0, 8)}`,
    });
    // A v3 correction normally becomes current when it is released; here it has not been, so the current revision is still the v2.
    await db().updateTable('content.assets').set({ revision: 1 }).where('id', '=', mixedAsset).execute();
    mixedHeld = (await seedDocumentV2(db(), 'scale-chart-blocks-ci')).assetId;
    await seedDocumentV3(db(), 'seasons-v3-ci', {
      assetId: mixedHeld,
      revision: 2,
      unit: `ci-held-${mixedHeld.slice(0, 8)}`,
    });
    await db().updateTable('content.assets').set({ revision: 1 }).where('id', '=', mixedHeld).execute();
    await sql`insert into content.revision_reviews (asset_id, revision, state) values (${mixedHeld}::uuid, 2, 'held')`.execute(
      db(),
    );
    v3Asset = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
    reelAsset = (await seedReel(db(), { title: 'A Reel that stays' })).assetId;

    await authorLibraryRows();
    await authorConversations();
    await authorRooms();
    await authorPeopleRows();
  }, 120_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await seeder.close();
    await database.drop();
  });

  /** Coverage for a library Scroll's revision: the starter's mapping copied to it, as the production hook would store one. */
  async function coverFor(assetId: string, revision: number) {
    await sql`insert into content.coverage_revisions
        (asset_id, asset_revision, revision, status, mapping_sha256, command_sha256, semantic_review_reference, mapping)
      select ${assetId}::uuid, ${revision}::integer, revision, status, mapping_sha256, command_sha256, semantic_review_reference, mapping
      from content.coverage_revisions where asset_id = ${starter}::uuid`.execute(db());
    await sql`insert into content.coverage_heads (asset_id, asset_revision, revision)
      values (${assetId}::uuid, ${revision}::integer, 1)`.execute(db());
  }

  async function authorLibraryRows() {
    await coverFor(libraryV2, 1);
    // The v3 Scroll has coverage too (a v3 is never served without it): the cleanup must leave it.
    await coverFor(v3Asset, 1);
    await coverFor(mixedAsset, 2);
    await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by)
      values (${libraryV2}::uuid, 1, 'released', now(), 'cli:ci-fixture')`.execute(db());
    await sql`insert into content.release_risk_raises (asset_id, revision, category, proposed_by)
      values (${libraryV2}::uuid, 1, 'health', 'model:ci-fixture')`.execute(db());
    await sql`insert into content.library_support_checks
        (asset_id, revision, checker_version, state, verdict, policy_version, sentence_count, batches, requests, sentences)
      values (${libraryV2}::uuid, 1, 'ci-checker', 'checked', 'passed', 'ci-policy', 0, 0, 0, '[]'::jsonb)`.execute(
      db(),
    );
    await sql`insert into content.release_policy_looks (asset_id, revision, hold_code, rules_version)
      values (${libraryV2}::uuid, 1, 'ci_hold', 'ci-rules')`.execute(db());
    await sql`insert into content.release_withdrawals (asset_id, revision, withdrawn_by, approval)
      values (${libraryV2}::uuid, 1, 'cli:ci', 'no_topic')`.execute(db());
    await sql`insert into feedback.reports (report_id, reporter_account_id, kind, category, target_kind, asset_id, asset_revision, created_at)
      values (${randomUUID()}::uuid, ${b.accountId}::uuid, 'content_error', 'wrong', 'asset', ${libraryV1}::uuid, 1, now())`.execute(
      db(),
    );
    await declareSeries(db(), `ci-series-${randomUUID()}`, [{ assetId: libraryV2 }, { assetId: v3Asset }]);
    await sql`insert into content.continuity_links
        (id, revision, source_asset_id, source_asset_revision, target_asset_id, target_asset_revision, direction, relation, strength, authority_reference)
      values (${randomUUID()}::uuid, 1, ${libraryV1}::uuid, 1, ${v3Asset}::uuid, 1, 'related', '{"kind":"related_move"}'::jsonb, 1, 'ci-fixture')`.execute(
      db(),
    );
    await recordProductionRun(db(), { assetId: libraryV2, revision: 1 });
    // A "You asked" Scroll: its order has no foreign key to the asset, and nor does the job that made it.
    await sql`insert into content.made_to_order_scrolls (asset_id, recipe, mode, kicker, brief, pages, framing, explanation_unit_id)
      values (${askScroll}::uuid, ${`order-${randomUUID().replaceAll('-', '')}`}, 'question', 'You asked', 'Why is the sky blue?',
        ${['https://example.org/page']}::text[], '{"kind":"factual"}'::jsonb, ${`ci-order-${askScroll.slice(0, 8)}`})`.execute(
      db(),
    );
    await sql`insert into content.recipes (key, origin, status, title, topic_id, facet_id, asset_id, explanation_unit_id, brief, pages)
      values ('ci-recipe-v2', 'code', 'produced', 'A recipe of the old kind', 'earth.seasons', 'earth.seasons.axial-tilt',
        ${libraryV2}::uuid, 'ci-recipe-unit', ${'A brief that is long enough to satisfy the check on its length. '.repeat(2)}, ${['https://example.org/page']}::text[])`.execute(
      db(),
    );
    // The product's own sender: one queued check per revision, so there is one for the Scroll that goes and one for the one that stays.
    const enqueue = makeEnqueueLibrarySupport(boss);
    expect(await enqueue(checkLibrarySupportJob(libraryV2, 1, 'ci-checker'))).toBe('queued');
    expect(await enqueue(checkLibrarySupportJob(v3Asset, 1, 'ci-checker'))).toBe('queued');
  }

  async function authorConversations() {
    const thread = async (root: string, people: readonly Friend[]) => {
      const created = unwrap(
        await cases.threads.create(a.authority, {
          version,
          commandId: randomUUID(),
          root: { assetId: root, assetRevision: 1 },
          friendPersonIds: people.map((person) => person.person.personId),
        }),
      );
      for (const person of people) {
        const inbox = unwrap(await cases.threads.inbox(person.authority, { version, readId: randomUUID(), limit: 50 }));
        const invitation = inbox.items.find((item) => item.thread.threadId === created.thread.threadId);
        if (!invitation) throw new Error('CI invitation missing');
        unwrap(
          await cases.threads.respond(person.authority, {
            version,
            commandId: randomUUID(),
            thread: invitation.thread,
            response: 'join',
          }),
        );
      }
      return created.thread.threadId;
    };
    // A member's reference changes as others join, so each send reads the member's current one.
    const send = async (who: Friend, threadId: string, body: object) =>
      unwrap(
        await cases.threads.send(who.authority, {
          version,
          commandId: randomUUID(),
          thread: await refOf(who, threadId),
          body,
        }),
      );
    removedThread = await thread(libraryV2, [b]);
    await send(a, removedThread, { kind: 'text', text: 'About the seasons' });
    await send(b, removedThread, { kind: 'text', text: 'Yes' });
    keptThread = await thread(v3Asset, [b]);
    await send(a, keptThread, { kind: 'text', text: 'A thread that stays' });
    // A thread's use cases accept a card only into the thread's own series, so these cards (a snippet of a part of the series that
    // is old, a reaction to it, and a card to the Scroll that stays) are authored rows, written as the use case would.
    const oldCard = await card(keptThread, a, askScroll, true);
    await db()
      .insertInto('social.message_reactions')
      .values({
        conversation_id: keptThread,
        message_sequence: oldCard,
        account_id: b.accountId,
        kind: 'spark',
        reacted_at: new Date(),
      })
      .execute();
    await card(keptThread, b, v3Asset, false);
    reelThread = await thread(reelAsset, [c]);
    await card(reelThread, a, libraryV1, false);
    await db()
      .insertInto('social.thread_call_reveals')
      .values({ thread_id: keptThread, asset_id: libraryV1, revision: 1, stop_id: 'ci-stop' })
      .execute();
    // A direct conversation with a card to an old Scroll and a card to the Scroll that stays.
    const pairRef = unwrap(
      await cases.talk.conversations.start(a.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        peerPersonId: b.person.personId,
        expectedPairRevision: await pairRevisionOf(a, b),
      }),
    ).conversation;
    direct = pairRef.conversationId;
    const dm = (body: object) =>
      cases.talk.conversations.send(a.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        conversation: pairRef,
        body,
      });
    unwrap(await dm({ kind: 'text', text: 'Look at this' }));
    unwrap(await dm({ kind: 'content', target: { assetId: libraryV1, assetRevision: 1 }, note: 'an old one' }));
    unwrap(await dm({ kind: 'content', target: { assetId: v3Asset, assetRevision: 1 } }));
    // Managed share links: one to an old Scroll, one to the Scroll that stays.
    for (const asset of [libraryV1, v3Asset])
      unwrap(
        await cases.talk.shares.create(a.authority, {
          version: 'content-share.v1',
          commandId: randomUUID(),
          target: { assetId: asset, assetRevision: 1 },
          audience: { kind: 'public_metadata' },
        }),
      );
    // What if branches: one in the thread that stays (a v1 branch Scroll), one in the thread that goes.
    nodeKept = await branchCard(keptThread, askScroll);
    nodeInRemovedThread = await branchCard(removedThread, libraryV1);
    tombstoneBefore = (
      await sql<{ sequence: string; changeSequence: string }>`
        select sequence::text as sequence, change_sequence::text as "changeSequence" from social.messages
        where conversation_id = ${keptThread}::uuid and asset_id = ${askScroll}::uuid`.execute(db())
    ).rows.map((row) => ({ sequence: Number(row.sequence), changeSequence: Number(row.changeSequence) }));
    expect(tombstoneBefore).toHaveLength(1);
  }

  /** A card message to an exact revision, as a conversation's send writes it: the counters step, the row follows. Returns its sequence. */
  async function card(conversationId: string, author: Friend, assetId: string, withSnippet: boolean): Promise<number> {
    return db()
      .transaction()
      .execute(async (trx) => {
        const counters = await trx
          .updateTable('social.conversations')
          .set({ last_sequence: sql`last_sequence + 1`, last_change_sequence: sql`last_change_sequence + 1` })
          .where('conversation_id', '=', conversationId)
          .returning(['last_sequence', 'last_change_sequence'])
          .executeTakeFirstOrThrow();
        const messageId = randomUUID();
        await trx
          .insertInto('social.messages')
          .values({
            conversation_id: conversationId,
            sequence: counters.last_sequence,
            change_sequence: counters.last_change_sequence,
            message_id: messageId,
            command_id: randomUUID(),
            author_account_id: author.accountId,
            recorded_at: new Date(),
            asset_id: assetId,
            asset_revision: 1,
            note: 'a card',
          })
          .execute();
        if (withSnippet)
          await trx
            .insertInto('social.message_snippets')
            .values({
              message_id: messageId,
              kind: 'scroll_passage',
              block_id: 'ci-block',
              range_start: 0,
              range_end: 5,
              quote: 'quote',
              quote_hash: sha('quote'),
            })
            .execute();
        return Number(counters.last_sequence);
      });
  }

  async function pairRevisionOf(actor: Friend, peer: Friend): Promise<number> {
    const result = await cases.friends.readPair(actor.authority, {
      version: 'sharing.v1',
      peerPersonId: peer.person.personId,
    });
    if (result.kind !== 'ok' || result.value.status !== 'available') throw new Error('CI pair');
    return result.value.pair.pairRevision;
  }

  async function branchCard(thread: string, assetId: string): Promise<string> {
    const nodeId = randomUUID();
    await sql`insert into scenarios.nodes
        (node_id, thread_id, kind, origin_kind, started_by_account_id, title, changes, kept, assumptions, hypothetical,
         semantic_key, status, revision, asset_id, asset_revision, asset_title, created_at, updated_at, answer_state, answer, answer_settled_at)
      values (${nodeId}::uuid, ${thread}::uuid, 'what_if', 'root', ${a.accountId}::uuid, 'What if the Moon were closer',
        ${JSON.stringify([{ statement: 'The Moon is closer.' }])}::jsonb, '[]'::jsonb, '[]'::jsonb, true,
        ${sha(nodeId)}, 'ready', 1, ${assetId}::uuid, 1, 'A branch Scroll', now(), now(), null, null, null)`.execute(
      db(),
    );
    return nodeId;
  }

  async function authorRooms() {
    const slug = `ci-room-${randomUUID().slice(0, 8)}`;
    await seedRooms(
      db(),
      [
        {
          slug,
          name: 'Fixture room',
          description: 'A CI fixture room about running models.',
          guidelines: 'Be kind.',
          topic: { kind: 'system', id: 'machine-learning' },
          joinRule: 'open',
          cast: DEFAULT_CAST,
        },
      ],
      new Date(),
    );
    roomId = (await db().selectFrom('rooms.rooms').select('room_id').where('slug', '=', slug).executeTakeFirstOrThrow())
      .room_id;
    const discussion = async (root: string | null, title: string) => {
      const id = randomUUID();
      await db()
        .insertInto('rooms.discussions')
        .values({
          discussion_id: id,
          room_id: roomId,
          title,
          kind: 'topic',
          root_asset_id: root,
          root_asset_revision: root === null ? null : 1,
          last_sequence: 0,
          last_change_sequence: 0,
          last_activity_at: new Date(),
          created_at: new Date(),
        })
        .execute();
      return id;
    };
    const message = async (discussionId: string, sequence: number, card: string | null) => {
      const id = randomUUID();
      await db()
        .insertInto('rooms.messages')
        .values({
          discussion_id: discussionId,
          sequence,
          message_id: id,
          change_sequence: sequence,
          command_id: randomUUID(),
          author_kind: 'person',
          author_account_id: a.accountId,
          recorded_at: new Date(),
          body_text: card === null ? `message ${String(sequence)}` : null,
          asset_id: card,
          asset_revision: card === null ? null : 1,
        })
        .execute();
      await db()
        .updateTable('rooms.discussions')
        .set({ last_sequence: sequence, last_change_sequence: sequence })
        .where('discussion_id', '=', discussionId)
        .execute();
      return id;
    };
    removedDiscussion = await discussion(libraryV2, 'About the seasons');
    const removedMessage = await message(removedDiscussion, 1, null);
    await message(removedDiscussion, 2, v3Asset);
    await db()
      .insertInto('rooms.message_useful')
      .values({ account_id: b.accountId, message_id: removedMessage, marked_at: new Date() })
      .execute();
    keptDiscussion = await discussion(null, 'Anything goes');
    await message(keptDiscussion, 1, null);
    await message(keptDiscussion, 2, libraryV1);
    await message(keptDiscussion, 3, v3Asset);
    const cardToOld = await db()
      .selectFrom('rooms.messages')
      .select('message_id')
      .where('discussion_id', '=', keptDiscussion)
      .where('sequence', '=', '2')
      .executeTakeFirstOrThrow();
    await db()
      .insertInto('rooms.message_snippets')
      .values({
        message_id: cardToOld.message_id,
        kind: 'scroll_passage',
        block_id: 'ci-block',
        range_start: 0,
        range_end: 5,
        quote: 'quote',
        quote_hash: sha('quote'),
      })
      .execute();
    // What hangs off a discussion that goes: a hold on typing, a debate and a vote on a post.
    await db()
      .insertInto('rooms.typing_holds')
      .values({ discussion_id: removedDiscussion, held_until: new Date(Date.now() + 60_000) })
      .execute();
    await sql`insert into rooms.debates (discussion_id, side_a, side_b, state, closes_at)
      values (${removedDiscussion}::uuid, 'Yes', 'No', 'open', now() + interval '1 day')`.execute(db());
    await sql`insert into rooms.debate_votes (discussion_id, account_id, side, voted_at)
      values (${removedDiscussion}::uuid, ${b.accountId}::uuid, 'a', now())`.execute(db());
    await db()
      .insertInto('rooms.post_votes')
      .values({ account_id: b.accountId, discussion_id: removedDiscussion, voted_at: new Date() })
      .execute();
    // A resident's find of an old Scroll that never reached a discussion, and the answer of a kept turn that cites one.
    await sql`insert into rooms.ai_turns
        (turn_id, room_id, inhabitant, trigger, state, decided_by, dispatched, find_asset_id, find_asset_revision, created_at, settled_at)
      values (${randomUUID()}::uuid, ${roomId}::uuid, 'explainer', 'feed_find', 'refused', 'feed_day', false, ${libraryV2}::uuid, 1, now(), now())`.execute(
      db(),
    );
    // A daily question and a Launch of the room, with a source in an old Scroll: both name it inside a JSON payload.
    const ritual = async (kind: 'question' | 'flaw', day: string) => {
      const id = randomUUID();
      await sql`insert into rooms.rituals (ritual_id, room_id, day, kind, payload, payload_version, state, made_by, created_at)
        values (${id}::uuid, ${roomId}::uuid, ${day}::date, ${kind}, ${JSON.stringify({ source: { assetId: libraryV2, assetRevision: 1 } })}::jsonb,
          'ritual.v1', 'draft', 'template', now())`.execute(db());
      return id;
    };
    await ritual('question', '2026-11-20');
    const deck = await ritual('flaw', '2026-11-20');
    await sql`insert into rooms.launches (launch_id, room_id, deck_ritual_id, questions, starts_at, created_at, state)
      values (${randomUUID()}::uuid, ${roomId}::uuid, ${deck}::uuid, ${JSON.stringify(Array.from({ length: 5 }, () => ({ source: { assetId: libraryV2 } })))}::jsonb,
        now(), now(), 'live')`.execute(db());
    // Words a summary and the room's memory derived from messages that leave are erased, to be written again from what is left.
    await sql`insert into rooms.summaries
        (summary_id, room_id, resident, window_no, covers_from, covers_through, state, body, role_version, model, dispatched, created_at, settled_at)
      values (${randomUUID()}::uuid, ${roomId}::uuid, 'skeptic', 1, now() - interval '1 hour', now() + interval '1 hour', 'ready', 'a summary',
        'ci-role', 'ci-model', true, now(), now())`.execute(db());
    await sql`insert into rooms.room_memory (room_id, state, source, body, covers_from, covers_through, messages_read, updated_at)
      values (${roomId}::uuid, 'ready', 'derived', 'what the room remembers', now() - interval '1 hour', now() + interval '1 hour', 3, now())`.execute(
      db(),
    );
  }

  async function authorPeopleRows() {
    // A Keep of an old Scroll, and an ask for a "You asked" Scroll, for each of the two accounts that have history.
    for (const person of [a, b]) {
      await db()
        .insertInto('experience.saved_items')
        .values({ universe_id: person.universeId, asset_id: libraryV1, asset_revision: 1, saved_at: new Date() })
        .execute();
    }
    await db()
      .insertInto('experience.saved_items')
      .values({ universe_id: a.universeId, asset_id: v3Asset, asset_revision: 1, saved_at: new Date() })
      .execute();
    // A kept place goes with the Keep it belongs to.
    await sql`insert into experience.saved_places (universe_id, saved_entry_id, place_revision, position)
      select universe_id, saved_entry_id, 2, '{"kind":"reel","positionMs":1234}'::jsonb
      from experience.saved_items where universe_id = ${a.universeId}::uuid and asset_id = ${libraryV1}::uuid`.execute(
      db(),
    );
    await sql`insert into supply.requests
        (universe_id, privacy_epoch, id, command, state, request_revision, revision, decision, reason, created_at, updated_at, ask_order_id, ask_asset_id)
      values (${b.universeId}::uuid, 1, ${randomUUID()}::uuid, '{"version":"content-request.v1","fixture":"an ask"}'::jsonb, 'unavailable', 1, 1,
        'refuse', 'unsupported_request', now(), now(), ${randomUUID()}::uuid, ${askScroll}::uuid)`.execute(db());
  }

  const revisionsByVersion = async () =>
    (
      await sql<{ version: string; n: string }>`
        select revision.document_version as version, count(*)::text as n
        from content.asset_revisions revision join content.assets asset on asset.id = revision.asset_id
        where asset.kind = 'scroll' group by 1 order by 1`.execute(db())
    ).rows.map((row) => `${row.version}:${row.n}`);

  describe('the guards on coverage and release risk', () => {
    const SETTING = 'knowscroll.old_scroll_cleanup';

    it('refuse a delete with no setting, for a retired format as for any other', async () => {
      const heads = await refusedWith(
        sql`delete from content.coverage_heads where asset_id = ${libraryV2}::uuid`.execute(db()),
      );
      expect(heads).toContain('CONTENT_COVERAGE_HEAD_IMMUTABLE');
      const revisions = await refusedWith(
        sql`delete from content.coverage_revisions where asset_id = ${libraryV2}::uuid`.execute(db()),
      );
      expect(revisions).toContain('CONTENT_COVERAGE_REVISION_IMMUTABLE');
      const raises = await refusedWith(
        sql`delete from content.release_risk_raises where asset_id = ${libraryV2}::uuid`.execute(db()),
      );
      expect(raises).toContain('CONTENT_RELEASE_RAISE_IMMUTABLE');
    });

    it('let a delete through only with the setting and only for a revision of a retired format', async () => {
      const attempt = (...statements: ReturnType<typeof sql>[]) =>
        refusedWith(
          db()
            .transaction()
            .execute(async (trx) => {
              await sql`select set_config(${SETTING}, 'v1', true)`.execute(trx);
              for (const statement of statements) await statement.execute(trx);
              // Roll back whatever was let through: the scenario below runs the real cleanup on this data.
              throw new Error('rolled back');
            }),
        );
      // A v2 revision's rows go (the attempt reached the end, where it rolled itself back).
      expect(
        await attempt(
          sql`delete from content.region_bindings where asset_id = ${libraryV2}::uuid`,
          sql`delete from content.coverage_heads where asset_id = ${libraryV2}::uuid`,
          sql`delete from content.coverage_revisions where asset_id = ${libraryV2}::uuid`,
        ),
      ).toBe('rolled back');
      expect(await attempt(sql`delete from content.release_risk_raises where asset_id = ${libraryV2}::uuid`)).toBe(
        'rolled back',
      );
      // The coverage of a document v3 revision is refused even with the setting on, and so are a Reel's and any update.
      expect(await attempt(sql`delete from content.coverage_heads where asset_id = ${v3Asset}::uuid`)).toContain(
        'CONTENT_COVERAGE_HEAD_IMMUTABLE',
      );
      expect(await attempt(sql`delete from content.coverage_revisions where asset_id = ${v3Asset}::uuid`)).toContain(
        'CONTENT_COVERAGE_REVISION_IMMUTABLE',
      );
      expect(
        await attempt(
          sql`delete from content.coverage_heads where asset_id = ${mixedAsset}::uuid and asset_revision = 2`,
        ),
      ).toContain('CONTENT_COVERAGE_HEAD_IMMUTABLE');
      expect(
        await attempt(
          sql`update content.coverage_revisions set status = 'retracted' where asset_id = ${libraryV2}::uuid`,
        ),
      ).toContain('CONTENT_COVERAGE_REVISION_IMMUTABLE');
      expect(
        await attempt(sql`update content.coverage_heads set revision = revision where asset_id = ${libraryV2}::uuid`),
      ).toContain('CONTENT_COVERAGE_HEAD_STALE');
      expect(
        await attempt(sql`update content.release_risk_raises set category = 'law' where asset_id = ${libraryV2}::uuid`),
      ).toContain('CONTENT_RELEASE_RAISE_IMMUTABLE');
    });

    it('stay on for the transaction only: a pooled connection keeps no permit', async () => {
      await db()
        .transaction()
        .execute(async (trx) => {
          await sql`select set_config(${SETTING}, 'v1', true)`.execute(trx);
        });
      expect(
        await refusedWith(sql`delete from content.coverage_heads where asset_id = ${libraryV2}::uuid`.execute(db())),
      ).toContain('CONTENT_COVERAGE_HEAD_IMMUTABLE');
    });
  });

  describe('where it refuses', () => {
    it('stage and production before it opens a connection, and no other world either', async () => {
      for (const world of ['stage', 'production', 'live', 'somewhere']) {
        const printed: Record<string, unknown>[] = [];
        // The database URL names a database that does not exist: a refusal never reaches it.
        const code = await cleanupOldScrollsCommand(
          ['content', 'cleanup-old-scrolls', '--run'],
          (result) => printed.push(result),
          () => undefined,
          { KS_WORLD: world, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
        );
        expect(code).toBe(2);
        expect(printed).toEqual([
          { command: 'content cleanup-old-scrolls', mode: 'run', world, result: 'refused', code: 'world_not_allowed' },
        ]);
      }
      expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'stage' })).toMatchObject({
        result: 'refused',
        code: 'world_not_allowed',
      });
      expect(await revisionsByVersion()).toEqual([
        'scroll-document.v1:3',
        'scroll-document.v2:3',
        'scroll-document.v3:3',
      ]);
    });

    it('needs exactly one of --dry-run and --run', async () => {
      for (const argv of [
        ['content', 'cleanup-old-scrolls'],
        ['content', 'cleanup-old-scrolls', '--dry-run', '--run'],
      ]) {
        const printed: Record<string, unknown>[] = [];
        const code = await cleanupOldScrollsCommand(
          argv,
          (result) => printed.push(result),
          () => undefined,
          { KS_WORLD: 'dev' },
        );
        expect(code).toBe(2);
        expect(printed[0]).toMatchObject({ result: 'usage' });
      }
    });
  });

  it('--dry-run counts everything and changes nothing', async () => {
    const before = await revisionsByVersion();
    const printed: Record<string, unknown>[] = [];
    const code = await cleanupOldScrollsCommand(
      ['content', 'cleanup-old-scrolls', '--dry-run'],
      (result) => printed.push(result),
      logEvent,
      {
        KS_WORLD: 'ci',
        DATABASE_URL: database.settings.url,
      },
    );
    expect({ code, diagnostics }).toEqual({ code: 0, diagnostics: [] });
    plan = printed[0] as CleanupSummary;
    expect(plan).toMatchObject({ mode: 'dry_run', world: 'ci', result: 'planned' });
    expect(await revisionsByVersion()).toEqual(before);
    // Three v1 revisions and three v2 revisions go: the two mixed assets keep their v3 revision, so four assets go whole.
    expect(plan['assets']).toMatchObject({ assetsRemovedWhole: 4 });
    // Every step the data was built to exercise found rows, so a step that stopped matching would fail here and not pass as zero.
    const planned = (plan['tables'] as { table: string; action: string; rows: number }[]).filter(
      (step) => step.rows > 0,
    );
    for (const table of [
      'rooms.launches',
      'rooms.rituals',
      'rooms.summaries',
      'rooms.room_memory',
      'rooms.ai_turns',
      'rooms.typing_holds',
      'rooms.message_useful',
      'rooms.message_snippets',
      'rooms.debate_votes',
      'rooms.debates',
      'rooms.post_votes',
      'rooms.messages',
      'rooms.discussions',
      'scenarios.nodes',
      'social.thread_call_reveals',
      'social.message_reactions',
      'social.message_snippets',
      'social.content_shares',
      'social.messages',
      'social.conversation_members',
      'social.content_threads',
      'social.conversations',
      'experience.saved_places',
      'experience.saved_items',
      'feedback.reports',
      'content.continuity_links',
      'content.series_units',
      'content.encounter_topics',
      'content.region_bindings',
      'content.coverage_heads',
      'content.coverage_revisions',
      'content.library_support_checks',
      'content.release_policy_looks',
      'content.release_withdrawals',
      'content.release_risk_raises',
      'content.revision_reviews',
      'content.discovery_revisions',
      'content.asset_provenance',
      'content.asset_revisions',
      'content.assets',
      'content.scroll_production_runs',
      'content.recipes',
      'content.made_to_order_scrolls',
      'pgboss.job',
    ])
      expect(
        planned.map((step) => step.table),
        table,
      ).toContain(table);
    expect(plan['accounts']).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: a.accountId, keepsRemoved: 1, clearable: true })]),
    );
  });

  it('--run removes every v1 and v2 Scroll and what points at them, and prints what the dry run counted', async () => {
    const printed: Record<string, unknown>[] = [];
    const code = await cleanupOldScrollsCommand(
      ['content', 'cleanup-old-scrolls', '--run'],
      (result) => printed.push(result),
      logEvent,
      {
        KS_WORLD: 'ci',
        DATABASE_URL: database.settings.url,
      },
    );
    done = printed[0] as CleanupSummary;
    expect({ code, diagnostics, done: done?.['result'], why: done?.['code'] }).toEqual({
      code: 0,
      diagnostics: [],
      done: 'done',
      why: undefined,
    });
    // The run did what the dry run counted, table by table, and describes the same assets, threads, branches and rooms.
    expect(done['tables']).toEqual(plan['tables']);
    expect(done['assets']).toEqual(plan['assets']);
    expect(done['threads']).toEqual(plan['threads']);
    expect(done['branches']).toEqual(plan['branches']);
    expect(done['rooms']).toEqual(plan['rooms']);
    expect(done['accounts']).toEqual(plan['accounts']);
  });

  it('leaves only document v3 Scrolls, and the Scrolls and Reels that stay intact and served', async () => {
    expect(await revisionsByVersion()).toEqual(['scroll-document.v3:3']);
    const assets = await db()
      .selectFrom('content.assets')
      .select(['id', 'kind', 'status', 'revision'])
      .orderBy('id')
      .execute();
    // The Scrolls that stay are the v3 Scroll and the mixed one; every other asset is a Reel (this one, and the shared fixture's).
    expect(
      assets
        .filter((asset) => asset.kind === 'scroll')
        .map((asset) => asset.id)
        .sort(),
    ).toEqual([mixedAsset, mixedHeld, v3Asset].sort());
    expect(assets.filter((asset) => asset.kind === 'reel').map((asset) => asset.id)).toContain(reelAsset);
    // The mixed asset's current revision moved from its v2 to its v3; it is served again.
    expect(assets.find((asset) => asset.id === mixedAsset)).toMatchObject({ revision: 2, status: 'admitted' });
    // A mixed asset whose v3 revision still waits at the review gate is not served by the move: it is held, as a first revision is.
    expect(assets.find((asset) => asset.id === mixedHeld)).toMatchObject({ revision: 2, status: 'held' });
    expect(assets.find((asset) => asset.id === v3Asset)).toMatchObject({ revision: 1, status: 'admitted' });
    expect(assets.find((asset) => asset.id === reelAsset)).toMatchObject({
      kind: 'reel',
      revision: 1,
      status: 'admitted',
    });
    // Their coverage, discovery and series rows are untouched.
    for (const [asset, revision] of [
      [v3Asset, 1],
      [mixedAsset, 2],
    ] as const) {
      const rows = await sql<{ n: string }>`select (
          (select count(*) from content.coverage_heads where asset_id = ${asset}::uuid and asset_revision = ${revision}::integer) +
          (select count(*) from content.coverage_revisions where asset_id = ${asset}::uuid and asset_revision = ${revision}::integer) +
          (select count(*) from content.discovery_revisions where asset_id = ${asset}::uuid and asset_revision = ${revision}::integer))::text as n`.execute(
        db(),
      );
      expect(Number(rows.rows[0]?.n)).toBe(3);
    }
    expect(
      (await db().selectFrom('content.series_units').select('asset_id').execute()).map((row) => row.asset_id),
    ).toEqual([v3Asset]);
    // The thread on the Scroll that stays still reads: its root is available.
    const view = unwrap(
      await cases.threads.read(nowAuthority(b, 2), {
        version,
        readId: randomUUID(),
        thread: await refOf(b, keptThread, 2),
        limit: 50,
      }),
    );
    expect(view).toMatchObject({ status: 'ready', root: { status: 'available' } });
  });

  it('removes the rows that have no foreign key', async () => {
    const left = await sql<{ orders: string; runs: string; jobs: string; recipe: string }>`select
        (select count(*) from content.made_to_order_scrolls)::text as orders,
        (select count(*) from content.scroll_production_runs)::text as runs,
        (select count(*) from pgboss.job where name = ${checkLibrarySupportQueue.name} and data ->> 'assetId' = ${libraryV2})::text as jobs,
        (select status from content.recipes where key = 'ci-recipe-v2') as recipe`.execute(db());
    expect(left.rows[0]).toMatchObject({ orders: '0', runs: '0', jobs: '0', recipe: 'checked' });
    // The check queued for the Scroll that stays is still queued.
    const kept = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
      where name = ${checkLibrarySupportQueue.name} and data ->> 'assetId' = ${v3Asset}`.execute(db());
    expect(kept.rows[0]?.n).toBe('1');
  });

  /** The person's authority now: Clear stepped their privacy epoch from 1 to 2, which is what makes an app drop what it held. */
  const nowAuthority = (person: FixturePerson, epoch = 1) => ({ ...person.authority, privacyEpoch: epoch });

  async function refOf(actor: Friend, threadId: string, epoch = 1) {
    const inbox = unwrap(
      await cases.threads.inbox(nowAuthority(actor, epoch), { version, readId: randomUUID(), limit: 50 }),
    );
    const item = inbox.items.find((entry) => entry.thread.threadId === threadId);
    if (!item) throw new Error('CI thread not in the inbox');
    return item.thread;
  }

  it('removes the thread rooted at an old Scroll whole, and keeps the other threads and conversations', async () => {
    const conversations = await db().selectFrom('social.conversations').select(['conversation_id', 'kind']).execute();
    expect(conversations.map((row) => row.conversation_id).sort()).toEqual([keptThread, reelThread, direct].sort());
    expect(
      await db()
        .selectFrom('social.content_threads')
        .select('thread_id')
        .where('thread_id', '=', removedThread)
        .execute(),
    ).toEqual([]);
    expect(
      await db().selectFrom('scenarios.nodes').select('node_id').where('node_id', '=', nodeInRemovedThread).execute(),
    ).toEqual([]);
    expect(
      await db()
        .selectFrom('social.conversation_members')
        .select('account_id')
        .where('conversation_id', '=', removedThread)
        .execute(),
    ).toEqual([]);
  });

  it('turns a card to an old Scroll into a tombstone where the conversation stays, with a fresh change number', async () => {
    const [before] = tombstoneBefore;
    const cards = await sql<{
      author: string | null;
      asset: string | null;
      body: string | null;
      change: string;
      sequence: string;
    }>`
      select author_account_id as author, asset_id as asset, body_text as body, change_sequence::text as change, sequence::text as sequence
      from social.messages where conversation_id = ${keptThread}::uuid and sequence = ${before!.sequence}`.execute(
      db(),
    );
    expect(cards.rows[0]).toMatchObject({ author: null, asset: null, body: null });
    expect(Number(cards.rows[0]?.change)).toBeGreaterThan(before!.changeSequence);
    // The same in the direct conversation and the Reel's thread; the card to the Scroll that stays is intact.
    const remaining = await sql<{ asset: string | null; n: string }>`
      select asset_id as asset, count(*)::text as n from social.messages
      where conversation_id = any(${[keptThread, direct, reelThread]}::uuid[]) and asset_id is not null group by 1`.execute(
      db(),
    );
    expect(remaining.rows).toEqual([{ asset: v3Asset, n: '2' }]);
    // A member's catch-up sees the tombstones: the thread's last change number moved past every message's.
    const heads = await sql<{ ok: boolean }>`select bool_and(conversation.last_change_sequence >= (
        select max(message.change_sequence) from social.messages message where message.conversation_id = conversation.conversation_id)) as ok
      from social.conversations conversation`.execute(db());
    expect(heads.rows[0]?.ok).toBe(true);
    // Shares and reveals of old Scrolls are gone; the one to the Scroll that stays is not.
    expect(
      (await db().selectFrom('social.content_shares').select('asset_id').execute()).map((row) => row.asset_id),
    ).toEqual([v3Asset]);
    expect(await db().selectFrom('social.thread_call_reveals').select('thread_id').execute()).toEqual([]);
  });

  it('closes a branch card whose Scroll is old and keeps the thread it is in', async () => {
    const node = await db()
      .selectFrom('scenarios.nodes')
      .selectAll()
      .where('node_id', '=', nodeKept)
      .executeTakeFirstOrThrow();
    expect(node).toMatchObject({
      status: 'removed',
      asset_revision: null,
      revision: 2,
      answer: null,
      answer_state: null,
    });
  });

  it('removes the room discussion rooted at an old Scroll and tombstones the card in the one that stays', async () => {
    expect(
      await db()
        .selectFrom('rooms.discussions')
        .select('discussion_id')
        .where('discussion_id', '=', removedDiscussion)
        .execute(),
    ).toEqual([]);
    expect(
      await db()
        .selectFrom('rooms.messages')
        .select('message_id')
        .where('discussion_id', '=', removedDiscussion)
        .execute(),
    ).toEqual([]);
    const cards = await sql<{ sequence: string; asset: string | null; author: string | null; change: string }>`
      select sequence::text as sequence, asset_id as asset, author_account_id as author, change_sequence::text as change
      from rooms.messages where discussion_id = ${keptDiscussion}::uuid order by sequence`.execute(db());
    expect(cards.rows.map((row) => [row.sequence, row.asset])).toEqual([
      ['1', null],
      ['2', null],
      ['3', v3Asset],
    ]);
    expect(cards.rows[1]).toMatchObject({ author: null });
    expect(Number(cards.rows[1]?.change)).toBeGreaterThan(2);
    // What hung off the discussion that went, and what named an old Scroll in a payload, is gone; what read the messages that left is erased.
    for (const table of [
      'rooms.message_snippets',
      'rooms.message_useful',
      'rooms.debate_votes',
      'rooms.debates',
      'rooms.post_votes',
      'rooms.typing_holds',
      'rooms.rituals',
      'rooms.launches',
      'rooms.ai_turns',
    ]) {
      const rows = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(db());
      expect({ table, rows: rows.rows[0]?.n }).toEqual({ table, rows: '0' });
    }
    const summary = await sql<{ state: string; body: string | null }>`select state, body from rooms.summaries`.execute(
      db(),
    );
    expect(summary.rows).toEqual([{ state: 'stale', body: null }]);
    const memory = await sql<{ state: string; body: string | null }>`select state, body from rooms.room_memory`.execute(
      db(),
    );
    expect(memory.rows).toEqual([{ state: 'stale', body: null }]);
  });

  it('keeps the accounts, clears their history the product’s way and leaves nothing derived from a removed reading', async () => {
    for (const person of [a, b, c] as FixturePerson[]) {
      const account = await db()
        .selectFrom('identity.accounts')
        .select('status')
        .where('id', '=', person.accountId)
        .executeTakeFirstOrThrow();
      expect(account.status).toBe('active');
      const universe = await db()
        .selectFrom('identity.universes')
        .select(['privacy_epoch', 'clear_operation_id', 'status'])
        .where('id', '=', person.universeId)
        .executeTakeFirstOrThrow();
      expect(universe).toMatchObject({ clear_operation_id: null, status: 'active' });
      expect(universe.privacy_epoch).toBe(2);
      // The account can act at its new epoch: its universe is usable, which is what signing in leads to.
      const entered = await makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(
        { universeId: person.universeId, privacyEpoch: 2, actor: { kind: 'account', accountId: person.accountId } },
        () => Promise.resolve('here'),
      );
      expect(entered).toEqual({ kind: 'entered', value: 'here' });
    }
    // The two accounts born with a verified address keep it, so they can ask for a sign-in link as before.
    for (const person of [a, b]) {
      const addresses = await db()
        .selectFrom('identity.email_addresses')
        .select('account_id')
        .where('account_id', '=', person.accountId)
        .execute();
      expect(addresses).toHaveLength(1);
    }
    // Every table the Universe's totals derive from, and every store of a reading, is empty for every account.
    for (const table of [
      'experience.exposures',
      'experience.offers',
      'experience.actions',
      'evidence.observations',
      'evidence.encounter_evidence',
      'evidence.topic_context',
      'evidence.topic_format_cells',
      'evidence.interest_rollups',
      'personal_context.coverage_supports',
      'personal_context.coverage_references',
      'personal_context.topics',
      'geography.objects',
      'scenes.objects',
      'social.visit_planets',
      'supply.requests',
      'supply.quick_answers',
    ]) {
      const rows = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(db());
      expect({ table, rows: rows.rows[0]?.n }).toEqual({ table, rows: '0' });
    }
    // The Keeps of the Scrolls that went are gone; the Keep of the Reel and the Keep of the v3 Scroll stay, and each still names an asset.
    const keeps = await db().selectFrom('experience.saved_items').select(['universe_id', 'asset_id']).execute();
    expect(keeps.map((keep) => keep.asset_id)).not.toContain(libraryV1);
    expect(keeps.filter((keep) => keep.asset_id === v3Asset)).toEqual([
      { universe_id: a.universeId, asset_id: v3Asset },
    ]);
    expect(
      (
        await sql<{ n: string }>`select count(*)::text as n from experience.saved_places place
        where not exists (select 1 from experience.saved_items item where item.universe_id = place.universe_id and item.saved_entry_id = place.saved_entry_id)`.execute(
          db(),
        )
      ).rows[0]?.n,
    ).toBe('0');
    // A friend's list, a conversation's members and the inbox heads of the people in the thread that went were read again.
    const heads = await db()
      .selectFrom('social.inbox_heads')
      .select(['account_id', 'revision'])
      .where('account_id', '=', b.accountId)
      .executeTakeFirst();
    expect(Number(heads?.revision ?? 0)).toBeGreaterThan(0);
  });

  it('a second --run finds nothing and changes nothing', async () => {
    const epochs = await sql<{ id: string; privacy_epoch: number; revision: number }>`
      select id, privacy_epoch, revision from identity.universes order by id`.execute(db());
    const state = async () =>
      (
        await sql<{ n: string }>`select (
          (select count(*) from content.assets) + (select count(*) from content.asset_revisions) + (select count(*) from social.messages) +
          (select count(*) from rooms.messages) + (select count(*) from scenarios.nodes) + (select count(*) from experience.saved_items)
        )::text as n`.execute(db())
      ).rows[0]?.n;
    const before = await state();
    const again = await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' });
    expect(again).toMatchObject({ result: 'nothing_to_do' });
    expect((again['tables'] as { rows: number }[]).every((table) => table.rows === 0)).toBe(true);
    expect(await state()).toBe(before);
    const after = await sql<{ id: string; privacy_epoch: number; revision: number }>`
      select id, privacy_epoch, revision from identity.universes order by id`.execute(db());
    expect(after.rows).toEqual(epochs.rows);
    expect(await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'dev' })).toMatchObject({ result: 'nothing_to_do' });
  });
});

describe('content cleanup-old-scrolls when it cannot finish (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let oldScroll: string;
  let v3Scroll: string;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('old_scroll_cleanup_fail');
    oldScroll = (await seedScroll(db(), 'attention-slowly')).assetId;
    v3Scroll = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
  });
  afterAll(async () => {
    await database.drop();
  });

  const state = async () =>
    (
      await sql<{ assets: string; revisions: string; status: string | null }>`select
        (select count(*) from content.assets)::text as assets, (select count(*) from content.asset_revisions)::text as revisions,
        (select status from content.assets where id = ${oldScroll}::uuid) as status`.execute(db())
    ).rows[0];

  it('stops before it removes anything when an account cannot be cleared, and says which', async () => {
    const person = await recordingPerson(database);
    await db()
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', person.universeId)
      .execute();
    // The dry run says so before anyone runs it.
    const planned = await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' });
    expect(planned['accounts']).toEqual([expect.objectContaining({ accountId: person.accountId, clearable: false })]);
    const summary = await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' });
    expect(summary).toMatchObject({
      result: 'failed',
      code: 'clear_incomplete',
      accountsNotCleared: [{ accountId: person.accountId, outcome: 'refused' }],
    });
    // The Scroll is withdrawn (nobody opens it) but nothing was deleted.
    expect(await state()).toEqual({ assets: '2', revisions: '2', status: 'withdrawn' });
    await db()
      .updateTable('identity.universes')
      .set({ status: 'active' })
      .where('id', '=', person.universeId)
      .execute();
  });

  it('rolls the removal back whole when a row it does not know points at an old revision, and finishes once that row is gone', async () => {
    // A table of a later release that holds a foreign key to a revision: the cleanup must fail loudly and change nothing.
    await sql`create table public.ci_blocker (asset_id uuid not null, revision integer not null,
      foreign key (asset_id, revision) references content.asset_revisions (asset_id, revision) on delete restrict)`.execute(
      db(),
    );
    await sql`insert into public.ci_blocker values (${oldScroll}::uuid, 1)`.execute(db());
    const failed = await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' });
    expect(failed).toMatchObject({
      result: 'failed',
      phase: 'remove',
      code: '23503',
      constraint: 'ci_blocker_asset_id_revision_fkey',
    });
    expect(await state()).toEqual({ assets: '2', revisions: '2', status: 'withdrawn' });
    // What a failure prints holds no value of a row: only the SQLSTATE and the names of the constraint and the table.
    expect(JSON.stringify(failed)).not.toContain(oldScroll);
    await sql`drop table public.ci_blocker`.execute(db());
    expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' })).toMatchObject({ result: 'done' });
    expect(await state()).toEqual({ assets: '1', revisions: '1', status: null });
    expect((await db().selectFrom('content.assets').select('id').execute()).map((row) => row.id)).toEqual([v3Scroll]);
  });

  it('refuses a second cleanup while one runs', async () => {
    const holder = await db()
      .connection()
      .execute(async (connection) => {
        await sql`select pg_advisory_lock(hashtextextended('content.cleanup-old-scrolls', 0))`.execute(connection);
        const refused = await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' });
        await sql`select pg_advisory_unlock(hashtextextended('content.cleanup-old-scrolls', 0))`.execute(connection);
        return refused;
      });
    expect(holder).toMatchObject({ result: 'refused', code: 'cleanup_already_running' });
  });
});
