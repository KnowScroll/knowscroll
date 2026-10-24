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
import { feedbackPurgeProviders } from '@knowscroll/backend/modules/feedback/nest-providers';
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
import {
  befriend,
  friendCommand,
  seedContent,
  seedFriend,
  seedFriends,
  talkCases,
  type Friend,
} from '../support/talk.js';

const conversationVersion = 'direct-conversation.v1' as const;
const version = 'rooms.v1' as const;
const startOfDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

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

    it('stores a second report about the same message, person or Reel as a new report with its own receipt', async () => {
      const { a, b } = await seedFriends(database.db, world.friends);
      const { messageId } = await conversationWithMessage(a, b);
      const targets: AbuseReportRequest['target'][] = [
        { kind: 'message', messageId },
        { kind: 'person', personId: a.person.personId },
        { kind: 'asset', assetId: asset.assetId, assetRevision: 1 },
      ];
      for (const target of targets) {
        const first = await reports.reportAbuse(b.authority, abuse(target, { category: 'spam' }));
        if (first.kind !== 'received') throw new Error('expected received');
        // A month later: another reason, and a note that describes threats. The safety team must get it.
        world.clock.now = new Date(world.clock.now.getTime() + 30 * 86_400_000);
        const second = abuse(target, { category: 'harassment', note: 'Threats, described.' });
        const answer = await reports.reportAbuse(b.authority, second);
        if (answer.kind !== 'received') throw new Error('expected received');
        expect(answer.outcome).toMatchObject({ commandId: second.commandId, replayed: false });
        expect(answer.outcome.reportId).not.toBe(first.outcome.reportId);
        expect(answer.outcome.receivedAt).toBe(world.clock.now.toISOString());
        expect(
          await sql`select 1 from receipts.personal_commands where universe_id = ${b.universeId}::uuid and command_id = ${second.commandId}::uuid`
            .execute(database.db)
            .then((result) => result.rows),
        ).toHaveLength(1);
        // The same command ID still replays the second receipt, not a third report.
        expect(await reports.reportAbuse(b.authority, second)).toMatchObject({
          kind: 'received',
          outcome: { reportId: answer.outcome.reportId, replayed: true },
        });
      }
      const stored = (await rowsBy(b.accountId)).map((row) => `${row.target_kind}/${row.category}/${row.note ?? '-'}`);
      expect(stored.sort()).toEqual(
        [
          'message/spam/-',
          'message/harassment/Threats, described.',
          'person/spam/-',
          'person/harassment/Threats, described.',
          'asset/spam/-',
          'asset/harassment/Threats, described.',
        ].sort(),
      );
    });
  });

  describe('the bound', () => {
    it('allows 25 reports in 24 hours, refuses the next and writes nothing for it, then lets a day pass', async () => {
      const person = await seedFriend(database.db, world.friends);
      const target = await seedFriend(database.db, world.friends);
      // Reports about one person each count: a person who is being harassed may need to say so again.
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

    it('is shown to a room’s moderators as the reported message, why and how often, and to no one else in the room', async () => {
      const { roomId, slug } = await seedRoom(world);
      const [author, reporterOne, reporterTwo, moderator] = await Promise.all([
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
      ]);
      const outsider = await seedFriend(database.db, world.friends);
      for (const person of [author, reporterOne, reporterTwo, moderator]) unwrap(await joinRoom(world, person, roomId));
      await makeModerator(world, slug, moderator);
      const discussionId = await startTopic(world, author, roomId, 'Where should it run?');
      unwrap(await say(world, author, roomId, discussionId, 'words that get reported'));
      unwrap(await say(world, moderator, roomId, discussionId, 'the moderator’s own words'));
      const view = await readDiscussion(world, reporterOne, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const [authored, moderated] = view.messages.map((message) => message.messageId);
      world.clock.now = new Date(world.clock.now.getTime() + 1_000);
      await reports.reportAbuse(
        reporterOne.authority,
        abuse({ kind: 'room_message', messageId: authored! }, { note: 'CI-PRIVATE-MODERATOR-VIEW-NOTE' }),
      );
      await reports.reportAbuse(
        reporterTwo.authority,
        abuse({ kind: 'room_message', messageId: authored! }, { category: 'spam' }),
      );
      // A report about the moderator's own words is not for the moderator to read.
      await reports.reportAbuse(reporterOne.authority, abuse({ kind: 'room_message', messageId: moderated! }));

      const read = (person: Friend) => world.rooms.reports(person.authority, { version, readId: randomUUID(), roomId });
      const shown = unwrap(await read(moderator));
      expect(shown.reports).toEqual([
        {
          messageId: authored,
          discussionId,
          discussionTitle: 'Where should it run?',
          sequence: 1,
          count: 2,
          categories: ['harassment', 'spam'],
          // The day of the newest report, never the time of day.
          lastReportedAt: startOfDay(world.clock.now).toISOString(),
        },
      ]);
      const text = JSON.stringify(shown);
      for (const hidden of [
        'CI-PRIVATE-MODERATOR-VIEW-NOTE',
        reporterOne.accountId,
        reporterTwo.accountId,
        reporterOne.person.personId,
        author.accountId,
      ])
        expect(text).not.toContain(hidden);
      // A member who is not a moderator, and a stranger, get the same refusal as a room that is not there.
      for (const person of [author, reporterOne, outsider])
        expect(await read(person)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(
        await world.rooms.reports(moderator.authority, { version, readId: randomUUID(), roomId: randomUUID() }),
      ).toEqual({ kind: 'refused', code: 'unavailable' });
    });

    it('counts different people for a room’s moderators, so one person reporting twice cannot raise the number', async () => {
      const { roomId, slug } = await seedRoom(world);
      const [author, reporterOne, reporterTwo, moderator] = await Promise.all([
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
        seedFriend(database.db, world.friends),
      ]);
      for (const person of [author, reporterOne, reporterTwo, moderator]) unwrap(await joinRoom(world, person, roomId));
      await makeModerator(world, slug, moderator);
      const discussionId = await startTopic(world, author, roomId);
      unwrap(await say(world, author, roomId, discussionId, 'words that get reported'));
      const view = await readDiscussion(world, reporterOne, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const messageId = view.messages[0]!.messageId;
      const target = { kind: 'room_message', messageId } as const;
      const countSeen = async () => {
        const shown = unwrap(await world.rooms.reports(moderator.authority, { version, readId: randomUUID(), roomId }));
        return shown.reports.map((report) => report.count);
      };

      // One person reporting the message twice leaves two reports, and the moderators still see one person.
      const first = await reports.reportAbuse(reporterOne.authority, abuse(target));
      const again = await reports.reportAbuse(reporterOne.authority, abuse(target, { category: 'spam' }));
      if (first.kind !== 'received' || again.kind !== 'received') throw new Error('expected received');
      expect(again.outcome.reportId).not.toBe(first.outcome.reportId);
      expect(await rowsBy(reporterOne.accountId)).toHaveLength(2);
      expect(await countSeen()).toEqual([1]);
      await reports.reportAbuse(reporterTwo.authority, abuse(target));
      expect(await countSeen()).toEqual([2]);
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
      await sql`insert into feedback.reports (report_id, reporter_account_id, kind, category, target_kind, asset_id, asset_revision, created_at)
        values (${randomUUID()}::uuid, ${person.accountId}::uuid, 'content_error', 'wrong', 'asset', ${asset.assetId}::uuid, 1, now())`.execute(
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

  describe('erasure and retention', () => {
    type Recorded = Awaited<ReturnType<typeof recordingPerson>>;
    /** A person created by the real sign-in (deletion and Clear need the real lifecycle), with a claimed profile. */
    const named = async (): Promise<Friend & Recorded> => {
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
    };
    const erase = async (person: Recorded) => {
      const receiptId = randomUUID();
      const deleting = deleteAccountFor(database.db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: 5_000,
      });
      expect((await deleting.request(person.authority, { receiptId })).kind).toBe('accepted');
      expect(await deleting.process({ v: 1, deletionId: receiptId })).toBe('completed');
    };
    const involving = async (accountId: string) =>
      Number(
        (
          await sql<{ n: string }>`select count(*)::text as n from feedback.reports
            where reporter_account_id = ${accountId}::uuid or reported_account_id = ${accountId}::uuid`.execute(
            database.db,
          )
        ).rows[0]?.n,
      );
    const all = (reporterId: string) =>
      database.db
        .selectFrom('feedback.reports')
        .selectAll()
        .where('reporter_account_id', '=', reporterId)
        .orderBy('created_at')
        .orderBy('report_id')
        .execute();
    const exportOf = async (person: Friend) => {
      const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (exported.kind !== 'entered') throw new Error('export refused');
      return exported.value.sections['feedback'] as { reports: { items: Record<string, unknown>[] } };
    };
    const purge = () => {
      const [provider] = feedbackPurgeProviders({ database: Symbol('db'), logEvent: Symbol('log') });
      return provider!.useFactory(database.db, () => undefined)();
    };

    /** A person and everything said about them: a conversation message, a room message and the person, by several people. */
    async function reportedEverywhere() {
      const author = await named();
      const reporter = await named();
      const bystander = await seedFriend(database.db, world.friends);
      await befriend(world.friends, author, reporter);
      const { messageId } = await conversationWithMessage(author, reporter, 'words that will be tombstoned');
      const { roomId } = await seedRoom(world);
      for (const person of [author, reporter]) unwrap(await joinRoom(world, person, roomId));
      const discussionId = await startTopic(world, author, roomId);
      unwrap(await say(world, author, roomId, discussionId, 'room words that will be tombstoned'));
      const view = await readDiscussion(world, reporter, roomId, discussionId);
      if (view.status !== 'ready') throw new Error('expected ready');
      const roomMessageId = view.messages[0]!.messageId;
      for (const target of [
        { kind: 'message', messageId },
        { kind: 'room_message', messageId: roomMessageId },
        { kind: 'person', personId: author.person.personId },
      ] as const)
        expect(
          await reports.reportAbuse(reporter.authority, abuse(target, { note: 'CI-RETAINED-NOTE' })),
        ).toMatchObject({ kind: 'received' });
      expect(
        await reports.reportAbuse(bystander.authority, abuse({ kind: 'person', personId: author.person.personId })),
      ).toMatchObject({ kind: 'received' });
      // A content error names an asset, never a person.
      expect(await reports.reportContentError(reporter.authority, contentError())).toMatchObject({
        kind: 'received',
      });
      return { author, reporter, bystander, messageId, roomMessageId };
    }

    it('a Clear keeps what a person sent', async () => {
      const sender = await named();
      const about = await named();
      await reports.reportAbuse(sender.authority, abuse({ kind: 'person', personId: about.person.personId }));
      await reports.reportContentError(sender.authority, contentError());
      expect(await involving(sender.accountId)).toBe(2);
      // A Clear forgets exploration, not what a person told the safety team.
      await clearRecordingPerson(database, boss, sender);
      expect(await involving(sender.accountId)).toBe(2);
    });

    it('deleting the reported person keeps abuse reports about them for 90 days, without them in it', async () => {
      const { author, reporter, bystander, messageId, roomMessageId } = await reportedEverywhere();
      expect(await involving(author.accountId)).toBe(4);
      const authorId = author.accountId;

      await erase(author);

      // Nothing points at the deleted account any more.
      expect(await involving(authorId)).toBe(0);
      const kept = await all(reporter.accountId);
      expect(kept.map((row) => [row.kind, row.target_kind])).toEqual([
        ['abuse', 'message'],
        ['abuse', 'room_message'],
        ['abuse', 'deleted_account'],
        ['content_error', 'asset'],
      ]);
      const [aboutMessage, aboutRoomMessage, aboutPerson, contentError_] = kept;
      // The message id stays, because the message it names is now a tombstone: no author, no words.
      expect(aboutMessage).toMatchObject({ message_id: messageId, reported_account_id: null });
      expect(aboutRoomMessage).toMatchObject({ message_id: roomMessageId, reported_account_id: null });
      expect(
        (
          await sql<{ author_account_id: string | null; body_text: string | null }>`
            select author_account_id, body_text from social.messages where message_id = ${messageId}::uuid`.execute(
            database.db,
          )
        ).rows,
      ).toEqual([{ author_account_id: null, body_text: null }]);
      expect(
        (
          await sql<{ author_account_id: string | null; body_text: string | null }>`
            select author_account_id, body_text from rooms.messages where message_id = ${roomMessageId}::uuid`.execute(
            database.db,
          )
        ).rows,
      ).toEqual([{ author_account_id: null, body_text: null }]);
      // A person target no longer names a person at all.
      expect(aboutPerson).toMatchObject({
        message_id: null,
        asset_id: null,
        room_id: null,
        reported_account_id: null,
      });
      expect((await all(bystander.accountId)).map((row) => row.target_kind)).toEqual(['deleted_account']);
      // The reports about the person run for 90 days from the deletion; a content error is not about them.
      const ninetyDays = 90 * 86_400_000;
      for (const row of [aboutMessage, aboutRoomMessage, aboutPerson])
        expect(Math.abs(row!.retain_until!.getTime() - (Date.now() + ninetyDays))).toBeLessThan(120_000);
      expect(contentError_!.retain_until).toBeNull();
      expect(JSON.stringify(kept)).not.toContain(authorId);
      expect(JSON.stringify(kept)).not.toContain(author.person.personId);

      // The reporter's export says what became of them, in words and without naming anyone.
      const section = await exportOf(reporter);
      const afterwards = section.reports.items.filter((item) => item['about'] !== 'a Reel or Scroll');
      expect(afterwards.map((item) => item['about'])).toEqual([
        'a message',
        'a message in a room',
        'a person who has since deleted their account',
      ]);
      expect(afterwards.every((item) => typeof item['keptUntil'] === 'string')).toBe(true);
      expect(JSON.stringify(section)).not.toContain(authorId);

      // Operators read them as reports about a deleted account.
      const panels = await readOperatorPanelsFor(database.db)();
      if (panels.safety.reports.status !== 'available') throw new Error('expected the reports panel');
      expect(panels.safety.reports.data.recent).toContainEqual(
        expect.objectContaining({ kind: 'abuse', targetKind: 'deleted_account', hasNote: true }),
      );
    });

    it('purges those reports once their 90 days are over, and only those', async () => {
      const { author, reporter, bystander } = await reportedEverywhere();
      await erase(author);
      const stillHeld = async () => (await all(reporter.accountId)).length + (await all(bystander.accountId)).length;
      expect(await stillHeld()).toBe(5);

      // Not yet due.
      expect(await purge()).toEqual({ removed: 0 });
      expect(await stillHeld()).toBe(5);

      // The clock moves past retain_until (a day short of 90 has passed, then two more).
      await sql`update feedback.reports set retain_until = retain_until - interval '89 days'
        where retain_until is not null`.execute(database.db);
      expect(await purge()).toEqual({ removed: 0 });
      await sql`update feedback.reports set retain_until = retain_until - interval '2 days'
        where retain_until is not null`.execute(database.db);
      const due = Number(
        (
          await sql<{ n: string }>`select count(*)::text as n from feedback.reports where retain_until < now()`.execute(
            database.db,
          )
        ).rows[0]?.n,
      );
      expect(due).toBeGreaterThanOrEqual(4);
      // The reports about the deleted person go. Everything else, including every other report, stays.
      expect(await purge()).toEqual({ removed: due });
      expect((await all(reporter.accountId)).map((row) => row.kind)).toEqual(['content_error']);
      expect(await all(bystander.accountId)).toEqual([]);
      expect(await purge()).toEqual({ removed: 0 });
    });

    it('deleting the reporter removes their own reports, including those about a person who left', async () => {
      const { author, reporter, bystander } = await reportedEverywhere();
      await erase(author);
      expect((await all(reporter.accountId)).length).toBe(4);

      await erase(reporter);

      expect(await involving(reporter.accountId)).toBe(0);
      expect(await all(reporter.accountId)).toEqual([]);
      // What other people reported stays with them.
      expect((await all(bystander.accountId)).map((row) => row.target_kind)).toEqual(['deleted_account']);
    });
  });
});
