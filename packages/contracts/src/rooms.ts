import { z } from 'zod';
import {
  ConversationContentProjectionSchema,
  ConversationContentRefSchema,
  ConversationScopeSchema,
  ConversationTextSchema,
} from './conversations.js';
import { AbuseCategorySchema } from './feedback.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { RoomIdentitySchema } from './room-identity.js';
import { NewDebateSchema, RoomDebateSchema, RoomNamingSchema, RoomSkySchema, RoomStarSchema } from './room-sky.js';
import { PublicPersonRefSchema } from './sharing.js';
import { roomsPost } from './social-problems.js';
import { ResolvedSnippetAnchorSchema, SnippetAnchorSchema, SnippetCardSchema, ThreadEpisodeSchema } from './threads.js';

/**
 * Idea rooms (blueprint §17, D-051): a room bound to a library topic, the discussions held in it
 * and, in a discussion, the Reel or Scroll it is about. Rooms own their members, messages and
 * moderation. A room message is conversation, never consumption evidence: joining, chatting,
 * pinning and asking an AI inhabitant create no exposure, observation or Keep. No answer says what
 * anyone has watched.
 *
 * Counts and presence follow D-069. The only count or activity fields a room may carry are these, each
 * on a member's own view of the room: `here.faces` (who has the room open, by public profile, never an AI
 * inhabitant), `here.count` (only from three people here), `memberTotal` and `lastMessageAt`. A list, a
 * preview and a station carry none of them, and no field says "online" with a number below three. The room's sky
 * (stars lit, finished constellations) is on a member's view and on a member's station only (D-176).
 *
 * AI inhabitants are labelled authors of their own kind (`kind: 'ai'`), never a person. They answer when a member
 * asks and, under the room's caps, speak on their own (D-068); a message they wrote on their own carries why. Each
 * has a name from a fixed catalogue, shown beside its label. A moderator's hidden message keeps its place and number.
 */
const Version = z.literal('rooms.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Limit = z.number().int().min(1).max(50);

/** A number of people here is shown from this many; below it the faces speak for themselves (D-069). */
export const ROOM_HERE_COUNT_FROM = 3;
/** How long one heartbeat keeps a person's face in the room. */
export const ROOM_PRESENCE_LEASE_MS = 60_000;
/** How often an open, visible room renews its lease: two missed beats end it. */
export const ROOM_PRESENCE_BEAT_MS = 25_000;
/** The most faces a room view carries; the count may be larger. */
export const ROOM_FACES_MAX = 12;
/** The most discussions a room view or a topics list carries. */
export const DISCUSSIONS_LISTED_MAX = 50;

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

/** A resident's own name, from a fixed catalogue (D-163). Never a person's: it always comes with the AI label. */
const ResidentName = z.string().min(1).max(24).refine(isPublicLabel);

/** Why a resident spoke on its own. The one-line "why" a screen shows is built from this, never from model text. */
export const RoomSpeechTriggerSchema = z.enum(['unanswered_question', 'overstated_claim', 'answer_overstated']);
export type RoomSpeechTrigger = z.infer<typeof RoomSpeechTriggerSchema>;

export const RoomInhabitantSchema = z
  .strictObject({
    inhabitant: InhabitantIdSchema,
    name: ResidentName,
    label: z.string(),
    blurb: z.string().min(1).max(80),
  })
  .refine((entry) => entry.label === AI_INHABITANT_LABELS[entry.inhabitant]);
export type RoomInhabitant = z.infer<typeof RoomInhabitantSchema>;

/** An AI author. Explicitly not a person: it has no person ID, handle or profile, and always carries its label. */
export const AiAuthorSchema = z
  .strictObject({ kind: z.literal('ai'), inhabitant: InhabitantIdSchema, name: ResidentName, label: z.string() })
  .refine((author) => author.label === AI_INHABITANT_LABELS[author.inhabitant]);
export type AiAuthor = z.infer<typeof AiAuthorSchema>;

const RoomName = z.string().min(1).max(80).refine(isPublicLabel);
const DiscussionTitle = z.string().min(1).max(80).refine(isPublicLabel);

export const RoomTopicSchema = z.strictObject({
  kind: z.enum(['system', 'planet']),
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
});

/** A room as lists and previews name it. No member, activity or online count: those are on a member's own view only (D-069). */
export const RoomSummarySchema = z.strictObject({
  roomId: UuidSchema,
  name: RoomName,
  description: z.string().min(1).max(400),
  topic: RoomTopicSchema,
  joinRule: RoomJoinRuleSchema,
  status: RoomStatusSchema,
  /** The room's face (D-170): its emblem, palette, motif, motion and cast skins, and an approved painted backdrop if any. */
  identity: RoomIdentitySchema.optional(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

/**
 * What a discussion is for. Every room has one `general`, its place to talk, made with the room. A `topic` is
 * any other discussion, and `today` is the daily channel (reserved: nothing creates one yet).
 */
export const RoomDiscussionKindSchema = z.enum(['general', 'topic', 'today']);
export type RoomDiscussionKind = z.infer<typeof RoomDiscussionKindSchema>;

/**
 * What a topic is, from a closed list (D-167): a question, a debate, an explainer or something shared. A tag is a label the
 * starter picks; it gives a topic no behaviour of its own, and a topic need not have one.
 */
export const RoomTopicTagSchema = z.enum(['question', 'debate', 'explainer', 'share']);
export type RoomTopicTag = z.infer<typeof RoomTopicTagSchema>;

/**
 * What a member asked of a resident (D-167): the plain `ask` of a discussion, a `challenge` (the Skeptic tests one
 * message), the `other_side` (the Skeptic argues the opposite of one message), `about` (the Explainer answers one
 * message) or a `mention` (an @name in a message). An asked turn never counts against the unprompted caps.
 */
export const RoomAskKindSchema = z.enum(['ask', 'challenge', 'other_side', 'about', 'mention']);
export type RoomAskKind = z.infer<typeof RoomAskKindSchema>;

/** How much a room's AI inhabitants may speak to one member: Lively, Quieter or Off (R3 question 5). */
export const RoomAiLevelSchema = z.enum(['lively', 'quieter', 'off']);
export type RoomAiLevel = z.infer<typeof RoomAiLevelSchema>;

/** A discussion in a room list: a content thread when it has a root, a plain discussion otherwise. */
export const RoomDiscussionSummarySchema = z.strictObject({
  discussionId: UuidSchema,
  kind: RoomDiscussionKindSchema,
  title: DiscussionTitle,
  tag: RoomTopicTagSchema.optional(),
  root: ConversationContentProjectionSchema.optional(),
  /** Absent once the starter's account was deleted. */
  startedBy: PublicPersonRefSchema.optional(),
  pinned: z.boolean(),
  lastActivityAt: z.iso.datetime(),
  /** Messages in it that are shown (not removed, not a deleted account's). */
  replyCount: Counter,
  /** Who spoke last, when the reader may be told: the name only, and whether it is a resident. Absent when the reader blocked them. */
  lastReplyBy: z.strictObject({ name: z.string().min(1).max(80), ai: z.boolean() }).optional(),
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

// --- Today and the sky (v3 R-5) --------------------------------------------------------------

const Sentence = z.string().min(1).max(320).refine(isPublicLabel);
const FlawIndex = z.number().int().min(0).max(4);

/**
 * What the Now strip says of today (R3 B): the room's Today discussion, and, when an operator approved them, the day's
 * question and whether there is a Spot the flaw. Nothing here is a count.
 */
export const RoomTodayStripSchema = z.strictObject({
  discussionId: UuidSchema,
  prompt: z.string().min(1).max(200).refine(isPublicLabel).optional(),
  flaw: z.boolean(),
});
export type RoomTodayStrip = z.infer<typeof RoomTodayStripSchema>;

/**
 * The day's question: a template filled from a library Scroll, never a model's words, and the Scroll it points at. A
 * resident asks it and says so; the answers are messages in the Today discussion.
 */
export const RoomTodayQuestionSchema = z.strictObject({
  ritualId: UuidSchema,
  prompt: z.string().min(1).max(200).refine(isPublicLabel),
  detail: z.string().min(1).max(300).refine(isPublicLabel).optional(),
  by: AiAuthorSchema,
  source: ConversationContentProjectionSchema,
  /** How many people's messages in Today answer it so far: a real count, shown only as a number of answers. */
  answers: Counter,
});
export type RoomTodayQuestion = z.infer<typeof RoomTodayQuestionSchema>;

const FlawBase = { ritualId: UuidSchema, by: AiAuthorSchema, sentences: z.array(Sentence).min(3).max(5) };

/**
 * Spot the flaw: a passage of a library Scroll with one sentence altered. The key stays on the server until the reader has
 * tapped; the tap is final. After it the reader sees which sentence was altered, the Scroll's own sentence and the Scroll.
 */
export const RoomTodayFlawSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('open'), ...FlawBase }),
  z.strictObject({
    state: z.literal('done'),
    ...FlawBase,
    yourPick: FlawIndex,
    correct: z.boolean(),
    flawIndex: FlawIndex,
    original: Sentence,
    source: ConversationContentProjectionSchema,
    /** How many people found it, for a reader who has tapped. */
    found: Counter,
  }),
]);
export type RoomTodayFlaw = z.infer<typeof RoomTodayFlawSchema>;

export const ReadRoomTodaySchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomTodaySchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    /** The UTC day these items are for. */
    day: z.iso.date(),
    discussionId: UuidSchema,
    canPost: z.boolean(),
    question: RoomTodayQuestionSchema.optional(),
    flaw: RoomTodayFlawSchema.optional(),
    /** The questions of the days before, newest first. */
    past: z
      .array(z.strictObject({ day: z.iso.date(), prompt: z.string().min(1).max(200).refine(isPublicLabel) }))
      .max(7),
  }),
]);
export type RoomToday = z.infer<typeof RoomTodaySchema>;

/** The reader taps one sentence. Final: a second command for the same item is the first one's answer. */
export const SolveFlawSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  ritualId: UuidSchema,
  sentence: FlawIndex,
});
export const FlawSolvedAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('today.solve'),
  roomId: UuidSchema,
  ritualId: UuidSchema,
  correct: z.boolean(),
  flawIndex: FlawIndex,
  original: Sentence,
  /** This tap earned the room a star: the first right answer of the day, within the daily cap. */
  star: z.boolean(),
});

/** A member reads the room's sky: the stars, the constellation, and the name vote while one is open. */
export const ReadRoomSkySchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomSkyViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    sky: RoomSkySchema,
    /** The newest stars first: the moment each was made, with no person in it. */
    stars: z.array(RoomStarSchema).max(28),
    /** Present while the latest finished constellation has no name. */
    naming: RoomNamingSchema.optional(),
  }),
]);
export type RoomSkyView = z.infer<typeof RoomSkyViewSchema>;

/** A member chooses one of the three names offered for the constellation being named; they may change it until it closes. */
export const NameConstellationSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  candidate: z.number().int().min(0).max(2),
});
export const ConstellationVoteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('sky.name'),
  roomId: UuidSchema,
  candidate: z.number().int().min(0).max(2),
});

/** A member votes on a debate's side, and may change it until it closes. */
export const VoteDebateSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  side: z.enum(['a', 'b']),
});
export const DebateVoteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('debate.vote'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  side: z.enum(['a', 'b']),
});

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

/** The caller's own place in a room: their AI level, whether their messages are kept out of what AI reads, and the notice. */
export const RoomYouSchema = z.strictObject({
  aiLevel: RoomAiLevelSchema,
  /** Their messages are replaced by a placeholder before any model reads the room (R3 question 6). */
  keepOut: z.boolean(),
  /** When they acknowledged the AI notice; absent until they do, and then the notice shows only in the room menu. */
  noticeSeenAt: z.iso.datetime().optional(),
});
export type RoomYou = z.infer<typeof RoomYouSchema>;

/** One person who has the room open. `you` marks the caller's own face. */
export const RoomFaceSchema = z.strictObject({ person: PublicPersonRefSchema, you: z.boolean() });
export type RoomFace = z.infer<typeof RoomFaceSchema>;

/**
 * Who is here (D-069). Faces always; `count` only when three or more people are here, so "0 online" and
 * "1 online" cannot be said. The AI cast is never in either. A blocked person is left out of both for the blocker.
 */
export const RoomHereSchema = z
  .strictObject({
    faces: z.array(RoomFaceSchema).max(ROOM_FACES_MAX),
    count: z.number().int().min(ROOM_HERE_COUNT_FROM).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((here) =>
    here.count === undefined
      ? here.faces.length < ROOM_HERE_COUNT_FROM
      : here.faces.length >= ROOM_HERE_COUNT_FROM && here.count >= here.faces.length,
  );
export type RoomHere = z.infer<typeof RoomHereSchema>;

/**
 * What the room's AI may do, as the rules in force say it (D-068, D-167). Shown to every member in the room menu. Asked
 * turns have their own bounds and never count against the unprompted ones.
 */
export const RoomLimitsSchema = z.strictObject({
  asked: z.strictObject({
    perPersonPerHour: z.number().int().positive(),
    perRoomPerDay: z.number().int().positive(),
  }),
  unprompted: z.strictObject({
    /** One unprompted turn per this many human messages. */
    humanMessagesPerTurn: z.number().int().positive(),
    perHour: z.number().int().positive(),
    perDay: z.number().int().positive(),
    explainerPerHour: z.number().int().positive(),
    skepticPerHour: z.number().int().positive(),
  }),
});
export type RoomLimits = z.infer<typeof RoomLimitsSchema>;

/**
 * The welcome a resident gives a member who has not yet read the AI notice. A template filled from the room's own name
 * and topic: it is not a model's words and costs no call (D-168).
 */
export const RoomWelcomeSchema = z.strictObject({
  resident: AiAuthorSchema,
  text: z.string().min(1).max(400),
});
export type RoomWelcome = z.infer<typeof RoomWelcomeSchema>;

/**
 * "While you were away": what a resident wrote, once for a window, for members who came back after a long absence
 * (D-169). It is the resident's own and labelled; `since` is when this member left, `coversFrom` where the words start.
 * Present only for the member it was written for, until they dismiss it; absent for a member whose AI level is Off.
 */
export const RoomAwaySchema = z
  .strictObject({
    resident: AiAuthorSchema,
    since: z.iso.datetime(),
    state: z.enum(['preparing', 'ready']),
    text: z.string().min(1).max(1200).optional(),
    coversFrom: z.iso.datetime().optional(),
    /** The reader's level is Quieter: show one line, the words on request. */
    folded: z.literal(true).optional(),
  })
  .refine((away) => (away.state === 'ready') === (away.text !== undefined));
export type RoomAway = z.infer<typeof RoomAwaySchema>;

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
    inhabitants: z.array(RoomInhabitantSchema).max(4),
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
    inhabitants: z.array(RoomInhabitantSchema).max(4),
    /** The room's General: where a member lands. It is not in `discussions`. */
    general: RoomDiscussionSummarySchema,
    /** The other discussions: pinned first, then newest activity. A paused room can still be read. */
    discussions: z.array(RoomDiscussionSummarySchema).max(DISCUSSIONS_LISTED_MAX),
    canPost: z.boolean(),
    /** The caller's own settings in this room. */
    you: RoomYouSchema,
    /** Who has the room open now. Never an AI inhabitant, never a person the caller has blocked. */
    here: RoomHereSchema,
    /** How many current members the room has, for the room menu. */
    memberTotal: Counter,
    /** When the newest visible message was sent, anywhere in the room; absent while nobody has written. */
    lastMessageAt: z.iso.datetime().optional(),
    /** The bounds on what the room's AI may do, for the room menu. */
    limits: RoomLimitsSchema,
    /** A resident's welcome, until the member has read the AI notice. */
    welcome: RoomWelcomeSchema.optional(),
    /** A resident's "while you were away", for a member who came back after a long absence. */
    away: RoomAwaySchema.optional(),
    /** The room's sky: stars lit, the constellation and its name (D-174). */
    sky: RoomSkySchema,
    /** The daily channel and, when an operator approved today's items, what they are (v3 R-5). */
    today: RoomTodayStripSchema.optional(),
  }),
]);
export type RoomView = z.infer<typeof RoomViewSchema>;
export type RoomReports = z.infer<typeof RoomReportsSchema>;

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

/**
 * Changes the caller's own settings in a room: the AI level, whether their messages are kept out of what AI
 * reads, and that they have read the AI notice. Each field is optional and the same value again is accepted, so a
 * retry or a second tap is harmless. At least one field is required.
 */
export const SetRoomPreferencesSchema = z
  .strictObject({
    ...Command,
    roomId: UuidSchema,
    aiLevel: RoomAiLevelSchema.optional(),
    keepOut: z.boolean().optional(),
    /** Only ever `true`: an acknowledged notice is not taken back. */
    noticeSeen: z.literal(true).optional(),
  })
  .refine((command) => command.aiLevel !== undefined || command.keepOut !== undefined || command.noticeSeen === true);
export const RoomPreferencesAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.preferences'),
  roomId: UuidSchema,
  you: RoomYouSchema,
});

/**
 * Says whether the caller has the room open (`here`) or has left it (`away`). A device sends `here` when it opens a
 * room and every `ROOM_PRESENCE_BEAT_MS` while the room is visible, and `away` when it closes it; a lease that is
 * not renewed ends on its own after `ROOM_PRESENCE_LEASE_MS`. Not a command: there is no receipt, a repeat changes
 * nothing, and a person who is not a member is told the room is unavailable.
 */
export const SetRoomPresenceSchema = z.strictObject({
  version: Version,
  roomId: UuidSchema,
  state: z.enum(['here', 'away']),
});
export const RoomPresenceAckSchema = z.strictObject({
  version: Version,
  scope: ConversationScopeSchema,
  roomId: UuidSchema,
  state: z.enum(['here', 'away']),
});

// --- Discussions and messages ---------------------------------------------------------------

const MessageIdentity = { messageId: UuidSchema, sequence: Revision };
export const RoomAuthorSchema = z.discriminatedUnion('kind', [PublicPersonRefSchema, AiAuthorSchema]);
export type RoomAuthor = z.infer<typeof RoomAuthorSchema>;

/** What a member asked that a resident's message answers: the kind, who asked and which message it was about (D-167). */
export const RoomMessageAskSchema = z.strictObject({
  kind: RoomAskKindSchema,
  /** Absent once the asker's account was deleted, and when the reader has blocked them. */
  by: PublicPersonRefSchema.optional(),
  /** The message the ask pointed at, when it pointed at one. */
  about: UuidSchema.optional(),
});
export type RoomMessageAsk = z.infer<typeof RoomMessageAskSchema>;

/** A topic named by a card in the discussion it began from: its title and tag. Its figures are the room list's. */
export const RoomTopicCardSchema = z.strictObject({
  discussionId: UuidSchema,
  title: DiscussionTitle,
  tag: RoomTopicTagSchema.optional(),
});

export const RoomMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...MessageIdentity,
    status: z.literal('available'),
    author: RoomAuthorSchema,
    recordedAt: z.iso.datetime(),
    body: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
      z.strictObject({ kind: z.literal('topic'), topic: RoomTopicCardSchema }),
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
    /**
     * Present when a resident spoke on its own, and says why. A resident that answered an ask has none. A
     * reader whose AI level is Off receives `muted` instead.
     */
    trigger: RoomSpeechTriggerSchema.optional(),
    /** Present on a resident's message that answered a member's ask; a resident that spoke on its own has `trigger` instead. */
    ask: RoomMessageAskSchema.optional(),
    /** The reader's AI level is Quieter and this is a resident speaking on its own: show one line, the words on request. */
    folded: z.literal(true).optional(),
    /** The reader marked this message Useful. No count is ever sent with a message, and an author is never told who marked theirs. */
    usefulByYou: z.literal(true).optional(),
    /**
     * The reader is a moderator who has blocked the author. A block collapses the author's words for the
     * reader (`blocked`), but a moderator must still be able to moderate them, so the words are sent and
     * the client keeps them collapsed until the moderator chooses to show them.
     */
    blockedByYou: z.literal(true).optional(),
  }),
  /** A moderator removed it. It keeps its place; a moderator can restore it. */
  z.strictObject({ ...MessageIdentity, status: z.literal('removed') }),
  /** Written by someone the reader has blocked: collapsed for the reader, shown as usual to everyone else (D-051). */
  z.strictObject({ ...MessageIdentity, status: z.literal('blocked') }),
  /**
   * A resident spoke on its own and the reader's AI level is Off: the words are not sent. It keeps its place and
   * number, and a screen draws nothing for it.
   */
  z.strictObject({ ...MessageIdentity, status: z.literal('muted') }),
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
  z.strictObject({
    kind: z.literal('topic'),
    title: DiscussionTitle,
    tag: RoomTopicTagSchema.optional(),
    /** Two sides and a close time: required for the tag `debate` and refused for any other (D-176). */
    debate: NewDebateSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('content'), root: ConversationContentRefSchema, title: DiscussionTitle.optional() }),
  /**
   * From a message of the room. A card for a Reel or Scroll starts a content thread about it; a message with words
   * starts a topic that begins with that message and leaves a card where it was (D-167).
   */
  z.strictObject({
    kind: z.literal('message'),
    discussionId: UuidSchema,
    messageId: UuidSchema,
    title: DiscussionTitle.optional(),
    tag: RoomTopicTagSchema.optional(),
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
  name: ResidentName,
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
        kind: RoomDiscussionKindSchema,
        title: DiscussionTitle,
        tag: RoomTopicTagSchema.optional(),
        pinned: z.boolean(),
        startedBy: PublicPersonRefSchema.optional(),
      }),
      /** The message a topic began from, as this reader may see it: its first item. Absent for any other discussion. */
      origin: RoomMessageSchema.optional(),
      /** The debate this topic is: its sides, when it closes and the reader's own vote. */
      debate: RoomDebateSchema.optional(),
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
      inhabitants: z.array(RoomInhabitantStatusSchema).max(4),
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
// --- Reports on room messages -----------------------------------------------------------------

export const ReadRoomReportsSchema = z.strictObject({ version: Version, readId: UuidSchema, roomId: UuidSchema });

/**
 * What a room's moderators may see of reports (P03, D-055): which messages in their room were reported,
 * why and when. Never who reported, what they wrote, or a report about the moderator's own message.
 * Reading it creates nothing and tells nobody.
 */
export const RoomReportsSchema = z.strictObject({
  version: Version,
  scope: ConversationScopeSchema,
  readId: UuidSchema,
  roomId: UuidSchema,
  /** Newest report first. */
  reports: z
    .array(
      z.strictObject({
        messageId: UuidSchema,
        discussionId: UuidSchema,
        discussionTitle: z.string().min(1).max(80),
        /** The message's number in its discussion. */
        sequence: Revision,
        /** How many different people reported it. */
        count: z.number().int().min(1),
        categories: z.array(AbuseCategorySchema).min(1).max(7),
        /** The start of the UTC day of the newest report: the day, never the time. */
        lastReportedAt: z.iso.datetime(),
      }),
    )
    .max(50),
});

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

// --- Stations on the map --------------------------------------------------------------------

/**
 * The room stations of the caller's own map (U01, U02): a room whose topic is a system (or a planet)
 * the caller's Geography has established, placed beside that place. A placement is personal (the same
 * room can sit beside different places on different maps) and is not membership: it exists because
 * the person's own map holds the topic, and it says nothing about who is in the room. No answer
 * counts members or shows who is online.
 */
export const ReadRoomStationsSchema = z.strictObject({ ...Read });
export const RoomStationSchema = z.strictObject({
  room: RoomSummarySchema,
  /** `none` is an outsider: the station opens the room's preview. */
  standing: z.enum(['member', 'moderator', 'invited', 'none']),
  /** The caller's own objects the station sits beside: always a system, and the planet when the topic is one. */
  placement: z.strictObject({ systemId: UuidSchema, planetId: UuidSchema.optional() }),
  /**
   * The room's sky, for a member or moderator of the room only (D-174): stars lit, whether a constellation is finished and
   * its name. Room-level facts that name no person; an outsider's station carries none.
   */
  sky: RoomSkySchema.optional(),
});
export type RoomStation = z.infer<typeof RoomStationSchema>;
export const RoomStationsSchema = z.strictObject({
  ...ScopedRead,
  status: z.literal('ready'),
  stations: z.array(RoomStationSchema).max(100),
});

// --- Optional room activity (R03) -----------------------------------------------------------

/**
 * A moderator's poll or quiz, inside one room and only there: never in a feed, never required, never
 * scored, never part of how a universe forms. A poll's votes are visible to the room and can be changed
 * until the moderator closes it. A quiz is read one question at a time and answered on the device: the
 * server stores no answer, no score and no position, so there is nothing to rank or to resume.
 */
const ActivityPrompt = z.string().min(1).max(160).refine(isPublicLabel);
const OptionText = z.string().min(1).max(80).refine(isPublicLabel);
const OptionId = z.string().regex(/^o[1-5]$/);
const UniqueOptions = (options: readonly string[]) =>
  new Set(options.map((o) => o.toLowerCase())).size === options.length;
const Explanation = z.strictObject({
  heading: z.string().min(1).max(80).refine(isPublicLabel),
  text: z.string().min(1).max(240).refine(isPublicLabel),
  note: z.string().min(1).max(160).refine(isPublicLabel).optional(),
});
const QuizQuestionInput = z.strictObject({
  prompt: ActivityPrompt,
  options: z.array(OptionText).min(2).max(4).refine(UniqueOptions),
  explanation: Explanation,
});

export const NewActivitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('poll'),
    prompt: ActivityPrompt,
    options: z.array(OptionText).min(2).max(5).refine(UniqueOptions),
  }),
  z.strictObject({
    kind: z.literal('quiz'),
    title: ActivityPrompt,
    questions: z.array(QuizQuestionInput).min(1).max(5),
  }),
]);
export type NewActivity = z.infer<typeof NewActivitySchema>;
export const CreateActivitySchema = z.strictObject({ ...Command, roomId: UuidSchema, activity: NewActivitySchema });
export const ActivityCreationSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('activity.create'),
  roomId: UuidSchema,
  activityId: UuidSchema,
});

export const ActivityStateSchema = z.enum(['open', 'closed']);
export const RoomActivitySummarySchema = z.strictObject({
  activityId: UuidSchema,
  kind: z.enum(['poll', 'quiz']),
  title: ActivityPrompt,
  state: ActivityStateSchema,
  startedAt: z.iso.datetime(),
  /** For a poll, whether the caller has voted. Absent for a quiz, which keeps nothing about the caller. */
  voted: z.boolean().optional(),
});
export type RoomActivitySummary = z.infer<typeof RoomActivitySummarySchema>;

/** Open activities first, then closed ones, newest first. A moderator's removed activity is not listed. */
export const ReadActivitiesSchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const ActivityListSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    roomId: UuidSchema,
    /** The caller may start one: a moderator of a room that is open. */
    canCreate: z.boolean(),
    activities: z.array(RoomActivitySummarySchema).max(30),
  }),
]);

export const ReadActivitySchema = z.strictObject({ ...Read, roomId: UuidSchema, activityId: UuidSchema });
const PollOptionView = z.strictObject({
  optionId: OptionId,
  text: OptionText,
  /**
   * Present only while the poll's results are visible (the caller has voted, or the poll is closed): a
   * member who has not voted yet is not shown how others voted, so the tally never leads their choice.
   */
  votes: Counter.optional(),
  /** The first voters, by public profile: a vote is visible to the room once results are. */
  voters: z.array(PublicPersonRefSchema).max(12).optional(),
});
export const ActivityViewSchema = z.discriminatedUnion('status', [
  /** Unknown, removed by a moderator, or not a room the caller may read: one shape for all. */
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    roomId: UuidSchema,
    activityId: UuidSchema,
    state: ActivityStateSchema,
    startedAt: z.iso.datetime(),
    /** The caller is a moderator: they may close or remove it. */
    canModerate: z.boolean(),
    activity: z.discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('poll'),
          prompt: ActivityPrompt,
          /** The caller has voted or the poll is closed: tallies and voters follow. Otherwise they are absent. */
          resultsVisible: z.boolean(),
          options: z.array(PollOptionView).min(2).max(5),
          yourVote: OptionId.optional(),
          /** Open, in a room that accepts posts, for a member. */
          canVote: z.boolean(),
        })
        .refine((poll) =>
          poll.options.every((option) =>
            poll.resultsVisible
              ? option.votes !== undefined && option.voters !== undefined
              : option.votes === undefined && option.voters === undefined,
          ),
        ),
      z.strictObject({
        kind: z.literal('quiz'),
        title: ActivityPrompt,
        questions: z
          .array(
            z.strictObject({
              questionId: z.string().regex(/^q[1-5]$/),
              prompt: ActivityPrompt,
              options: z
                .array(z.strictObject({ optionId: OptionId, text: OptionText }))
                .min(2)
                .max(4),
              explanation: Explanation,
            }),
          )
          .min(1)
          .max(5),
      }),
    ]),
  }),
]);
export type ActivityView = z.infer<typeof ActivityViewSchema>;

export const VotePollSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  activityId: UuidSchema,
  optionId: OptionId,
});
export const PollVoteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('poll.vote'),
  roomId: UuidSchema,
  activityId: UuidSchema,
  optionId: OptionId,
});

export const ModerateActivitySchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  activityId: UuidSchema,
  action: z.enum(['close', 'remove']),
});
export const ActivityModerationAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('activity.moderate'),
  roomId: UuidSchema,
  activityId: UuidSchema,
  action: z.enum(['close', 'remove']),
});

// --- AI inhabitants -------------------------------------------------------------------------

/**
 * Asks a labelled AI inhabitant to contribute to a discussion. The answer is a queued request: the
 * contribution, if any, arrives later as an ordinary message the discussion reads. A plain ask names the
 * resident (`inhabitant`); a challenge, the other side or an ask about a message names the message (`about`),
 * and the kind decides the resident: the Skeptic tests or argues against it, the Explainer answers it. The ask is
 * bounded per person and hour and per room and day, apart from the unprompted caps; nothing an inhabitant says
 * starts production.
 */
export const AskInhabitantSchema = z
  .strictObject({
    ...Command,
    roomId: UuidSchema,
    discussionId: UuidSchema,
    inhabitant: InhabitantIdSchema.optional(),
    about: z.strictObject({ kind: z.enum(['challenge', 'other_side', 'about']), messageId: UuidSchema }).optional(),
  })
  .refine((command) => (command.inhabitant === undefined) !== (command.about === undefined));
export const InhabitantAskAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('inhabitant.ask'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  inhabitant: InhabitantIdSchema,
  kind: RoomAskKindSchema,
});

// --- Topics and Useful ----------------------------------------------------------------------

/** How the list of topics is ordered: pinned ones first, then Hot (a code formula), the newest, or those no one else has answered. */
export const RoomTopicSortSchema = z.enum(['hot', 'new', 'unanswered']);
export type RoomTopicSort = z.infer<typeof RoomTopicSortSchema>;

/** A room's topics as a forum list (R3 B2). Reading it creates nothing and tells nobody. */
export const ReadRoomTopicsSchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  sort: RoomTopicSortSchema,
  tag: RoomTopicTagSchema.optional(),
});
/**
 * A topic in the list: the discussion's own summary, how many people marked answers in it Useful, and whether anyone
 * but its starter has spoken in it. `usefulCount` is the only count of Useful marks any answer carries: it sits on a
 * topic of the list and on nothing a message's author reads.
 */
export const RoomTopicItemSchema = RoomDiscussionSummarySchema.extend({
  usefulCount: Counter,
  answered: z.boolean(),
});
export type RoomTopicItem = z.infer<typeof RoomTopicItemSchema>;
export const RoomTopicsSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    roomId: UuidSchema,
    sort: RoomTopicSortSchema,
    canPost: z.boolean(),
    topics: z.array(RoomTopicItemSchema).max(DISCUSSIONS_LISTED_MAX),
  }),
]);

/**
 * Marks a message Useful, or takes the mark back (R3 B2). One mark per member per message, never on one's own message,
 * and there is no downvote. The same value again is accepted. It is conversation, never evidence.
 */
export const MarkUsefulSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
  useful: z.boolean(),
});
export const UsefulAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('message.useful'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  messageId: UuidSchema,
  useful: z.boolean(),
});

/** The member has read their "while you were away"; it is not shown again. The same command again is accepted. */
export const DismissAwaySchema = z.strictObject({ ...Command, roomId: UuidSchema });
export const AwayDismissalSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('room.away-dismiss'),
  roomId: UuidSchema,
});

/** The room, who is in it and what a member sets for themselves. */
export const roomsRoomContract = {
  list: roomsPost('/v1/rooms/list', ReadRoomListSchema, RoomListSchema),
  read: roomsPost('/v1/rooms/read', ReadRoomSchema, RoomViewSchema),
  join: roomsPost('/v1/rooms/join', JoinRoomSchema, RoomJoinAcceptanceSchema),
  leave: roomsPost('/v1/rooms/leave', LeaveRoomSchema, RoomLeaveAcceptanceSchema),
  invite: roomsPost('/v1/rooms/invite', InviteToRoomSchema, RoomInviteAcceptanceSchema),
  preferences: roomsPost('/v1/rooms/preferences', SetRoomPreferencesSchema, RoomPreferencesAcceptanceSchema),
  presence: roomsPost('/v1/rooms/presence', SetRoomPresenceSchema, RoomPresenceAckSchema),
  dismissAway: roomsPost('/v1/rooms/away/dismiss', DismissAwaySchema, AwayDismissalSchema),
  topics: roomsPost('/v1/rooms/topics/list', ReadRoomTopicsSchema, RoomTopicsSchema),
  moderate: roomsPost('/v1/rooms/moderate', ModerateRoomSchema, RoomModerationAcceptanceSchema),
  reports: roomsPost('/v1/rooms/reports', ReadRoomReportsSchema, RoomReportsSchema),
  stations: roomsPost('/v1/rooms/stations', ReadRoomStationsSchema, RoomStationsSchema),
};

/** Discussions, their messages and the labelled AI inhabitants. */
export const roomsDiscussionContract = {
  createDiscussion: roomsPost('/v1/rooms/discussions/create', CreateDiscussionSchema, DiscussionCreationSchema),
  readDiscussion: roomsPost('/v1/rooms/discussions/read', ReadDiscussionSchema, DiscussionViewSchema),
  history: roomsPost('/v1/rooms/discussions/history', ReadDiscussionHistorySchema, DiscussionHistoryPageSchema),
  changes: roomsPost('/v1/rooms/discussions/changes', ReadDiscussionChangesSchema, DiscussionChangesPageSchema),
  send: roomsPost('/v1/rooms/discussions/send', SendRoomMessageSchema, RoomMessageAcceptanceSchema),
  openSnippet: roomsPost('/v1/rooms/discussions/snippets/open', OpenRoomSnippetSchema, RoomSnippetOpeningSchema),
  pin: roomsPost('/v1/rooms/discussions/pin', PinDiscussionSchema, DiscussionPinAcceptanceSchema),
  hideMessage: roomsPost('/v1/rooms/discussions/hide', HideRoomMessageSchema, RoomMessageHidingAcceptanceSchema),
  markUseful: roomsPost('/v1/rooms/discussions/useful', MarkUsefulSchema, UsefulAcceptanceSchema),
  askInhabitant: roomsPost('/v1/rooms/inhabitants/ask', AskInhabitantSchema, InhabitantAskAcceptanceSchema),
};

/** A moderator's polls and quizzes (R03). */
export const roomsActivityContract = {
  activities: roomsPost('/v1/rooms/activities/list', ReadActivitiesSchema, ActivityListSchema),
  readActivity: roomsPost('/v1/rooms/activities/read', ReadActivitySchema, ActivityViewSchema),
  createActivity: roomsPost('/v1/rooms/activities/create', CreateActivitySchema, ActivityCreationSchema),
  votePoll: roomsPost('/v1/rooms/activities/vote', VotePollSchema, PollVoteAcceptanceSchema),
  moderateActivity: roomsPost(
    '/v1/rooms/activities/moderate',
    ModerateActivitySchema,
    ActivityModerationAcceptanceSchema,
  ),
};

/** Today's items, the room's sky and a debate's vote (v3 R-5). */
export const roomsSkyContract = {
  today: roomsPost('/v1/rooms/today/read', ReadRoomTodaySchema, RoomTodaySchema),
  solveFlaw: roomsPost('/v1/rooms/today/solve', SolveFlawSchema, FlawSolvedAcceptanceSchema),
  sky: roomsPost('/v1/rooms/sky/read', ReadRoomSkySchema, RoomSkyViewSchema),
  nameConstellation: roomsPost('/v1/rooms/sky/name', NameConstellationSchema, ConstellationVoteAcceptanceSchema),
  voteDebate: roomsPost('/v1/rooms/debates/vote', VoteDebateSchema, DebateVoteAcceptanceSchema),
};

/**
 * Served by the API's rooms controller, with Social's problem family and cache policy. The four parts are
 * named so that the declaration the compiler writes for this object stays bounded.
 */
export const roomsContract: typeof roomsRoomContract &
  typeof roomsDiscussionContract &
  typeof roomsActivityContract &
  typeof roomsSkyContract = {
  ...roomsRoomContract,
  ...roomsDiscussionContract,
  ...roomsActivityContract,
  ...roomsSkyContract,
};

/**
 * D-069's allow-list as data: every key of every `roomsContract` answer whose name speaks of a count, a total,
 * presence or activity (a camelCase word of count, total, online, here, active, unread or seen, or a name that starts
 * with lastMessage or lastActivity), and the one view it may appear on. A member's own view of a room carries the
 * `read` entries (`view: 'member'`); the rest are not about people in the room and are named so no one mistakes them
 * for presence. A new key of that kind in any answer
 * fails the contract test until it is added here on purpose, with a reason.
 */
export const ROOM_COUNT_AND_ACTIVITY_FIELDS: readonly {
  readonly route: keyof typeof roomsContract;
  /** The branch of the answer's `status` it sits on, when the answer has one. */
  readonly view: string | undefined;
  readonly path: string;
  readonly why: string;
}[] = [
  { route: 'read', view: 'member', path: 'here', why: 'who has the room open: faces, never an AI' },
  { route: 'read', view: 'member', path: 'here.count', why: 'people here, only from three (D-069)' },
  { route: 'read', view: 'member', path: 'lastMessageAt', why: 'when the newest visible message was sent' },
  { route: 'read', view: 'member', path: 'memberTotal', why: 'current members, for the room menu' },
  { route: 'read', view: 'member', path: 'you.noticeSeenAt', why: 'when the caller read the AI notice: their own' },
  {
    route: 'read',
    view: 'member',
    path: 'general.lastActivityAt',
    why: 'when the discussion last had a message: orders the list',
  },
  {
    route: 'read',
    view: 'member',
    path: 'discussions.lastActivityAt',
    why: 'when the discussion last had a message: orders the list',
  },
  {
    route: 'read',
    view: 'member',
    path: 'general.replyCount',
    why: 'how many messages the discussion shows: a topic card in it reads the topic by this figure',
  },
  {
    route: 'read',
    view: 'member',
    path: 'discussions.replyCount',
    why: 'how many messages the discussion shows: a topic card reads the topic by this figure',
  },
  {
    route: 'read',
    view: 'member',
    path: 'general.lastReplyBy',
    why: 'who spoke last in the discussion, as a name and whether it is an AI: a topic card reads it; left out for a blocked person',
  },
  {
    route: 'read',
    view: 'member',
    path: 'discussions.lastReplyBy',
    why: 'who spoke last in the discussion, as a name and whether it is an AI: a topic card reads it; left out for a blocked person',
  },
  {
    route: 'topics',
    view: 'ready',
    path: 'topics.lastReplyBy',
    why: 'who spoke last in the topic: the forum list; left out for a blocked person',
  },
  {
    route: 'topics',
    view: 'ready',
    path: 'topics.answered',
    why: 'whether anyone but the starter has spoken in the topic: the Unanswered sort and its row',
  },
  {
    route: 'topics',
    view: 'ready',
    path: 'topics.lastActivityAt',
    why: 'when the topic last had a message: orders the list',
  },
  {
    route: 'topics',
    view: 'ready',
    path: 'topics.replyCount',
    why: 'how many messages the topic shows: the forum list',
  },
  {
    route: 'topics',
    view: 'ready',
    path: 'topics.usefulCount',
    why: 'how many marks of Useful its answers have: shown on the topic, never on a message or to an author',
  },
  {
    route: 'preferences',
    view: undefined,
    path: 'you.noticeSeenAt',
    why: 'the same own mark, in the answer to setting it',
  },
  {
    route: 'readDiscussion',
    view: 'ready',
    path: 'content.sequence.total',
    why: "how many Parts the discussion's series has: a fact about content, not people",
  },
  {
    route: 'reports',
    view: undefined,
    path: 'reports.count',
    why: 'how many different people reported a message, for its moderators only (D-055)',
  },
];
