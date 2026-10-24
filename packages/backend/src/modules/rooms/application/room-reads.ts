import {
  ReadRoomListSchema,
  ReadRoomReportsSchema,
  ReadRoomSchema,
  RoomListSchema,
  RoomReportsSchema,
  RoomViewSchema,
  type PublicPersonRef,
  type RoomDiscussionSummary,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { isModerator, joinDecision, roomAcceptsPosts } from '../domain/membership.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import {
  earlierPlaceOf,
  ok,
  refuse,
  roomEnvelope,
  type ContentCard,
  type DiscussionRow,
  type Result,
  type RoomPorts,
} from './ports.js';
import { inhabitantsOf, roomSummary } from './view.js';

/** The most friends of the caller read to learn whether a room's rule lets them in. */
const FRIEND_LOOKUP_LIMIT = 1000;
/** The most discussions a room view lists. */
export const DISCUSSIONS_PER_ROOM_VIEW = 50;
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
 * The reads of rooms: the caller's own room list and one room, as a member (its discussions) or as
 * an outsider (a preview and what holds them back). Every read checks current authority, creates
 * no evidence or receipt, and counts nobody: no answer says how many members a room has, who is
 * online or what anyone watched.
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
     * own words, and no answer says who reported or what they wrote.
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
                      lastReportedAt: report.lastReportedAt.toISOString(),
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
        const { room } = entered.standing;
        const rows = await p.discussions.list(entered.lock, DISCUSSIONS_PER_ROOM_VIEW);
        return ok(
          RoomViewSchema.parse({
            ...envelope,
            status: 'member',
            room: roomSummary(room),
            role: entered.member.role,
            ...(room.guidelines === null ? {} : { guidelines: room.guidelines }),
            hasModerator: entered.standing.hasModerator,
            inhabitants: inhabitantsOf(room.inhabitants),
            discussions: await discussionSummaries(p, scope, rows),
            canPost: roomAcceptsPosts(room.status),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
