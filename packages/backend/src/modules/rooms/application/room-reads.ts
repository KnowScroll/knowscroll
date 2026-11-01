import {
  AI_INHABITANT_LABELS,
  DISCUSSIONS_LISTED_MAX,
  ROOM_FACES_MAX,
  ROOM_PRESENCE_LEASE_MS,
  ReadRoomListSchema,
  ReadRoomReportsSchema,
  ReadRoomSchema,
  ReadRoomTopicsSchema,
  RoomListSchema,
  RoomReportsSchema,
  RoomTopicsSchema,
  RoomViewSchema,
  type AiAuthor,
  type PublicPersonRef,
  type RoomAway,
  type RoomDiscussionSummary,
  type RoomHere,
  type RoomLaunchStrip,
  type RoomWatchStrip,
  type RoomQuestions,
  type RoomReplayStrip,
  type RoomTodayStrip,
  type RoomWelcome,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { CONCEPTS } from '../../content/public.js';
import { CARD_LIFE_MS, welcomeText } from '../domain/away.js';
import { nameOf } from '../domain/cast.js';
import { isModerator, joinDecision, roomAcceptsPosts } from '../domain/membership.js';
import { COUNT_FROM, hereOf } from '../domain/presence.js';
import { reportedOnDay } from '../domain/reports.js';
import { orderTopics } from '../domain/topics.js';
import { titlesFor } from './discussion-titles.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import { launchStrip } from './launch-view.js';
import { watchStrip } from './watch-view.js';
import { questionsView } from './questions.js';
import { replayStrip } from './replay.js';
import { skyOfRoom } from './sky.js';
import { todayStrip } from './today.js';
import {
  earlierPlaceOf,
  ok,
  refuse,
  roomEnvelope,
  type ContentCard,
  type DiscussionFigures,
  type DiscussionRow,
  type MemberRow,
  type Result,
  type RoomPorts,
  type RoomRow,
} from './ports.js';
import { inhabitantsOf, limitsOf, roomSummary, youOf } from './view.js';

/** The most friends of the caller read to learn whether a room's rule lets them in. */
const FRIEND_LOOKUP_LIMIT = 1000;
/** The most discussions a room view lists. */
export const DISCUSSIONS_PER_ROOM_VIEW = DISCUSSIONS_LISTED_MAX;
/** The most topics one list read ranks before it keeps the first `DISCUSSIONS_LISTED_MAX` of them. */
const TOPICS_RANKED = 200;
/** The most fresh leases one read looks at; a room with more people here than this counts this many. */
const PRESENCE_READ_LIMIT = 200;
/** The most reported messages a moderator's list shows. */
const REPORTS_PER_ROOM_VIEW = 50;

const keyOf = (ref: { assetId: string; assetRevision: number }) => `${ref.assetId}:${String(ref.assetRevision)}`;

/**
 * The discussion rows of a room as the list shows them: the root's card, the starter's public profile and the figures a
 * row or a topic card reads (how many messages it shows and who spoke last). Who spoke last is left out when the
 * reader has blocked them, as in every other part of a room (D-051). A title made from a message is shown only while the
 * reader may read that message (D-168).
 */
async function discussionSummaries(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom,
  rows: readonly DiscussionRow[],
  figures: ReadonlyMap<string, DiscussionFigures>,
): Promise<RoomDiscussionSummary[]> {
  const roots = rows.flatMap((row) => (row.root === null ? [] : [row.root]));
  const cards: readonly ContentCard[] = roots.length === 0 ? [] : await p.readContent(scope, roots);
  const cardOf = new Map(cards.map((card) => [keyOf(card.target), card]));
  const lastSpoke = rows.flatMap((row) => {
    const last = figures.get(row.discussionId)?.lastReplyBy;
    return last !== undefined && 'accountId' in last ? [last.accountId] : [];
  });
  const accountIds = [
    ...new Set([
      ...rows.flatMap((row) => (row.startedByAccountId === null ? [] : [row.startedByAccountId])),
      ...lastSpoke,
    ]),
  ];
  const people: ReadonlyMap<string, PublicPersonRef> =
    accountIds.length === 0 ? new Map() : await p.people.byAccounts(scope, accountIds);
  const blocked =
    lastSpoke.length === 0 ? new Set<string>() : await p.blocked(scope, entered.owner.accountId, lastSpoke);
  const { cast } = entered.standing.room;
  const titles = await titlesFor(p, scope, entered.lock, entered.owner.accountId, rows);
  return rows.map((row) => {
    const starter = row.startedByAccountId === null ? undefined : people.get(row.startedByAccountId);
    const figure = figures.get(row.discussionId);
    const last = figure?.lastReplyBy;
    const lastReplyBy =
      last === undefined
        ? undefined
        : 'inhabitant' in last
          ? { name: nameOf(cast, last.inhabitant), ai: true }
          : blocked.has(last.accountId) || !people.has(last.accountId)
            ? undefined
            : { name: people.get(last.accountId)!.displayName, ai: false };
    return {
      discussionId: row.discussionId,
      kind: row.kind,
      title: titles.get(row.discussionId)!,
      ...(row.tag === null ? {} : { tag: row.tag }),
      ...(row.root === null
        ? {}
        : { root: cardOf.get(keyOf(row.root)) ?? { status: 'unavailable' as const, target: row.root } }),
      ...(starter === undefined ? {} : { startedBy: starter }),
      pinned: row.pinned,
      lastActivityAt: row.lastActivityAt.toISOString(),
      replyCount: figure?.replyCount ?? 0,
      ...(lastReplyBy === undefined ? {} : { lastReplyBy }),
      // A question stays open for people whatever a resident said: `answered` counts persons only (D-242).
      // A question whose asker's account is gone waits for no one, as `QuestionStore.waiting` counts it.
      ...(row.tag === 'question' && row.startedByAccountId !== null && figure?.answered === false
        ? { waiting: true as const }
        : {}),
    };
  });
}

/**
 * Who has the room open, for the caller (D-069). Fresh leases of current members, plus the caller (reading the
 * room is having it open). A person the caller has blocked, and a person with no public profile to show, are left
 * out of the faces and of the count; the number is said only from three people. The AI cast has no lease.
 */
async function hereFor(p: RoomPorts, scope: PersonalScopeTx, entered: EnteredRoom): Promise<RoomHere> {
  const { lock, owner } = entered;
  const since = new Date(p.now().getTime() - ROOM_PRESENCE_LEASE_MS);
  const present = await p.presence.fresh(lock, since, PRESENCE_READ_LIMIT);
  const candidates = [...new Set([...present, owner.accountId])];
  const people = await p.people.byAccounts(scope, candidates);
  const masked = new Set([
    ...(await p.blocked(scope, owner.accountId, present)),
    ...present.filter((account) => !people.has(account)),
  ]);
  const here = hereOf({ present, viewer: owner.accountId, blocked: masked, maxFaces: ROOM_FACES_MAX });
  const faces = here.faces.flatMap((account) => {
    const person = people.get(account);
    return person === undefined ? [] : [{ person, you: account === owner.accountId }];
  });
  const count = here.count === undefined || faces.length < COUNT_FROM ? undefined : Math.max(here.count, faces.length);
  return { faces, ...(count === undefined ? {} : { count }) };
}

const residentAuthor = (room: RoomRow, inhabitant: 'explainer' | 'skeptic'): AiAuthor => ({
  kind: 'ai',
  inhabitant,
  name: nameOf(room.cast, inhabitant),
  label: AI_INHABITANT_LABELS[inhabitant],
});

/**
 * The welcome a member reads until they have read the AI notice: the Explainer's own, from a template filled with the
 * room's name and the meaning of its topic. No model is asked, so it costs no call (D-168).
 */
function welcomeFor(room: RoomRow): RoomWelcome {
  const meaning = CONCEPTS.find((concept) => concept.id === room.topic.id)?.meaning;
  return {
    resident: residentAuthor(room, 'explainer'),
    text: welcomeText({ name: room.name, topicMeaning: meaning }),
  };
}

/**
 * The "while you were away" this member was owed on their last return, as the window's summary stands: being written,
 * or ready. A member whose level is Off is owed nothing; a summary that was never written, failed, declined or went
 * stale shows nothing (D-169). Read under the room lock; it is the member's own place and nobody else's.
 */
async function awayOf(p: RoomPorts, entered: EnteredRoom, member: MemberRow): Promise<RoomAway | undefined> {
  if (member.aiLevel === 'off') return undefined;
  const { lock, owner, standing } = entered;
  const position = await p.positions.read(lock, owner.accountId);
  if (position?.awaySince === undefined || position.awayWindow === undefined) return undefined;
  const summary = await p.summaries.forWindow(lock, position.awayWindow);
  if (summary === undefined || (summary.state !== 'queued' && summary.state !== 'ready')) return undefined;
  if (p.now().getTime() - summary.createdAt.getTime() > CARD_LIFE_MS) return undefined;
  const resident = residentAuthor(standing.room, 'skeptic');
  const since = position.awaySince.toISOString();
  return summary.state === 'queued' || summary.body === null
    ? { resident, since, state: 'preparing' }
    : {
        resident,
        since,
        state: 'ready',
        text: summary.body,
        coversFrom: summary.coversFrom.toISOString(),
        ...(member.aiLevel === 'quieter' ? { folded: true as const } : {}),
      };
}

const awayFor = (away: RoomAway | undefined) => (away === undefined ? {} : { away });
const todayFor = (today: RoomTodayStrip | undefined) => (today === undefined ? {} : { today });
const launchFor = (launch: RoomLaunchStrip | undefined) => (launch === undefined ? {} : { launch });
const watchFor = (watch: RoomWatchStrip | undefined) => (watch === undefined ? {} : { watch });
const replayFor = (replay: RoomReplayStrip | undefined) => (replay === undefined ? {} : { replay });
const questionsFor = (questions: RoomQuestions | undefined) => (questions === undefined ? {} : { questions });

/** A member's view of the room: General, the other discussions, their own settings, who is here and how quiet it is. */
async function memberView(p: RoomPorts, scope: PersonalScopeTx, entered: EnteredRoom & { member: MemberRow }) {
  const { lock } = entered;
  const { room } = entered.standing;
  const [rows, general, here, memberTotal, lastMessageAt] = await Promise.all([
    p.discussions.list(lock, DISCUSSIONS_PER_ROOM_VIEW),
    p.discussions.general(lock),
    hereFor(p, scope, entered),
    p.rooms.memberTotal(lock),
    p.discussions.lastMessageAt(lock),
  ]);
  if (general === undefined) throw new Error('ROOMS_GENERAL_MISSING');
  const shown = [general, ...rows];
  const figures = await p.discussions.figures(
    lock,
    shown.map((row) => row.discussionId),
  );
  const [generalSummary, ...summaries] = await discussionSummaries(p, scope, entered, shown, figures);
  return {
    status: 'member' as const,
    room: roomSummary(room),
    role: entered.member.role,
    ...(room.guidelines === null ? {} : { guidelines: room.guidelines }),
    hasModerator: entered.standing.hasModerator,
    inhabitants: inhabitantsOf(room.cast),
    general: generalSummary!,
    discussions: summaries,
    canPost: roomAcceptsPosts(room.status),
    you: youOf(entered.member),
    here,
    memberTotal,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt: lastMessageAt.toISOString() }),
    limits: limitsOf(),
    ...(entered.member.noticeSeenAt === null ? { welcome: welcomeFor(room) } : {}),
    ...awayFor(await awayOf(p, entered, entered.member)),
    sky: await skyOfRoom(p, lock),
    ...todayFor(await todayStrip(p, lock, p.now())),
    ...launchFor(await launchStrip(p, lock, p.now())),
    ...watchFor(await watchStrip(p, scope, lock, room.topic, p.now())),
    ...replayFor(await replayStrip(p, scope, entered, p.now())),
    ...questionsFor(await questionsView(p, scope, entered)),
  };
}

/** What an outsider sees of a room, and whether the rule lets them in. */
async function previewOf(p: RoomPorts, scope: PersonalScopeTx, entered: EnteredRoom, readId: string) {
  const { lock, owner, standing } = entered;
  const { room } = standing;
  const needsFriends = room.joinRule === 'friends_of_members' && !standing.invited;
  const friends = needsFriends ? await p.friends.accounts(scope, owner.accountId, FRIEND_LOOKUP_LIMIT) : [];
  const decision = joinDecision({
    rule: room.joinRule,
    status: room.status,
    earlier: earlierPlaceOf(standing.own),
    hasProfile: await p.people.hasProfile(scope, owner.accountId),
    invited: standing.invited,
    friendOfMember: friends.length > 0 && (await p.rooms.anyMember(lock, friends)),
  });
  const pinnedRow = await p.discussions.pinned(lock);
  const pinned =
    pinnedRow === undefined
      ? undefined
      : (await titlesFor(p, scope, lock, owner.accountId, [pinnedRow])).get(pinnedRow.discussionId);
  return RoomViewSchema.parse({
    ...roomEnvelope(scope),
    readId,
    status: 'preview',
    room: roomSummary(room),
    ...(room.guidelines === null ? {} : { guidelines: room.guidelines }),
    hasModerator: standing.hasModerator,
    inhabitants: inhabitantsOf(room.cast),
    ...(pinned === undefined ? {} : { pinned }),
    invited: standing.invited,
    join: decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason },
  });
}

/**
 * The reads of rooms: the caller's own room list and one room, as a member (General, its discussions, who is
 * here) or as an outsider (a preview and what holds them back). Every read checks current authority and creates
 * no evidence or receipt. Counts follow D-069: a list and a preview count nobody, and a member's own view says
 * who is here (a number only from three), how many members there are and when the room last heard a message.
 */
export function makeRoomReads(p: RoomPorts) {
  return {
    /** The rooms the caller belongs to or is invited to, for Talk. */
    async list(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomListSchema>>> {
      const parsed = ReadRoomListSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope) => {
        if (scope.authority.actor.kind !== 'account') return refuse('unavailable');
        const gate = await p.fenceOwn(scope);
        if (gate.kind !== 'active') return refuse('unavailable');
        const rows = await p.rooms.listFor(scope, gate.owner.accountId);
        return ok(
          RoomListSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            items: rows.map((row) => ({ room: roomSummary(row.room), standing: row.standing })),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * The reports on this room's messages, for its moderators only (D-055). A member who is not a moderator,
     * a stranger and an unknown room all get the same refusal. A moderator never sees a report about their
     * own words, and no answer says who reported, what they wrote or the time of day: only the day of the newest report.
     */
    async reports(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomReportsSchema>>> {
      const parsed = ReadRoomReportsSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const entered = await enterRoom(p, scope, query.roomId, 'read');
        if (!entered?.member || !isModerator(entered.member.role)) return refuse('unavailable');
        const found = await p.readReports(scope, {
          roomId: query.roomId,
          excludingAccountId: entered.owner.accountId,
          limit: REPORTS_PER_ROOM_VIEW,
        });
        const placed = await p.discussions.locate(
          entered.lock,
          found.map((report) => report.messageId),
        );
        const titles = await titlesFor(
          p,
          scope,
          entered.lock,
          entered.owner.accountId,
          [...placed.values()].map((place) => ({
            discussionId: place.discussionId,
            title: place.discussionTitle,
            titleDerived: place.titleDerived,
          })),
        );
        return ok(
          RoomReportsSchema.parse({
            ...roomEnvelope(scope),
            readId: query.readId,
            roomId: query.roomId,
            reports: found.flatMap((report) => {
              const place = placed.get(report.messageId);
              return place === undefined
                ? []
                : [
                    {
                      messageId: report.messageId,
                      discussionId: place.discussionId,
                      discussionTitle: titles.get(place.discussionId)!,
                      sequence: place.sequence,
                      count: report.count,
                      categories: report.categories,
                      lastReportedAt: reportedOnDay(report.lastReportedAt).toISOString(),
                    },
                  ];
            }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** One room: its discussions for a member, its preview and join answer for anyone else. */
    async read(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomViewSchema>>> {
      const parsed = ReadRoomSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...roomEnvelope(scope), readId: query.readId };
        const entered = await enterRoom(p, scope, query.roomId, 'read');
        if (!entered) return ok(RoomViewSchema.parse({ ...envelope, status: 'unavailable' }));
        if (entered.member === undefined) return ok(await previewOf(p, scope, entered, query.readId));
        return ok(
          RoomViewSchema.parse({
            ...envelope,
            ...(await memberView(p, scope, { ...entered, member: entered.member })),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * The room's topics as a forum list (R3 B2, D-167): pinned first, then Hot (replies, Useful marks and how recently
     * someone spoke; a code formula), New, or Unanswered (no one but the starter has spoken), optionally with one tag.
     * Only a member reads it; anyone else gets the same answer as for a room that is not there. Reading creates nothing
     * and tells nobody. A mark of Useful is counted only here, on the topic, and no author is told who made one.
     */
    async topics(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomTopicsSchema>>> {
      const parsed = ReadRoomTopicsSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...roomEnvelope(scope), readId: query.readId };
        const entered = await enterRoom(p, scope, query.roomId, 'read');
        if (entered?.member === undefined) return ok(RoomTopicsSchema.parse({ ...envelope, status: 'unavailable' }));
        const { lock } = entered;
        const rows = await p.discussions.listTopics(lock, {
          ...(query.tag === undefined ? {} : { tag: query.tag }),
          limit: TOPICS_RANKED,
        });
        const figures = await p.discussions.figures(
          lock,
          rows.map((row) => row.discussionId),
        );
        const ranked = orderTopics(
          rows.map((row) => ({
            row,
            discussionId: row.discussionId,
            pinned: row.pinned,
            createdAt: row.createdAt,
            lastActivityAt: row.lastActivityAt,
            replyCount: figures.get(row.discussionId)?.replyCount ?? 0,
            usefulCount: figures.get(row.discussionId)?.usefulCount ?? 0,
            answered: figures.get(row.discussionId)?.answered ?? false,
          })),
          query.sort,
          p.now(),
        ).slice(0, DISCUSSIONS_LISTED_MAX);
        const summaries = await discussionSummaries(
          p,
          scope,
          { ...entered, member: entered.member },
          ranked.map((topic) => topic.row),
          figures,
        );
        return ok(
          RoomTopicsSchema.parse({
            ...envelope,
            status: 'ready',
            roomId: query.roomId,
            sort: query.sort,
            canPost: roomAcceptsPosts(entered.standing.room.status),
            topics: summaries.map((summary, index) => ({
              ...summary,
              usefulCount: ranked[index]!.usefulCount,
              answered: ranked[index]!.answered,
            })),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
