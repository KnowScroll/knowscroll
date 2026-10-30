import {
  AI_INHABITANT_BLURBS,
  AI_INHABITANT_LABELS,
  DiscussionChangesPageSchema,
  DiscussionHistoryPageSchema,
  DiscussionViewSchema,
  OpenRoomSnippetSchema,
  ReadDiscussionChangesSchema,
  ReadDiscussionHistorySchema,
  ReadDiscussionSchema,
  RoomSnippetOpeningSchema,
  type RoomInhabitantStatusSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { SnippetResolution, StoredSnippetAnchor } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { askDecision, hourBefore, utcDayStart, type InhabitantId } from '../domain/contribution.js';
import { changesCursor, historyCursor } from '../domain/cursors.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { discussionEpisodes, viewRoomMessages } from './discussion-view.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type ContentRef, type Result, type RoomLock, type RoomPorts } from './ports.js';
import { roomSummary } from './view.js';

/**
 * Who is reading: their account, whether they moderate (a moderator can still review a blocked author's words),
 * their AI level (Off hides what residents say on their own) and the room's cast.
 */
const viewerOf = (entered: EnteredRoom) => ({
  accountId: entered.owner.accountId,
  moderator: entered.member?.role === 'moderator',
  aiLevel: entered.member?.aiLevel ?? 'lively',
  cast: entered.standing.room.cast,
});

/** How long the reader is told about an ask that ended without a contribution. */
const UNANSWERED_ASK_MEMORY_MS = 10 * 60 * 1000;

type InhabitantStatus = z.infer<typeof RoomInhabitantStatusSchema>;

/** The words an opened passage or block banner shows come from the stored snippet, not from the corrected revision. */
function openedAnchor(
  resolved: Extract<SnippetResolution, { status: 'ready' }>['anchor'],
  stored: StoredSnippetAnchor,
) {
  if (resolved.kind === 'scroll_passage' && stored.kind === 'scroll_passage')
    return { ...resolved, quote: stored.quote };
  if (resolved.kind === 'scroll_block' && stored.kind === 'scroll_block') {
    const settings = resolved.snapshot === undefined ? undefined : stored.settings;
    return {
      ...resolved,
      ...(stored.label === '' ? {} : { label: stored.label }),
      ...(settings === undefined || settings.description === '' ? {} : { description: settings.description }),
    };
  }
  return resolved;
}

/** The title of the content's current revision, or nothing when it cannot be shown (withdrawn meanwhile). */
async function currentTitle(p: RoomPorts, scope: PersonalScopeTx, location: ContentRef): Promise<string | undefined> {
  const [card] = await p.readContent(scope, [location]);
  return card?.status === 'available' ? card.metadata.title : undefined;
}

/**
 * What the caller may ask of each inhabitant of the room now, and the caller's own last ask that
 * ended without a contribution. `preparing` is shown to every member (an inhabitant is working on
 * a reply), and says nothing about who asked.
 */
async function inhabitantStatuses(
  p: RoomPorts,
  entered: EnteredRoom,
  discussionId: string,
  now: Date,
): Promise<{
  inhabitants: InhabitantStatus[];
  yourAsk: { inhabitant: InhabitantId; outcome: 'nothing_to_add' | 'could_not_answer' } | undefined;
}> {
  const { lock, owner, standing } = entered;
  const [counts, open, last] = await Promise.all([
    p.ai.countAsks(lock, { accountId: owner.accountId, dayStart: utcDayStart(now), hourStart: hourBefore(now) }),
    p.ai.openAsks(lock, discussionId, now),
    p.ai.lastUnansweredAsk(lock, discussionId, owner.accountId, new Date(now.getTime() - UNANSWERED_ASK_MEMORY_MS)),
  ]);
  const decision = askDecision({
    roomAsksToday: counts.room,
    personAsksLastHour: counts.person,
    personRequestsLastHour: counts.personRequests,
    openAsk: open.length > 0,
  });
  const ask: InhabitantStatus['ask'] = !roomAcceptsPosts(standing.room.status)
    ? 'paused'
    : decision === 'allowed'
      ? 'available'
      : decision === 'preparing'
        ? 'preparing'
        : 'resting';
  return {
    inhabitants: standing.room.cast.map(({ inhabitant, name }) => ({
      inhabitant,
      name,
      label: AI_INHABITANT_LABELS[inhabitant],
      blurb: AI_INHABITANT_BLURBS[inhabitant],
      ask,
    })),
    yourAsk:
      last === undefined
        ? undefined
        : { inhabitant: last.inhabitant, outcome: last.state === 'declined' ? 'nothing_to_add' : 'could_not_answer' },
  };
}

/**
 * The reads of a room discussion: the newest messages with the people, episodes and what the
 * caller may ask of the inhabitants; older history; catch-up after a lost update; and the opening
 * of a snippet. Every read checks current authority (open member of the room) and answers
 * `unavailable` identically for a stranger, a person who left or was removed, and a missing
 * discussion. Reading creates no evidence, receipt or notice, and no answer carries another
 * member's position, current episode or seen marker.
 */
export function makeDiscussionReads(p: RoomPorts) {
  async function inDiscussion<A>(
    authority: PersonalAuthority,
    ids: { readonly roomId: string; readonly discussionId: string },
    unavailable: (envelope: ReturnType<typeof roomEnvelope>) => A,
    read: (
      scope: PersonalScopeTx,
      entered: EnteredRoom,
      lock: RoomLock,
      discussion: NonNullable<Awaited<ReturnType<RoomPorts['discussions']['load']>>>,
    ) => Promise<A>,
  ): Promise<Result<A>> {
    const result = await p.withScope(authority, async (scope) => {
      const envelope = roomEnvelope(scope);
      const entered = await enterRoom(p, scope, ids.roomId, 'read');
      if (!entered?.member) return unavailable(envelope);
      const discussion = await p.discussions.load(entered.lock, ids.discussionId);
      if (!discussion) return unavailable(envelope);
      return read(scope, entered, entered.lock, discussion);
    });
    return result.kind === 'entered' ? ok(result.value) : refuse('unavailable');
  }

  return {
    /** The newest messages of a discussion, its content thread (root and episodes), and the cursor to catch up from. */
    async readDiscussion(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DiscussionViewSchema>>> {
      const parsed = ReadDiscussionSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      return inDiscussion(
        authority,
        query,
        (envelope) => DiscussionViewSchema.parse({ ...envelope, readId: query.readId, status: 'unavailable' }),
        async (scope, entered, lock, discussion) => {
          const { room } = entered.standing;
          // The counters are read before the messages, so a message that commits meanwhile is read again by catch-up, never missed.
          const rows = await p.discussions.messages(lock, discussion.discussionId, {
            limit: query.limit,
            ...(discussion.lastSequence > 0 ? { before: discussion.lastSequence + 1 } : {}),
          });
          const oldest = rows[0];
          const content = discussion.root === null ? undefined : await discussionEpisodes(p, scope, discussion.root);
          const [root] = discussion.root === null ? [] : await p.readContent(scope, [discussion.root]);
          const asks = await inhabitantStatuses(p, entered, discussion.discussionId, p.now());
          const wanted = [
            entered.owner.accountId,
            ...(discussion.startedByAccountId === null ? [] : [discussion.startedByAccountId]),
          ];
          const people = await p.people.byAccounts(scope, wanted);
          const you = people.get(entered.owner.accountId);
          // A member always has a claimed profile; without one the view is as unavailable as for a stranger.
          if (you === undefined)
            return DiscussionViewSchema.parse({ ...roomEnvelope(scope), readId: query.readId, status: 'unavailable' });
          const starter =
            discussion.startedByAccountId === null ? undefined : people.get(discussion.startedByAccountId);
          // A topic that began from a message shows that message first, as this reader may see it (hidden, blocked, kept as written).
          const originRow =
            discussion.originMessageId === null || discussion.root !== null
              ? undefined
              : (await p.discussions.messageInRoom(lock, discussion.originMessageId))?.message;
          const [origin] =
            originRow === undefined ? [] : await viewRoomMessages(p, scope, lock, [originRow], viewerOf(entered));
          return DiscussionViewSchema.parse({
            ...roomEnvelope(scope),
            readId: query.readId,
            status: 'ready',
            room: roomSummary(room),
            role: entered.member!.role,
            you,
            discussion: {
              discussionId: discussion.discussionId,
              kind: discussion.kind,
              title: discussion.title,
              ...(discussion.tag === null ? {} : { tag: discussion.tag }),
              pinned: discussion.pinned,
              ...(starter === undefined ? {} : { startedBy: starter }),
            },
            ...(origin === undefined ? {} : { origin }),
            ...(content === undefined || discussion.root === null
              ? {}
              : {
                  content: {
                    root: root ?? { status: 'unavailable', target: discussion.root },
                    sequence: content.sequence,
                    episodes: content.episodes,
                  },
                }),
            canPost: roomAcceptsPosts(room.status),
            inhabitants: asks.inhabitants,
            ...(asks.yourAsk === undefined ? {} : { yourAsk: asks.yourAsk }),
            latestMessageSequence: discussion.lastSequence,
            messages: await viewRoomMessages(p, scope, lock, rows, viewerOf(entered)),
            limit: query.limit,
            history:
              oldest && oldest.sequence > 1
                ? {
                    kind: 'more',
                    cursor: historyCursor.encode({
                      discussionId: discussion.discussionId,
                      beforeSequence: oldest.sequence,
                    }),
                  }
                : { kind: 'end' },
            catchUpCursor: changesCursor.encode({
              discussionId: discussion.discussionId,
              afterChangeSequence: discussion.lastChangeSequence,
            }),
          });
        },
      );
    },

    /** Messages older than a cursor taken from the view or an earlier page. */
    async history(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DiscussionHistoryPageSchema>>> {
      const parsed = ReadDiscussionHistorySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      return inDiscussion(
        authority,
        query,
        (envelope) => DiscussionHistoryPageSchema.parse({ ...envelope, readId: query.readId, status: 'unavailable' }),
        async (scope, entered, lock, discussion) => {
          const envelope = { ...roomEnvelope(scope), readId: query.readId };
          const position = historyCursor.decode(query.cursor);
          if (position?.discussionId !== discussion.discussionId)
            return DiscussionHistoryPageSchema.parse({
              ...envelope,
              status: 'refresh_required',
              requestCursor: query.cursor,
            });
          const rows = await p.discussions.messages(lock, discussion.discussionId, {
            before: position.beforeSequence,
            limit: query.limit,
          });
          const oldest = rows[0];
          return DiscussionHistoryPageSchema.parse({
            ...envelope,
            status: 'ready',
            limit: query.limit,
            requestCursor: query.cursor,
            messages: await viewRoomMessages(p, scope, lock, rows, viewerOf(entered)),
            continuation:
              oldest && oldest.sequence > 1
                ? {
                    kind: 'more',
                    cursor: historyCursor.encode({
                      discussionId: discussion.discussionId,
                      beforeSequence: oldest.sequence,
                    }),
                  }
                : { kind: 'end' },
          });
        },
      );
    },

    /** Everything that changed after a cursor: new messages, and messages a moderator hid or restored. */
    async changes(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DiscussionChangesPageSchema>>> {
      const parsed = ReadDiscussionChangesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      return inDiscussion(
        authority,
        query,
        (envelope) => DiscussionChangesPageSchema.parse({ ...envelope, readId: query.readId, status: 'unavailable' }),
        async (scope, entered, lock, discussion) => {
          const envelope = { ...roomEnvelope(scope), readId: query.readId };
          const position = changesCursor.decode(query.cursor);
          if (position?.discussionId !== discussion.discussionId)
            return DiscussionChangesPageSchema.parse({
              ...envelope,
              status: 'refresh_required',
              requestCursor: query.cursor,
            });
          const rows = await p.discussions.messages(lock, discussion.discussionId, {
            after: position.afterChangeSequence,
            limit: query.limit,
          });
          const views = await viewRoomMessages(p, scope, lock, rows, viewerOf(entered));
          const last = rows.at(-1);
          const next = changesCursor.encode({
            discussionId: discussion.discussionId,
            afterChangeSequence: last?.changeSequence ?? position.afterChangeSequence,
          });
          return DiscussionChangesPageSchema.parse({
            ...envelope,
            status: 'ready',
            limit: query.limit,
            requestCursor: query.cursor,
            changes: rows.map((row, index) => ({ changeSequence: row.changeSequence, message: views[index]! })),
            continuation: { kind: rows.length === query.limit ? 'more' : 'caught_up', cursor: next },
          });
        },
      );
    },

    /** Where a snippet of this discussion leads now. Opening it is not an encounter and writes nothing. */
    async openSnippet(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomSnippetOpeningSchema>>> {
      const parsed = OpenRoomSnippetSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      return inDiscussion(
        authority,
        query,
        (envelope) => RoomSnippetOpeningSchema.parse({ ...envelope, readId: query.readId, status: 'unavailable' }),
        async (scope, entered, lock, discussion) => {
          const envelope = { ...roomEnvelope(scope), readId: query.readId };
          const unavailable = () => RoomSnippetOpeningSchema.parse({ ...envelope, status: 'unavailable' });
          const message = await p.discussions.messageById(lock, discussion.discussionId, query.messageId);
          if (message === undefined || message.hidden) return unavailable();
          // A blocked author's card is collapsed for the blocker, and so is what it opens (a moderator may still review it).
          if (
            message.authorAccountId !== null &&
            !viewerOf(entered).moderator &&
            (await p.blocked(scope, entered.owner.accountId, [message.authorAccountId])).has(message.authorAccountId)
          )
            return unavailable();
          const stored = await p.discussions.snippetOfMessage(lock, discussion.discussionId, query.messageId);
          if (stored === undefined) return unavailable();
          const resolution = await p.resolveSnippet(scope, stored.target, stored.anchor);
          if (resolution.status === 'unavailable') return unavailable();
          if (resolution.status === 'changed') {
            const title = await currentTitle(p, scope, resolution.current);
            return title === undefined
              ? unavailable()
              : RoomSnippetOpeningSchema.parse({
                  ...envelope,
                  status: 'changed',
                  current: { ...resolution.current, title },
                });
          }
          const title = await currentTitle(p, scope, resolution.content);
          return title === undefined
            ? unavailable()
            : RoomSnippetOpeningSchema.parse({
                ...envelope,
                status: 'ready',
                content: { ...resolution.content, title },
                anchor: openedAnchor(resolution.anchor, stored.anchor),
                mapped: resolution.mapped,
                settingsReset: resolution.settingsReset,
              });
        },
      );
    },
  };
}
