import { z } from 'zod';
import {
  ConversationContentProjectionSchema,
  ConversationContentRefSchema,
  ConversationScopeSchema,
  ConversationTextSchema,
} from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { PublicPersonRefSchema } from './sharing.js';
import { roomsPost } from './social-problems.js';
import { ResolvedSnippetAnchorSchema, SnippetAnchorSchema, SnippetCardSchema, ThreadEpisodeSchema } from './threads.js';

/**
 * Idea rooms (blueprint §17, D-051): a room bound to a library topic, the discussions held in it
 * and, in a discussion, the Reel or Scroll it is about. Rooms own their members, messages and
 * moderation. A room message is conversation, never consumption evidence: joining, chatting,
 * pinning and asking an AI inhabitant create no exposure, observation or Keep. No answer counts
 * members, shows who is online, or says what anyone has watched.
 *
 * AI inhabitants are labelled authors of their own kind (`kind: 'ai'`), never a person, and they
 * speak only when a member asks. A moderator's hidden message keeps its place and number.
 */
const Version = z.literal('rooms.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Limit = z.number().int().min(1).max(50);

function isPublicLabel(value: string): boolean {
  return (
    value.trim() === value &&
    [...value].every((character) => {
      const point = character.codePointAt(0)!;
      return point >= 32 && (point < 127 || point > 159);
    })
  );
}

export const RoomJoinRuleSchema = z.enum(['open', 'friends_of_members', 'invite_only']);
export type RoomJoinRule = z.infer<typeof RoomJoinRuleSchema>;
export const RoomStatusSchema = z.enum(['open', 'paused', 'closed']);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;
export const RoomRoleSchema = z.enum(['member', 'moderator']);
export type RoomRole = z.infer<typeof RoomRoleSchema>;

/** The AI inhabitants a room can have. Their words are suggestions; nothing they say makes content. */
export const InhabitantIdSchema = z.enum(['explainer', 'skeptic']);
export type InhabitantId = z.infer<typeof InhabitantIdSchema>;
/** What an inhabitant's contribution is: an explanation, or a challenge to an assumption, a perspective or a counterexample. */
export const AiContributionKindSchema = z.enum(['explanation', 'assumption', 'perspective', 'counterexample']);
export type AiContributionKind = z.infer<typeof AiContributionKindSchema>;

/** The label an inhabitant always carries. Fixed by the role, so no client can show one without it. */
export const AI_INHABITANT_LABELS = { explainer: 'AI · Explainer', skeptic: 'AI · Skeptic' } as const;
/** What each inhabitant is for, in the words the room preview shows. */
export const AI_INHABITANT_BLURBS = { explainer: 'Answers when asked', skeptic: 'Pushes back on claims' } as const;

export const RoomInhabitantSchema = z
  .strictObject({
    inhabitant: InhabitantIdSchema,
    label: z.string(),
    blurb: z.string().min(1).max(80),
  })
  .refine((entry) => entry.label === AI_INHABITANT_LABELS[entry.inhabitant]);
export type RoomInhabitant = z.infer<typeof RoomInhabitantSchema>;

/** An AI author. Explicitly not a person: it has no person ID, handle or profile. */
export const AiAuthorSchema = z
  .strictObject({ kind: z.literal('ai'), inhabitant: InhabitantIdSchema, label: z.string() })
  .refine((author) => author.label === AI_INHABITANT_LABELS[author.inhabitant]);
export type AiAuthor = z.infer<typeof AiAuthorSchema>;

const RoomName = z.string().min(1).max(80).refine(isPublicLabel);
const DiscussionTitle = z.string().min(1).max(80).refine(isPublicLabel);

export const RoomTopicSchema = z.strictObject({
  kind: z.enum(['system', 'planet']),
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
});

/** A room as lists and previews name it. No member, activity or online count, by design (R01). */
export const RoomSummarySchema = z.strictObject({
  roomId: UuidSchema,
  name: RoomName,
  description: z.string().min(1).max(400),
  topic: RoomTopicSchema,
  joinRule: RoomJoinRuleSchema,
  status: RoomStatusSchema,
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

/** A discussion in a room list: a content thread when it has a root, a plain discussion otherwise. */
export const RoomDiscussionSummarySchema = z.strictObject({
  discussionId: UuidSchema,
  title: DiscussionTitle,
  root: ConversationContentProjectionSchema.optional(),
  /** Absent once the starter's account was deleted. */
  startedBy: PublicPersonRefSchema.optional(),
  pinned: z.boolean(),
  lastActivityAt: z.iso.datetime(),
});
export type RoomDiscussionSummary = z.infer<typeof RoomDiscussionSummarySchema>;

/** Why a person cannot join now. `removed` and `closed` are not recoverable by the person; the rest are. */
export const RoomJoinBlockSchema = z.enum([
  'invite_only',
  'friend_of_member_needed',
  'profile_needed',
  'paused',
  'closed',
  'removed',
]);
export type RoomJoinBlock = z.infer<typeof RoomJoinBlockSchema>;

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
const continuation = <T extends z.ZodType>(cursor: T) =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('end') }),
    z.strictObject({ kind: z.literal('more'), cursor }),
  ]);

/** Opaque positions in one discussion, like the conversation cursors: they grant nothing and every read rechecks access. */
export const RoomHistoryCursorSchema = z.string().regex(/^krh1_[A-Za-z0-9_-]{22,1024}$/);
export const RoomChangesCursorSchema = z.string().regex(/^krc1_[A-Za-z0-9_-]{22,1024}$/);

// --- Lists and the room itself -------------------------------------------------------------

/** The rooms the caller belongs to or is invited to, for Talk. Rooms the caller has not joined are never listed here. */
export const ReadRoomListSchema = z.strictObject({ ...Read });
export const RoomListItemSchema = z.strictObject({
  room: RoomSummarySchema,
  standing: z.enum(['member', 'moderator', 'invited']),
});
export type RoomListItem = z.infer<typeof RoomListItemSchema>;
export const RoomListSchema = z.strictObject({
  ...ScopedRead,
  status: z.literal('ready'),
  items: z.array(RoomListItemSchema).max(100),
});

export const ReadRoomSchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomViewSchema = z.discriminatedUnion('status', [
  /** Not a room the caller may see: unknown, closed to outsiders, or an ended account. One shape for all. */
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  /** A room the caller has not joined: who it is for, the rules, and what holds them back, if anything. */
  z.strictObject({
    ...ScopedRead,
    status: z.literal('preview'),
    room: RoomSummarySchema,
    guidelines: z.string().min(1).max(600).optional(),
    hasModerator: z.boolean(),
    inhabitants: z.array(RoomInhabitantSchema).max(2),
    /** The pinned discussion's title, when a moderator pinned one. */
    pinned: DiscussionTitle.optional(),
    invited: z.boolean(),
    join: z.discriminatedUnion('allowed', [
      z.strictObject({ allowed: z.literal(true) }),
      z.strictObject({ allowed: z.literal(false), reason: RoomJoinBlockSchema }),
    ]),
  }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('member'),
    room: RoomSummarySchema,
    role: RoomRoleSchema,
    guidelines: z.string().min(1).max(600).optional(),
    hasModerator: z.boolean(),
    inhabitants: z.array(RoomInhabitantSchema).max(2),
    /** Pinned first, then newest activity. A paused room can still be read. */
    discussions: z.array(RoomDiscussionSummarySchema).max(50),
    canPost: z.boolean(),
  }),
]);
export type RoomView = z.infer<typeof RoomViewSchema>;

// --- Membership -----------------------------------------------------------------------------

export const JoinRoomSchema = z.strictObject({ ...Command, roomId: UuidSchema });
export const RoomJoinAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.join'),
  roomId: UuidSchema,
  role: RoomRoleSchema,
});
export const LeaveRoomSchema = z.strictObject({ ...Command, roomId: UuidSchema });
export const RoomLeaveAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.leave'),
  roomId: UuidSchema,
});
/** A member invites a current friend into the room. It names no one else and joins no one by itself. */
export const InviteToRoomSchema = z.strictObject({ ...Command, roomId: UuidSchema, friendPersonId: UuidSchema });
export const RoomInviteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.invite'),
  roomId: UuidSchema,
});

/** Moderator actions on the room itself. Each is checked against the caller's current role. */
export const RoomModerationActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pause') }),
  z.strictObject({ kind: z.literal('resume') }),
  /** Removes a person from the room. They can read nothing more and cannot join again. */
  z.strictObject({ kind: z.literal('remove_member'), personId: UuidSchema }),
]);
export const ModerateRoomSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  action: RoomModerationActionSchema,
});
export const RoomModerationAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.moderate'),
  roomId: UuidSchema,
  action: z.enum(['pause', 'resume', 'remove_member']),
});

// --- Discussions and messages ---------------------------------------------------------------

const MessageIdentity = { messageId: UuidSchema, sequence: Revision };
export const RoomAuthorSchema = z.discriminatedUnion('kind', [PublicPersonRefSchema, AiAuthorSchema]);
export type RoomAuthor = z.infer<typeof RoomAuthorSchema>;

export const RoomMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...MessageIdentity,
    status: z.literal('available'),
    author: RoomAuthorSchema,
    recordedAt: z.iso.datetime(),
    body: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
      z.strictObject({
        kind: z.literal('content'),
        content: ConversationContentProjectionSchema,
        note: ConversationTextSchema.optional(),
      }),
      z.strictObject({
        kind: z.literal('snippet'),
        snippet: SnippetCardSchema,
        note: ConversationTextSchema.optional(),
      }),
    ]),
    /** Present exactly when the author is an AI inhabitant. */
    suggestion: AiContributionKindSchema.optional(),
  }),
  /** A moderator removed it. It keeps its place; a moderator can restore it. */
  z.strictObject({ ...MessageIdentity, status: z.literal('removed') }),
  /** The author's account was deleted. */
  z.strictObject({ ...MessageIdentity, status: z.literal('unavailable') }),
]);
export type RoomMessage = z.infer<typeof RoomMessageSchema>;
const Messages = z
  .array(RoomMessageSchema)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((item) => item.messageId)).size === items.length &&
      items.every((item, index) => index === 0 || item.sequence > items[index - 1]!.sequence),
  );

/** Starts a discussion: about nothing in particular, about a Reel or Scroll, or from a card in another discussion of the room. */
export const StartDiscussionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('topic'), title: DiscussionTitle }),
  z.strictObject({ kind: z.literal('content'), root: ConversationContentRefSchema, title: DiscussionTitle.optional() }),
  z.strictObject({
    kind: z.literal('message'),
    discussionId: UuidSchema,
    messageId: UuidSchema,
    title: DiscussionTitle.optional(),
  }),
]);
export const CreateDiscussionSchema = z.strictObject({ ...Command, roomId: UuidSchema, start: StartDiscussionSchema });
export const DiscussionCreationSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('discussion.create'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
});

export const SendRoomBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
  z.strictObject({
    kind: z.literal('content'),
    target: ConversationContentRefSchema,
    note: ConversationTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('snippet'),
    target: ConversationContentRefSchema,
    anchor: SnippetAnchorSchema,
    note: ConversationTextSchema.optional(),
  }),
]);
export type SendRoomBody = z.infer<typeof SendRoomBodySchema>;
export const SendRoomMessageSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  body: SendRoomBodySchema,
});
export const RoomMessageAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('discussion.send'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
  messageSequence: Revision,
});

export const ReadDiscussionSchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  limit: Limit,
});

/** What the person can ask of an inhabitant right now. `resting` is the room's or the person's daily bound. */
export const RoomInhabitantStatusSchema = z.strictObject({
  inhabitant: InhabitantIdSchema,
  label: z.string(),
  blurb: z.string().min(1).max(80),
  ask: z.enum(['available', 'preparing', 'resting', 'paused']),
});

export type RoomInhabitantStatus = z.infer<typeof RoomInhabitantStatusSchema>;

export const DiscussionViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      room: RoomSummarySchema,
      role: RoomRoleSchema,
      /** The caller's own public profile, so a screen can set their messages apart. */
      you: PublicPersonRefSchema,
      discussion: z.strictObject({
        discussionId: UuidSchema,
        title: DiscussionTitle,
        pinned: z.boolean(),
        startedBy: PublicPersonRefSchema.optional(),
      }),
      /** Present when the discussion is a content thread: the root, its episodes and the caller's own visited markers. */
      content: z
        .strictObject({
          root: ConversationContentProjectionSchema,
          sequence: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('single') }),
            z.strictObject({ kind: z.literal('series'), total: z.number().int().min(1).max(99) }),
          ]),
          episodes: z.array(ThreadEpisodeSchema).min(1).max(99),
        })
        .optional(),
      canPost: z.boolean(),
      inhabitants: z.array(RoomInhabitantStatusSchema).max(2),
      /** The caller's own last ask that ended without a contribution, so the screen can say so. */
      yourAsk: z
        .strictObject({ inhabitant: InhabitantIdSchema, outcome: z.enum(['nothing_to_add', 'could_not_answer']) })
        .optional(),
      latestMessageSequence: Counter,
      messages: Messages,
      limit: Limit,
      history: continuation(RoomHistoryCursorSchema),
      catchUpCursor: RoomChangesCursorSchema,
    })
    .refine(
      (view) =>
        view.messages.length <= view.limit &&
        (view.latestMessageSequence === 0
          ? view.messages.length === 0
          : view.messages.at(-1)?.sequence === view.latestMessageSequence),
    ),
]);
export type DiscussionView = z.infer<typeof DiscussionViewSchema>;

export const ReadDiscussionHistorySchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  limit: Limit,
  cursor: RoomHistoryCursorSchema,
});
export const DiscussionHistoryPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({ ...ScopedRead, status: z.literal('refresh_required'), requestCursor: RoomHistoryCursorSchema }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      limit: Limit,
      requestCursor: RoomHistoryCursorSchema,
      messages: Messages,
      continuation: continuation(RoomHistoryCursorSchema),
    })
    .refine(
      (page) =>
        page.messages.length <= page.limit &&
        (page.continuation.kind !== 'more' || page.continuation.cursor !== page.requestCursor),
    ),
]);

export const ReadDiscussionChangesSchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  limit: Limit,
  cursor: RoomChangesCursorSchema,
});
export const DiscussionChangesPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({ ...ScopedRead, status: z.literal('refresh_required'), requestCursor: RoomChangesCursorSchema }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    limit: Limit,
    requestCursor: RoomChangesCursorSchema,
    changes: z.array(z.strictObject({ changeSequence: Revision, message: RoomMessageSchema })).max(50),
    continuation: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('more'), cursor: RoomChangesCursorSchema }),
      z.strictObject({ kind: z.literal('caught_up'), cursor: RoomChangesCursorSchema }),
    ]),
  }),
]);

/** Opens a snippet of a room discussion: where it points now (see the thread contract for the three answers). */
export const OpenRoomSnippetSchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
});
const OpenedContent = z.strictObject({
  kind: z.enum(['reel', 'scroll']),
  assetId: UuidSchema,
  assetRevision: Revision,
  title: z.string().min(1).max(240),
});
export const RoomSnippetOpeningSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    content: OpenedContent,
    anchor: ResolvedSnippetAnchorSchema,
    mapped: z.boolean(),
    settingsReset: z.boolean(),
  }),
  z.strictObject({ ...ScopedRead, status: z.literal('changed'), current: OpenedContent }),
]);
export type RoomSnippetOpening = z.infer<typeof RoomSnippetOpeningSchema>;

// --- Moderation -----------------------------------------------------------------------------

/** Pins a discussion at the top of the room, or lets it go. A pin changes nobody's universe, player or evidence. */
export const PinDiscussionSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  pinned: z.boolean(),
});
export const DiscussionPinAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('discussion.pin'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  pinned: z.boolean(),
});
/** Removes a message from view, or restores it. The message keeps its place and number. */
export const HideRoomMessageSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
  hidden: z.boolean(),
});
export const RoomMessageHidingAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('discussion.hide'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
  hidden: z.boolean(),
});

// --- AI inhabitants -------------------------------------------------------------------------

/**
 * Asks a labelled AI inhabitant to contribute to a discussion. The answer is a queued request: the
 * contribution, if any, arrives later as an ordinary message the discussion reads. The ask is
 * bounded per room and day and per person and day; nothing an inhabitant says starts production.
 */
export const AskInhabitantSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  inhabitant: InhabitantIdSchema,
});
export const InhabitantAskAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('inhabitant.ask'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  inhabitant: InhabitantIdSchema,
});

/** Served by the API's rooms controller, with Social's problem family and cache policy. */
export const roomsContract = {
  list: roomsPost('/v1/rooms/list', ReadRoomListSchema, RoomListSchema),
  read: roomsPost('/v1/rooms/read', ReadRoomSchema, RoomViewSchema),
  join: roomsPost('/v1/rooms/join', JoinRoomSchema, RoomJoinAcceptanceSchema),
  leave: roomsPost('/v1/rooms/leave', LeaveRoomSchema, RoomLeaveAcceptanceSchema),
  invite: roomsPost('/v1/rooms/invite', InviteToRoomSchema, RoomInviteAcceptanceSchema),
  moderate: roomsPost('/v1/rooms/moderate', ModerateRoomSchema, RoomModerationAcceptanceSchema),
  createDiscussion: roomsPost('/v1/rooms/discussions/create', CreateDiscussionSchema, DiscussionCreationSchema),
  readDiscussion: roomsPost('/v1/rooms/discussions/read', ReadDiscussionSchema, DiscussionViewSchema),
  history: roomsPost('/v1/rooms/discussions/history', ReadDiscussionHistorySchema, DiscussionHistoryPageSchema),
  changes: roomsPost('/v1/rooms/discussions/changes', ReadDiscussionChangesSchema, DiscussionChangesPageSchema),
  send: roomsPost('/v1/rooms/discussions/send', SendRoomMessageSchema, RoomMessageAcceptanceSchema),
  openSnippet: roomsPost('/v1/rooms/discussions/snippets/open', OpenRoomSnippetSchema, RoomSnippetOpeningSchema),
  pin: roomsPost('/v1/rooms/discussions/pin', PinDiscussionSchema, DiscussionPinAcceptanceSchema),
  hideMessage: roomsPost('/v1/rooms/discussions/hide', HideRoomMessageSchema, RoomMessageHidingAcceptanceSchema),
  askInhabitant: roomsPost('/v1/rooms/inhabitants/ask', AskInhabitantSchema, InhabitantAskAcceptanceSchema),
};
