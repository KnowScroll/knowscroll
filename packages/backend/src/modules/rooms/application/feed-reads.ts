import {
  AI_INHABITANT_LABELS,
  ROOM_FEED_POSTS_MAX,
  ReadRoomFeedSchema,
  ReplaceRoomMemorySchema,
  RoomFeedSchema,
  RoomMemoryReplacementSchema,
  type AiAuthor,
  type RoomFeedStrip,
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

const residentOf = (cast: readonly CastMember[], inhabitant: InhabitantId): AiAuthor => ({
  kind: 'ai',
  inhabitant,
  name: nameOf(cast, inhabitant),
  label: AI_INHABITANT_LABELS[inhabitant],
});

/** What a reader is told the residents remember: the words while they stand, nothing once they were erased. */
const memoryShown = (memory: MemoryView | undefined): RoomMemory =>
  memory?.state === 'ready' && memory.body !== null
    ? { state: 'ready', text: memory.body, by: memory.source === 'moderator' ? 'moderator' : 'residents' }
    : { state: 'none' };

/**
 * What the Now strip says of the feed: the newest find a reader may see, or nothing. A reader whose AI level is Off is told
 * nothing, because nothing a resident posts on its own reaches them. A find a moderator removed is not listed, so it is not here.
 */
export async function feedStrip(
  p: RoomPorts,
  lock: RoomLock,
  reader: { readonly aiLevel: AiLevel },
  cast: readonly CastMember[],
): Promise<RoomFeedStrip | undefined> {
  if (reader.aiLevel === 'off') return undefined;
  const [newest] = await p.feed.finds(lock, 1);
  return newest === undefined
    ? undefined
    : { by: residentOf(cast, newest.inhabitant), postedAt: newest.postedAt.toISOString() };
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
        const posts = rows.flatMap((row) => {
          const key = `${row.asset.assetId}:${String(row.asset.assetRevision)}`;
          const card: ContentCard = cardOf.get(key) ?? { status: 'unavailable', target: row.asset };
          return row.note === null
            ? []
            : [
                {
                  discussionId: row.discussionId,
                  author: residentOf(cast, row.inhabitant),
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
