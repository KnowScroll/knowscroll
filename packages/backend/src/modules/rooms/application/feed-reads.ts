import {
  AI_INHABITANT_LABELS,
  ROOM_FEED_POSTS_MAX,
  ReadRoomFeedSchema,
  ReplaceRoomMemorySchema,
  RoomFeedSchema,
  RoomMemoryReplacementSchema,
  SCOUT_LABEL,
  type AiAuthor,
  type PublicPersonRef,
  type RoomFeedStrip,
  type ScoutAuthor,
  type RoomMemory,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { nameOf, type CastMember } from '../domain/cast.js';
import type { InhabitantId } from '../domain/contribution.js';
import type { AiLevel } from '../domain/membership.js';
import { memoryProblem } from '../domain/memory.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import type { MemoryView } from './feed-ports.js';
import { ok, refuse, roomEnvelope, type ContentCard, type Result, type RoomLock, type RoomPorts } from './ports.js';
import { identityOf, inhabitantsOf, limitsOf } from './view.js';
import { scoutViewOf } from './scout-commands.js';
import type { FindRow } from './feed-ports.js';

const residentOf = (cast: readonly CastMember[], inhabitant: InhabitantId): AiAuthor => ({
  kind: 'ai',
  inhabitant,
  name: nameOf(cast, inhabitant),
  label: AI_INHABITANT_LABELS[inhabitant],
});

/**
 * Who signs a find, for this reader: the resident, or the member whose scout it was, by their public profile. A scout whose owner
 * the reader blocked, or whose owner cannot be named, is nobody's to show: the reader sees no scout post from them (D-259).
 */
async function authorOf(
  p: RoomPorts,
  scope: Parameters<RoomPorts['people']['byAccounts']>[0],
  readerAccountId: string,
  cast: readonly CastMember[],
  rows: readonly FindRow[],
): Promise<(row: FindRow) => AiAuthor | ScoutAuthor | undefined> {
  const owners = [...new Set(rows.flatMap((row) => (row.author.kind === 'scout' ? [row.author.ownerAccountId] : [])))];
  const people: ReadonlyMap<string, PublicPersonRef> =
    owners.length === 0 ? new Map() : await p.people.byAccounts(scope, owners);
  const blocked = owners.length === 0 ? new Set<string>() : await p.blocked(scope, readerAccountId, owners);
  return (row) => {
    if (row.author.kind === 'resident') return residentOf(cast, row.author.inhabitant);
    const owner = people.get(row.author.ownerAccountId);
    return owner === undefined || blocked.has(row.author.ownerAccountId)
      ? undefined
      : { kind: 'agent', sentBy: owner, label: SCOUT_LABEL };
  };
}

/** What a reader is told the residents remember: the words while they stand, nothing once they were erased. */
const memoryShown = (memory: MemoryView | undefined): RoomMemory =>
  memory?.state === 'ready' && memory.body !== null
    ? { state: 'ready', text: memory.body, by: memory.source === 'moderator' ? 'moderator' : 'residents' }
    : { state: 'none' };

/** How many of the newest finds the Now strip looks through to find one this reader may see. */
const STRIP_LOOKS = 5;

/**
 * What the Now strip says of the feed: the newest find a reader may see, or nothing. A reader whose AI level is Off is told
 * nothing, because nothing a resident posts on its own reaches them. A find a moderator removed is not listed, so it is not here,
 * and neither is a scout's find whose owner the reader blocked.
 */
export async function feedStrip(
  p: RoomPorts,
  scope: Parameters<RoomPorts['people']['byAccounts']>[0],
  lock: RoomLock,
  reader: { readonly aiLevel: AiLevel; readonly accountId: string },
  cast: readonly CastMember[],
): Promise<RoomFeedStrip | undefined> {
  if (reader.aiLevel === 'off') return undefined;
  const rows = await p.feed.finds(lock, STRIP_LOOKS);
  const authorOfRow = await authorOf(p, scope, reader.accountId, cast, rows);
  for (const row of rows) {
    const by = authorOfRow(row);
    if (by !== undefined) return { by, postedAt: row.postedAt.toISOString() };
  }
  return undefined;
}

/**
 * The residents' feed and what they remember. Reading creates nothing and no evidence; the one command is a moderator's, and
 * it is audited.
 */
export function makeFeed(p: RoomPorts) {
  return {
    /**
     * The room's feed for a member: the newest finds (at most `ROOM_FEED_POSTS_MAX`), each with the library asset it is about as
     * a card, the resident that posted it and its note, and what the residents remember. A reader whose AI level is Off is listed
     * no find; for Quieter the note is held back until they ask for it. A stranger, a person who left and a room that is not
     * there all get the same refusal.
     */
    async feed(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomFeedSchema>>> {
      const parsed = ReadRoomFeedSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomFeedSchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const { lock, member } = entered;
        const { cast } = entered.standing.room;
        const rows = member.aiLevel === 'off' ? [] : await p.feed.finds(lock, ROOM_FEED_POSTS_MAX);
        const cards =
          rows.length === 0
            ? []
            : await p.readContent(
                scope,
                rows.map((row) => row.asset),
              );
        const cardOf = new Map(
          cards.map((card) => [`${card.target.assetId}:${String(card.target.assetRevision)}`, card]),
        );
        const authorOfRow = await authorOf(p, scope, entered.owner.accountId, cast, rows);
        const posts = rows.flatMap((row) => {
          const key = `${row.asset.assetId}:${String(row.asset.assetRevision)}`;
          const card: ContentCard = cardOf.get(key) ?? { status: 'unavailable', target: row.asset };
          const author = authorOfRow(row);
          return row.note === null || author === undefined
            ? []
            : [
                {
                  discussionId: row.discussionId,
                  author,
                  postedAt: row.postedAt.toISOString(),
                  content: card,
                  ...(member.aiLevel === 'quieter' ? { folded: true as const } : { note: row.note }),
                  replies: row.replies,
                },
              ];
        });
        return ok(
          RoomFeedSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            roomId: parsed.data.roomId,
            identity: identityOf(entered.standing.room),
            posts,
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
