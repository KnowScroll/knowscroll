import { z } from 'zod';
import { ConversationScopeSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { ROOM_STARS_PER_CONSTELLATION } from './room-sky.js';

/**
 * Flair (v3 R-11, R3 E5, D-342 to D-346): a small mark a person earns in one room by their own acts there. It is worked out when
 * it is read, by code, from rows that already exist; no model, no score and no total. It is for people only: an AI inhabitant,
 * a scout and a resident never earn one. It is not evidence for anyone and never feeds ranking, planning or formation (D-063).
 * "Called it" is not here: it counts calls in Scrolls, which a room never reads.
 */

const Version = z.literal('rooms.v1');
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };
const Command = { version: Version, commandId: CommandIdSchema };
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};

/**
 * What a person can earn, in the order a card lists it. `first_answer`: words in Today or in a question someone else left.
 * `good_question`: questions they left that someone found useful. `flaw_finder`: right taps on Spot the flaw. `launch_regular`:
 * Launches played in the days a Launch's answers are kept.
 */
export const ROOM_FLAIR_KINDS = ['first_answer', 'good_question', 'flaw_finder', 'launch_regular'] as const;
export const RoomFlairKindSchema = z.enum(ROOM_FLAIR_KINDS);
export type RoomFlairKind = z.infer<typeof RoomFlairKindSchema>;

/** A person's own choice of what shows beside their name: one flair they have earned, or `none` (hidden). Absent is automatic. */
export const RoomFlairChoiceSchema = z.enum([...ROOM_FLAIR_KINDS, 'none']);
export type RoomFlairChoice = z.infer<typeof RoomFlairChoiceSchema>;

/** Where a star sits among the seven of its constellation. A message that earned the room a star carries it (R3 F4). */
export const RoomMessageStarSchema = z.strictObject({
  place: z.number().int().min(1).max(ROOM_STARS_PER_CONSTELLATION),
});
export type RoomMessageStar = z.infer<typeof RoomMessageStarSchema>;

export const ReadRoomFlairSchema = z.strictObject({ ...Read, roomId: UuidSchema });

/**
 * A member's own flair card for one room (R3 E5): what they have earned, what they are partway to and what shows beside
 * their name. Only they read it: another member sees `flair` on a message and nothing else. `coming` lists a flair they have
 * started and not earned, with how far, only for a mark made of their own acts (never Good question, D-342); `of` is the rule's own number, so a screen never states one.
 */
export const RoomFlairViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    earned: z.array(RoomFlairKindSchema).max(ROOM_FLAIR_KINDS.length),
    coming: z
      .array(
        z.strictObject({
          flair: RoomFlairKindSchema,
          have: Counter,
          of: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(ROOM_FLAIR_KINDS.length),
    /** What they chose; absent while it is automatic. */
    choice: RoomFlairChoiceSchema.optional(),
    /** What others see beside their name now: absent when nothing shows (hidden, none earned, or the chosen one is not earned). */
    shown: RoomFlairKindSchema.optional(),
  }),
]);
export type RoomFlairView = z.infer<typeof RoomFlairViewSchema>;

/**
 * Chooses what shows beside the member's name: a flair they have earned, `none` to hide it, or `auto` for the first they have
 * earned in the card's order. The same choice again is accepted. A flair not earned is refused.
 */
export const ChooseRoomFlairSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  flair: z.enum([...ROOM_FLAIR_KINDS, 'none', 'auto']),
});
export const RoomFlairChosenAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.flair'),
  roomId: UuidSchema,
  flair: z.enum([...ROOM_FLAIR_KINDS, 'none', 'auto']),
});
