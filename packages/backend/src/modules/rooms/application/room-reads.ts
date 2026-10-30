import {
  ROOM_FACES_MAX,
  ROOM_PRESENCE_LEASE_MS,
  ReadRoomListSchema,
  ReadRoomReportsSchema,
  ReadRoomSchema,
  RoomListSchema,
  RoomReportsSchema,
  RoomViewSchema,
  type PublicPersonRef,
  type RoomDiscussionSummary,
  type RoomHere,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { isModerator, joinDecision, roomAcceptsPosts } from '../domain/membership.js';
import { COUNT_FROM, hereOf } from '../domain/presence.js';
import { reportedOnDay } from '../domain/reports.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import {
  earlierPlaceOf,
  ok,
  refuse,
  roomEnvelope,
  type ContentCard,
  type DiscussionRow,
  type MemberRow,
  type Result,
  type RoomPorts,
} from './ports.js';
import { inhabitantsOf, roomSummary, youOf } from './view.js';

/** The most friends of the caller read to learn whether a room's rule lets them in. */
const FRIEND_LOOKUP_LIMIT = 1000;
/** The most discussions a room view lists. */
export const DISCUSSIONS_PER_ROOM_VIEW = 50;
/** The most fresh leases one read looks at; a room with more people here than this counts this many. */
const PRESENCE_READ_LIMIT = 200;
/** The most reported messages a moderator's list shows. */
const REPORTS_PER_ROOM_VIEW = 50;

const keyOf = (ref: { assetId: string; assetRevision: number }) => `${ref.assetId}:${String(ref.assetRevision)}`;

/** The discussion rows of a room as the list shows them: the root's card and the starter's public profile. */
async function discussionSummaries(
  p: RoomPorts,
  scope: PersonalScopeTx,
  rows: readonly DiscussionRow[],
): Promise<RoomDiscussionSummary[]> {
  const roots = rows.flatMap((row) => (row.root === null ? [] : [row.root]));
  const cards: readonly ContentCard[] = roots.length === 0 ? [] : await p.readContent(scope, roots);
  const cardOf = new Map(cards.map((card) => [keyOf(card.target), card]));
  const starterIds = [
    ...new Set(rows.flatMap((row) => (row.startedByAccountId === null ? [] : [row.startedByAccountId]))),
  ];
  const people: ReadonlyMap<string, PublicPersonRef> =
    starterIds.length === 0 ? new Map() : await p.people.byAccounts(scope, starterIds);
  return rows.map((row) => {
    const starter = row.startedByAccountId === null ? undefined : people.get(row.startedByAccountId);
    return {
      discussionId: row.discussionId,
      kind: row.kind,
      title: row.title,
      ...(row.root === null
        ? {}
        : { root: cardOf.get(keyOf(row.root)) ?? { status: 'unavailable' as const, target: row.root } }),
      ...(starter === undefined ? {} : { startedBy: starter }),
      pinned: row.pinned,
      lastActivityAt: row.lastActivityAt.toISOString(),
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
  const [generalSummary] = await discussionSummaries(p, scope, [general]);
  return {
    status: 'member' as const,
    room: roomSummary(room),
    role: entered.member.role,
    ...(room.guidelines === null ? {} : { guidelines: room.guidelines }),
    hasModerator: entered.standing.hasModerator,
    inhabitants: inhabitantsOf(room.inhabitants),
    general: generalSummary,
    discussions: await discussionSummaries(p, scope, rows),
    canPost: roomAcceptsPosts(room.status),
    you: youOf(entered.member),
    here,
    memberTotal,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt: lastMessageAt.toISOString() }),
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
  const pinned = await p.discussions.pinnedTitle(lock);
  return RoomViewSchema.parse({
    ...roomEnvelope(scope),
    readId,
    status: 'preview',
    room: roomSummary(room),
    ...(room.guidelines === null ? {} : { guidelines: room.guidelines }),
    hasModerator: standing.hasModerator,
    inhabitants: inhabitantsOf(room.inhabitants),
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
                      discussionTitle: place.discussionTitle,
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
  };
}
