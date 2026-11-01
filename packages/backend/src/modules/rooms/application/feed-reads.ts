import {
  ROOM_FEED_POSTS_MAX,
  ReadRoomFeedSchema,
  ReplaceRoomMemorySchema,
  RoomFeedSchema,
  RoomMemoryReplacementSchema,
  type RoomFeedPost,
  type RoomFeedWindow,
  type RoomMemory,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import type { AiLevel } from '../domain/membership.js';
import { RANK_RULES, arrange, windowStart, type FeedSort } from '../domain/feed-rank.js';
import { dayStartOf } from '../domain/feed.js';
import { memoryProblem } from '../domain/memory.js';
import { hostOf, mayPost } from '../domain/posts.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import type { MemoryView } from './feed-ports.js';
import { ok, refuse, roomEnvelope, type ContentCard, type Result, type RoomLock, type RoomPorts } from './ports.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { authorsOf, type Signed } from './feed-authors.js';
import { residentProfiles } from './resident-profiles.js';
import { identityOf, inhabitantsOf, limitsOf } from './view.js';
import { scoutViewOf } from './scout-commands.js';
import type { FindQuery, FindRow } from './feed-ports.js';

/** What a reader is told the residents remember: the words while they stand, nothing once they were erased. */
const memoryShown = (memory: MemoryView | undefined): RoomMemory =>
  memory?.state === 'ready' && memory.body !== null
    ? { state: 'ready', text: memory.body, by: memory.source === 'moderator' ? 'moderator' : 'residents' }
    : { state: 'none' };

/** The posts a reader is listed, in the order they asked for: Hot ranked by code, New and Top ordered by the store. */
async function listedRows(
  p: RoomPorts,
  lock: RoomLock,
  reader: { readonly aiLevel: AiLevel; readonly accountId: string },
  order: { readonly sort: FeedSort; readonly window: RoomFeedWindow },
  now: Date,
): Promise<readonly FindRow[]> {
  // A reader whose AI is Off is listed no find a resident or a scout posted, and still every post a member made.
  const query: FindQuery = {
    sort: order.sort,
    since: order.sort === 'top' ? windowStart(order.window, now) : undefined,
    limit: order.sort === 'hot' ? RANK_RULES.hotCandidates : ROOM_FEED_POSTS_MAX,
    readerAccountId: reader.accountId,
    by: reader.aiLevel === 'off' ? 'people' : 'all',
  };
  return arrange(await p.feed.finds(lock, query), order.sort, now);
}

/** A post as the contract draws it, or nothing when its author cannot be shown to this reader. */
function postView(
  row: FindRow,
  author: Signed | undefined,
  card: ContentCard | undefined,
  aiLevel: AiLevel,
): RoomFeedPost | undefined {
  if (author === undefined || row.note === null) return undefined;
  const base = {
    discussionId: row.discussionId,
    postedAt: row.postedAt.toISOString(),
    replies: row.replies,
    votes: row.votes,
    youVoted: row.votedByReader,
    canVote: author.kind !== 'person' || !author.you,
  };
  if (author.kind === 'person') {
    const link =
      row.source !== undefined
        ? ({ kind: 'source', source: { url: row.source, host: hostOf(row.source) } } as const)
        : card === undefined
          ? undefined
          : ({ kind: 'content', content: card } as const);
    return link === undefined ? undefined : { kind: 'post', ...base, author, title: row.title, words: row.note, link };
  }
  if (author.kind === 'ai' && row.introduces !== undefined) return { kind: 'intro', ...base, author, text: row.note };
  if (card === undefined) return undefined;
  return {
    kind: 'find',
    ...base,
    author,
    content: card,
    ...(aiLevel === 'quieter' ? { folded: true as const } : { note: row.note }),
  };
}

/**
 * The room's Feed and what the residents remember. Reading creates nothing and no evidence; the commands are a moderator's
 * (audited) and a member's own post and vote (`post-commands.ts`).
 */
export function makeFeed(p: RoomPorts) {
  return {
    /**
     * The room's Feed for a member: at most `ROOM_FEED_POSTS_MAX` posts in the order they asked for (Hot unless they say
     * otherwise; Top counts a window), residents' and scouts' finds and members' own posts side by side, each with the library
     * asset it is about as a card or its source, its words, its replies and its votes as a number, and what the residents remember.
     * A reader whose AI level is Off is listed no find; for Quieter the note of a find is held back until they ask for it. A
     * post by someone the reader blocked is left out, and the order and the counts are the same for every reader. A stranger, a
     * person who left and a room that is not there all get the same refusal.
     */
    async feed(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomFeedSchema>>> {
      const parsed = ReadRoomFeedSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const order = { sort: parsed.data.sort ?? 'hot', window: parsed.data.window ?? RANK_RULES.defaultWindow };
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomFeedSchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const { lock, member } = entered;
        const { cast, status } = entered.standing.room;
        const reader = { aiLevel: member.aiLevel, accountId: entered.owner.accountId };
        const now = p.now();
        const rows = await listedRows(p, lock, reader, order, now);
        const assets = rows.flatMap((row) => (row.asset === undefined ? [] : [row.asset]));
        const cards = assets.length === 0 ? [] : await p.readContent(scope, assets);
        const cardOf = new Map(
          cards.map((card) => [`${card.target.assetId}:${String(card.target.assetRevision)}`, card]),
        );
        const authorOfRow = await authorsOf(p, scope, reader.accountId, cast, rows);
        const posts = rows
          .flatMap((row) => {
            const card =
              row.asset === undefined
                ? undefined
                : (cardOf.get(`${row.asset.assetId}:${String(row.asset.assetRevision)}`) ??
                  ({ status: 'unavailable', target: row.asset } satisfies ContentCard));
            const view = postView(row, authorOfRow(row), card, member.aiLevel);
            return view === undefined ? [] : [view];
          })
          .slice(0, ROOM_FEED_POSTS_MAX);
        const postsToday = await p.posts.postsSince(lock, reader.accountId, dayStartOf(now));
        return ok(
          RoomFeedSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            roomId: parsed.data.roomId,
            identity: identityOf(entered.standing.room),
            sort: order.sort,
            window: order.window,
            profiles: await residentProfiles(p, lock, cast, now),
            posts,
            canPost: roomAcceptsPosts(status) && mayPost(postsToday),
            residents: inhabitantsOf(cast),
            memory: memoryShown(await p.feed.memory(lock)),
            canEditMemory: member.role === 'moderator',
            aiLevel: member.aiLevel,
            limits: limitsOf().feed,
            ...(p.scoutsEnabled
              ? { scout: await scoutViewOf(p, lock, entered.owner.accountId, entered.standing.room.topic) }
              : {}),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * A moderator replaces what the residents remember with their own words, or clears it so it is written again from what
     * members said. Either is audited: who, what and when, and the SHA-256 of the words (an earlier text is not kept). A moderator's
     * text is not derived from any message, so no removal makes it stale; it stands until a moderator ends it. Nothing here
     * makes a model call. The same command again is accepted; a member who is not a moderator gets the one refusal.
     */
    replaceMemory(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomMemoryReplacementSchema>>> {
      const parsed = ReplaceRoomMemorySchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      const text = command.text?.trim();
      if (text !== undefined && memoryProblem(text, 'moderator') !== undefined)
        return Promise.resolve(refuse('invalid_input'));
      return runCommand(p, authority, {
        operation: 'rooms.memory-replace',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomMemoryReplacementSchema,
        requires: 'moderator',
        mode: 'read',
        decide({ scope, entered, now }) {
          return Promise.resolve(
            ok(async () => {
              const edit = { byAccountId: entered.owner.accountId, now, editId: p.newId() };
              if (text === undefined) await p.feed.clearMemory(entered.lock, edit);
              else
                await p.feed.replaceMemory(entered.lock, {
                  ...edit,
                  text,
                  sha256: p.hash('rooms.memory-text', { text }),
                });
              return RoomMemoryReplacementSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'room.memory-replace',
                roomId: command.roomId,
                memory: memoryShown(await p.feed.memory(entered.lock)),
              });
            }),
          );
        },
      });
    },
  };
}
