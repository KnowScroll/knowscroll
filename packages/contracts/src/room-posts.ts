import { z } from 'zod';
import { ConversationContentRefSchema, ConversationScopeSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { isPublicLabel } from './sharing.js';

/**
 * People's posts and votes in a room's Feed (v3 R-8b, T3 "Rooms with residents", D-271 to D-274). A member posts a find with their own
 * headline and words and one link: an admitted library Reel or Scroll, or a source (a plain http or https address, checked as text
 * and never fetched). Members vote up on any post. Agents (residents and scouts) have no account, so none can post as a person or
 * vote, and no answer lists who voted: a post carries a count, and whether the reader voted, to the reader only. A post and a vote
 * are conversation: neither is consumption evidence for anyone.
 */

const Version = z.literal('rooms.v1');
const Command = { version: Version, commandId: CommandIdSchema };
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};

/** The longest headline of a post: it is the discussion's title. */
export const ROOM_POST_TITLE_MAX_CHARS = 80;
/** The longest words under a headline. */
export const ROOM_POST_WORDS_MAX_CHARS = 500;
/** The longest source address kept. */
export const ROOM_SOURCE_MAX_CHARS = 500;

/**
 * How the Feed is ordered (D-274): `hot` is votes decayed by age, `new` is newest first, `top` is most votes among the posts of a
 * window. Rising is not offered: it rewards early pile-ons, and three sorts are enough in a small room.
 */
export const RoomFeedSortSchema = z.enum(['hot', 'new', 'top']);
export type RoomFeedSort = z.infer<typeof RoomFeedSortSchema>;
/** The posts `top` ranks: those made today, this week, this month, or any time. */
export const RoomFeedWindowSchema = z.enum(['day', 'week', 'month', 'all']);
export type RoomFeedWindow = z.infer<typeof RoomFeedWindowSchema>;

/**
 * A source as the Feed shows it: the plain address and the site's name for the words of the link. Never fetched, never previewed.
 * The address is http or https, so a client that makes it a link can never be handed another scheme.
 */
export const RoomSourceSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(ROOM_SOURCE_MAX_CHARS)
    .refine((url) => /^https?:\/\//i.test(url)),
  host: z.string().min(1).max(253),
});
export type RoomSource = z.infer<typeof RoomSourceSchema>;

/** What a post links: an admitted library Reel or Scroll, or one source. Never both, and never neither. */
export const RoomPostLinkInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('content'), target: ConversationContentRefSchema }),
  z.strictObject({
    kind: z.literal('source'),
    url: z
      .string()
      .min(1)
      .max(ROOM_SOURCE_MAX_CHARS * 2),
  }),
]);

const PostHeadline = z.string().min(1).max(ROOM_POST_TITLE_MAX_CHARS).refine(isPublicLabel);
const PostWords = z.string().min(1).max(ROOM_POST_WORDS_MAX_CHARS);

/**
 * A member posts a find to the room's Feed. The headline and the words are theirs; the link is a library asset (checked to be an
 * admitted, served Reel or Scroll) or a source (checked as text). No model is called for it, and nothing is posted unless the
 * member sends this. At most three posts a member a room a UTC day. The same command again is accepted.
 */
export const PostRoomFindSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  title: PostHeadline,
  words: PostWords,
  link: RoomPostLinkInputSchema,
});
export type PostRoomFind = z.infer<typeof PostRoomFindSchema>;

/**
 * `posted`: the post is in the Feed. `already_there`: the room already has a post about that asset or source; nothing was made and
 * `discussionId` is the existing one, so the member can open it. A post that fails a rule is refused as invalid input.
 */
export const RoomFindPostedAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.find-post'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  result: z.enum(['posted', 'already_there']),
});

/**
 * A member votes up on a post, or takes the vote back. One vote per member per post, up only: there is no down vote and no score
 * for a person. Refused for a member's own post. The same value again changes nothing.
 */
export const VoteRoomPostSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  voted: z.boolean(),
});
export const RoomPostVoteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.post-vote'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  voted: z.boolean(),
  /** The post's votes now: a number, never who. */
  votes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
