/**
 * Reports to the safety team (P03, D-055) over real PostgreSQL: a content error, abuse about a message,
 * a room message, a person or a Reel or Scroll; idempotent receipts; the daily bound; access to the
 * target; and that nobody it is about ever sees it. Erasure: Clear keeps reports, account deletion
 * removes the ones a person sent and the ones about them. CI fixture accounts; no provider.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { readOperatorPanelsFor } from '@knowscroll/backend/modules/operator/nest-providers';
import type { AbuseReportRequest, ContentErrorReportRequest } from '@knowscroll/contracts';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { reportCases } from '../support/feedback.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import {
  joinRoom,
  makeModerator,
  readDiscussion,
  roomWorld,
  say,
  seedRoom,
  startTopic,
  unwrap,
  type RoomWorld,
} from '../support/rooms.js';
import { friendCommand, seedContent, seedFriend, seedFriends, talkCases, type Friend } from '../support/talk.js';

const conversationVersion = 'direct-conversation.v1' as const;

describe('reports to the safety team (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let world: RoomWorld;
  let talk: ReturnType<typeof talkCases>;
  let reports: ReturnType<typeof reportCases>;
  let boss: ReturnType<typeof createBoss>;
  let asset: { assetId: string; revisions: number };

  beforeAll(async () => {
    database = await createTestDatabase<Database>('feedback_reports');
    world = await roomWorld(database);
    talk = talkCases(database.db, world.clock);
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    reports = reportCases(database.db, () => world.clock.now);
    asset = await seedContent(database.db, { kind: 'reel', title: 'Attention, explained', revisions: 2 });
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await world.close();
    await database.drop();
  });

  const contentError = (overrides: Partial<ContentErrorReportRequest> = {}): ContentErrorReportRequest => ({
    commandId: randomUUID(),
    target: { assetId: asset.assetId, assetRevision: 2 },
    category: 'wrong',
    ...overrides,
  });
  const abuse = (
    target: AbuseReportRequest['target'],
    overrides: Partial<AbuseReportRequest> = {},
  ): AbuseReportRequest => ({
    commandId: randomUUID(),
    target,
    category: 'harassment',
    ...overrides,
  });
  const rowsBy = (accountId: string) =>
    database.db.selectFrom('feedback.reports').selectAll().where('reporter_account_id', '=', accountId).execute();

  /** A conversation between two friends with one message from `a`; returns the message's ID. */
  async function conversationWithMessage(a: Friend, b: Friend, words = 'a message that gets reported') {
    const startFor = async (actor: Friend, peer: Friend) => {
      const pair = await world.friends.readPair(actor.authority, {
        version: 'sharing.v1',
        peerPersonId: peer.person.personId,
      });
      if (pair.kind !== 'ok' || pair.value.status !== 'available') throw new Error('CI pair');
      return unwrap(
        await talk.talk.conversations.start(actor.authority, {
          version: conversationVersion,
          commandId: randomUUID(),
          peerPersonId: peer.person.personId,
          expectedPairRevision: pair.value.pair.pairRevision,
        }),
      ).conversation;
    };
    const aRef = await startFor(a, b);
    await startFor(b, a);
    const sent = unwrap(
      await talk.talk.conversations.send(a.authority, {
        version: conversationVersion,
        commandId: randomUUID(),
        conversation: aRef,
        body: { kind: 'text', text: words },
      }),
    );
    return { conversation: aRef, messageId: sent.messageId, words };
  }

  describe('a content error', () => {
    it('is stored with the exact revision, the place in the Reel and the person’s own note, and answers a receipt', async () => {
      const person = await seedFriend(database.db, world.friends);
      const command = contentError({
        category: 'misleading',
        anchor: { kind: 'reel', positionMs: 31_000 },
        note: 'It could also mean the street here.',
      });
      const result = await reports.reportContentError(person.authority, command);
      if (result.kind !== 'received') throw new Error('expected received');
      expect(result.outcome).toMatchObject({ commandId: command.commandId, replayed: false });
      expect(await rowsBy(person.accountId)).toMatchObject([
        {
          report_id: result.outcome.reportId,
          kind: 'content_error',
          category: 'misleading',
          target_kind: 'asset',
          asset_id: asset.assetId,
          asset_revision: 2,
          anchor: { kind: 'reel', positionMs: 31_000 },
          note: 'It could also mean the street here.',
          message_id: null,
          reported_account_id: null,
        },
      ]);
    });

    it('answers an identical retry with the first receipt, once', async () => {
      const person = await seedFriend(database.db, world.friends);
      const command = contentError();
      const first = await reports.reportContentError(person.authority, command);
      const retry = await reports.reportContentError(person.authority, command);
      if (first.kind !== 'received' || retry.kind !== 'received') throw new Error('expected received');
      expect(retry.outcome).toEqual({ ...first.outcome, replayed: true });
      expect(await rowsBy(person.accountId)).toHaveLength(1);
      expect(await reports.reportContentError(person.authority, { ...command, category: 'other' })).toEqual({
        kind: 'refused',
        reason: 'command_key_reused',
      });
    });

    it('refuses an asset that does not exist or a revision it never had, and writes nothing', async () => {
      const person = await seedFriend(database.db, world.friends);
      for (const target of [
        { assetId: randomUUID(), assetRevision: 1 },
        { assetId: asset.assetId, assetRevision: 3 },
      ])
        expect(await reports.reportContentError(person.authority, contentError({ target }))).toEqual({
          kind: 'refused',
          reason: 'target_unavailable',
        });
      expect(await rowsBy(person.accountId)).toEqual([]);
    });
  });

  describe('abuse', () => {
    it('about a message in a conversation: the sender is recorded, the words are not', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const { messageId, words } = await conversationWithMessage(a, b);
      const result = await reports.reportAbuse(b.authority, abuse({ kind: 'message', messageId }));
      expect(result).toMatchObject({ kind: 'received' });
      const [row] = await rowsBy(b.accountId);
      expect(row).toMatchObject({
        kind: 'abuse',
        category: 'harassment',
        target_kind: 'message',
        message_id: messageId,
        reported_account_id: a.accountId,
      });
      expect(JSON.stringify(row)).not.toContain(words);
    });

    it('refuses a message the reporter wrote, one they have no part in and one that does not exist: one answer', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const stranger = await seedFriend(database.db, world.friends);
      const { messageId } = await conversationWithMessage(a, b);
      for (const [reporter, target] of [
        [a, messageId],
        [stranger, messageId],
        [b, randomUUID()],
      ] as const)
        expect(await reports.reportAbuse(reporter.authority, abuse({ kind: 'message', messageId: target }))).toEqual({
          kind: 'refused',
          reason: 'target_unavailable',
        });
      expect(await rowsBy(stranger.accountId)).toEqual([]);
    });

    it('keeps working after a block, so a person can report what they were sent, but not as an invited guest', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const { conversation, messageId } = await conversationWithMessage(a, b);
      const blocked = await friendCommand(world.friends, b, a, 'block');
      expect(blocked.kind).toBe('ok');
      expect(await reports.reportAbuse(b.authority, abuse({ kind: 'message', messageId }))).toMatchObject({
        kind: 'received',
      });
      await sql`update social.conversation_members set pending = true
        where conversation_id = ${conversation.conversationId}::uuid and account_id = ${b.accountId}::uuid`.execute(
        database.db,
      );
      expect(await reports.reportAbuse(b.authority, abuse({ kind: 'message', messageId }))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
    });

    it('about a room message: the room is kept; a stranger to the room or a removed message is refused', async () => {
      const { roomId, slug } = await seedRoom(world);
      const [speaker, reader] = [
        await seedFriend(database.db, world.friends),
        await seedFriend(database.db, world.friends),
      ];
      const outsider = await seedFriend(database.db, world.friends);
      const moderator = await seedFriend(database.db, world.friends);
      for (const person of [speaker, reader, moderator]) unwrap(await joinRoom(world, person, roomId));
      await makeModerator(world, slug, moderator);
      const discussionId = await startTopic(world, speaker, roomId);
      unwrap(await say(world, speaker, roomId, discussionId, 'words for the room'));
      const view = await readDiscussion(world, reader, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const messageId = view.messages[0]!.messageId;

      expect(await reports.reportAbuse(outsider.authority, abuse({ kind: 'room_message', messageId }))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
      expect(await reports.reportAbuse(speaker.authority, abuse({ kind: 'room_message', messageId }))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
      expect(await reports.reportAbuse(reader.authority, abuse({ kind: 'room_message', messageId }))).toMatchObject({
        kind: 'received',
      });
      expect((await rowsBy(reader.accountId))[0]).toMatchObject({
        target_kind: 'room_message',
        message_id: messageId,
        room_id: roomId,
        reported_account_id: speaker.accountId,
      });

      unwrap(
        await world.rooms.hideMessage(moderator.authority, {
          version: 'rooms.v1',
          commandId: randomUUID(),
          roomId,
          discussionId,
          messageId,
          hidden: true,
        }),
      );
      expect(
        await reports.reportAbuse(reader.authority, abuse({ kind: 'room_message', messageId }, { category: 'spam' })),
      ).toEqual({ kind: 'refused', reason: 'target_unavailable' });
    });

    it('about a person, by the public ID the client holds; not oneself, not an unknown ID', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      expect(
        await reports.reportAbuse(a.authority, abuse({ kind: 'person', personId: b.person.personId })),
      ).toMatchObject({
        kind: 'received',
      });
      expect((await rowsBy(a.accountId))[0]).toMatchObject({ target_kind: 'person', reported_account_id: b.accountId });
      for (const personId of [a.person.personId, randomUUID()])
        expect(await reports.reportAbuse(a.authority, abuse({ kind: 'person', personId }))).toEqual({
          kind: 'refused',
          reason: 'target_unavailable',
        });
    });

    it('about a Reel or Scroll, like a content error', async () => {
      const person = await seedFriend(database.db, world.friends);
      expect(
        await reports.reportAbuse(person.authority, abuse({ kind: 'asset', assetId: asset.assetId, assetRevision: 1 })),
      ).toMatchObject({ kind: 'received' });
      expect((await rowsBy(person.accountId))[0]).toMatchObject({
        kind: 'abuse',
        target_kind: 'asset',
        asset_revision: 1,
      });
    });
  });

  describe('the bound', () => {
    it('allows 25 reports in 24 hours, refuses the next and writes nothing for it, then lets a day pass', async () => {
      const person = await seedFriend(database.db, world.friends);
      const target = await seedFriend(database.db, world.friends);
      for (let sent = 0; sent < 25; sent++)
        expect(
          await reports.reportAbuse(person.authority, abuse({ kind: 'person', personId: target.person.personId })),
        ).toMatchObject({ kind: 'received' });
      const refused = abuse({ kind: 'person', personId: target.person.personId });
      expect(await reports.reportAbuse(person.authority, refused)).toEqual({
        kind: 'refused',
        reason: 'too_many_reports',
      });
      expect(await rowsBy(person.accountId)).toHaveLength(25);
      expect(
        await sql`select 1 from receipts.personal_commands where universe_id = ${person.universeId}::uuid and command_id = ${refused.commandId}::uuid`
          .execute(database.db)
          .then((result) => result.rows),
      ).toEqual([]);
      world.clock.now = new Date(world.clock.now.getTime() + 25 * 3_600_000);
      expect(await reports.reportAbuse(person.authority, refused)).toMatchObject({ kind: 'received' });
    });
  });

  describe('who can see a report', () => {
    it('is never the person it is about: their conversation, their export and their account read as before', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const { conversation, messageId } = await conversationWithMessage(a, b);
      const readId = randomUUID();
      const readFor = async () =>
        unwrap(
          await talk.talk.conversations.read(a.authority, {
            version: conversationVersion,
            readId,
            conversation,
            limit: 50,
          }),
        );
      const exportFor = async (person: Friend) => {
        const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
          exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
        );
        if (exported.kind !== 'entered') throw new Error('export refused');
        return exported.value.sections;
      };
      const before = { snapshot: await readFor(), sections: await exportFor(a) };
      await reports.reportAbuse(b.authority, abuse({ kind: 'message', messageId }, { note: 'CI-PRIVATE-REPORT-NOTE' }));
      await reports.reportAbuse(b.authority, abuse({ kind: 'person', personId: a.person.personId }));
      const after = { snapshot: await readFor(), sections: await exportFor(a) };
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toContain('CI-PRIVATE-REPORT-NOTE');
      expect(Object.keys(after.sections)).not.toContain('feedback');
    });

    it('is shown to its sender in their export, in words, without the person or the message reported', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const { messageId } = await conversationWithMessage(a, b);
      await reports.reportAbuse(b.authority, abuse({ kind: 'message', messageId }, { note: 'He keeps doing this.' }));
      world.clock.now = new Date(world.clock.now.getTime() + 1_000);
      await reports.reportContentError(b.authority, contentError({ note: 'Check the second claim.' }));
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(b.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: b.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      const section = exported.value.sections['feedback'] as { reports: { items: Record<string, unknown>[] } };
      expect(section.reports.items.map((item) => [item['kind'], item['about'], item['note']])).toEqual([
        ['content error', 'a Reel or Scroll', 'Check the second claim.'],
        ['abuse report', 'a message', 'He keeps doing this.'],
      ]);
      const text = JSON.stringify(section);
      for (const hidden of [a.accountId, a.person.personId, a.person.handle, messageId, asset.assetId])
        expect(text).not.toContain(hidden);
      expect(section.reports.items[0]).toMatchObject({ title: 'Attention, explained (revision 2)' });
    });

    it('is read by operators as ids, a category and whether a note exists, never the note', async () => {
      const person = await seedFriend(database.db, world.friends);
      const target = await seedFriend(database.db, world.friends);
      world.clock.now = new Date(world.clock.now.getTime() + 1_000);
      await reports.reportAbuse(
        person.authority,
        abuse({ kind: 'person', personId: target.person.personId }, { note: 'CI-PRIVATE-OPERATOR-PANEL-NOTE' }),
      );
      // The test clock is fixed in the past; one row written now proves the 24-hour count.
      await sql`insert into feedback.reports (report_id, reporter_account_id, kind, category, target_kind, reported_account_id, created_at)
        values (${randomUUID()}::uuid, ${person.accountId}::uuid, 'abuse', 'spam', 'person', ${target.accountId}::uuid, now())`.execute(
        database.db,
      );
      const panels = await readOperatorPanelsFor(database.db)();
      if (panels.safety.reports.status !== 'available') throw new Error('expected the reports panel');
      expect(panels.safety.reports.data.last24Hours).toBeGreaterThanOrEqual(1);
      expect(panels.safety.reports.data.recent).toContainEqual(
        expect.objectContaining({ kind: 'abuse', category: 'harassment', targetKind: 'person', hasNote: true }),
      );
      expect(JSON.stringify(panels)).not.toContain('CI-PRIVATE-OPERATOR-PANEL-NOTE');
      expect(JSON.stringify(panels.safety)).not.toContain(person.accountId);
      expect(JSON.stringify(panels.safety)).not.toContain(target.accountId);
    });
  });

  describe('erasure', () => {
    it('survives a Clear of the sender, and account deletion removes what a person sent and what was sent about them', async () => {
      const sender = await recordingPerson(database);
      const about = await recordingPerson(database);
      const named = async (person: Awaited<ReturnType<typeof recordingPerson>>): Promise<Friend> => {
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
      };
      const [senderFriend, aboutFriend] = [await named(sender), await named(about)];
      const bystander = await seedFriend(database.db, world.friends);
      await reports.reportAbuse(
        senderFriend.authority,
        abuse({ kind: 'person', personId: aboutFriend.person.personId }),
      );
      await reports.reportContentError(senderFriend.authority, contentError());
      await reports.reportAbuse(bystander.authority, abuse({ kind: 'person', personId: aboutFriend.person.personId }));
      const involving = async (accountId: string) =>
        Number(
          (
            await sql<{ n: string }>`select count(*)::text as n from feedback.reports
              where reporter_account_id = ${accountId}::uuid or reported_account_id = ${accountId}::uuid`.execute(
              database.db,
            )
          ).rows[0]?.n,
        );
      expect([await involving(sender.accountId), await involving(about.accountId)]).toEqual([2, 2]);

      // A Clear forgets exploration, not what a person told the safety team.
      await clearRecordingPerson(database, boss, sender);
      expect(await involving(sender.accountId)).toBe(2);

      const erase = async (person: typeof sender) => {
        const receiptId = randomUUID();
        const deleting = deleteAccountFor(database.db, boss, {
          eraseAccountData: eraseCurrentAccount,
          lockTimeoutMs: 5_000,
        });
        expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
        expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
      };
      // The person reported goes first: every report about them goes, the others' other reports stay.
      await erase(about);
      expect(await involving(about.accountId)).toBe(0);
      expect(await involving(sender.accountId)).toBe(1);
      expect(await rowsBy(bystander.accountId)).toEqual([]);
      await erase({ ...sender, authority: { ...sender.authority, privacyEpoch: 2 } });
      expect(await involving(sender.accountId)).toBe(0);
    });
  });
});
