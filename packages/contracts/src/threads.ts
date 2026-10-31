import { z } from 'zod';
import { BlockStateSnapshot, BlockTypeName, BlockVersionNumber, LocalId, Sha256Hex } from '@knowscroll/scroll-model';
import {
  ConversationChangesCursorSchema,
  ConversationContentProjectionSchema,
  ConversationContentRefSchema,
  ConversationHistoryCursorSchema,
  ConversationScopeSchema,
  ConversationTextSchema,
  MessageExtrasShape,
  MessageReactionKindSchema,
} from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';
import { PublicPersonRefSchema } from './sharing.js';
import { socialPost } from './social-problems.js';

/**
 * Content threads (blueprint §17): a Reel or Scroll, the people it was shared with and their
 * conversation about it, on one surface. The thread owns membership and messages. Each person's
 * playback position, current episode and seen markers are their own and never appear here. The one
 * thing a member may choose to tell the others is a coarse place: a part, `on` or `finished`, and a
 * day (D-065). It has its own read and commands, and no other answer carries it. The same goes for a call
 * ("Call it together", D-155): a pick on a part's authored question, hidden from the others until the reveal.
 */
const Version = z.literal('content-thread.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Limit = z.number().int().min(1).max(50);
const Millis = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A part of a declared series: the same bound as an episode's `part`. */
const PartNumber = z.number().int().min(1).max(99);

/** Most friends one thread can be started with. */
export const MAX_THREAD_FRIENDS = 8;
/** A shared Reel moment is at least this long; it can run to the end of the Reel. */
export const MIN_SNIPPET_RANGE_MS = 1_000;

function isPublicLabel(value: string): boolean {
  return (
    value.trim() === value &&
    [...value].every((character) => {
      const point = character.codePointAt(0)!;
      return point >= 32 && (point < 127 || point > 159);
    })
  );
}
const ThreadName = z.string().min(1).max(80).refine(isPublicLabel);

/** The caller's own reference to a thread. Opaque; the membership revision moves only when the caller's own membership does. */
export const ContentThreadRefSchema = z.strictObject({
  threadId: UuidSchema,
  membershipId: UuidSchema,
  membershipRevision: Revision,
});
export type ContentThreadRef = z.infer<typeof ContentThreadRefSchema>;

/**
 * Where in the original a snippet points. The exact asset revision comes with the command; nothing
 * here is media or code. A Reel range is a start and an end in milliseconds. A passage is a text
 * range of one block, with the hash of what the sender saw. A block names one block and, only when
 * the sender chose to include them, its settings; values the sender entered themselves travel
 * only with `confirmPersonal` (D-006 g).
 */
export const SnippetAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reel_range'), startMs: Millis, endMs: Millis }),
  z.strictObject({
    kind: z.literal('scroll_passage'),
    blockId: LocalId,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    quoteHash: Sha256Hex,
  }),
  z.strictObject({
    kind: z.literal('scroll_block'),
    blockId: LocalId,
    blockType: BlockTypeName,
    blockVersion: BlockVersionNumber,
    settings: z.strictObject({ snapshot: BlockStateSnapshot, confirmPersonal: z.boolean().optional() }).optional(),
  }),
]);
export type SnippetAnchor = z.infer<typeof SnippetAnchorSchema>;

export const SendThreadBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
  z.strictObject({
    kind: z.literal('snippet'),
    target: ConversationContentRefSchema,
    anchor: SnippetAnchorSchema,
    note: ConversationTextSchema.optional(),
  }),
]);
export type SendThreadBody = z.infer<typeof SendThreadBodySchema>;

/**
 * A snippet as a card. It points into the original admitted content, so `content` says whether
 * that is still available, corrected (the exact revision shared is no longer the current one) or
 * withdrawn. A quote or a block's settings are shown only while the content is not withdrawn.
 * Receiving or expanding a card is not an encounter and proves nothing about reading.
 */
export const SnippetCardSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reel_range'),
    startMs: Millis,
    endMs: Millis,
    content: ConversationContentProjectionSchema,
  }),
  z.strictObject({
    kind: z.literal('scroll_passage'),
    blockId: LocalId,
    quote: z.string().min(1).max(600).optional(),
    content: ConversationContentProjectionSchema,
  }),
  z.strictObject({
    kind: z.literal('scroll_block'),
    blockId: LocalId,
    blockType: BlockTypeName,
    /** The block's own accessible label, set by the document, never by the sender. */
    label: z.string().min(1).max(240).optional(),
    settings: z.discriminatedUnion('included', [
      z.strictObject({ included: z.literal(false) }),
      z.strictObject({
        included: z.literal(true),
        /** Built from the block's own labels, for example "Sentence length · 4,096 words". */
        description: z.string().max(400).optional(),
        personalIncluded: z.boolean(),
      }),
    ]),
    content: ConversationContentProjectionSchema,
  }),
]);
export type SnippetCard = z.infer<typeof SnippetCardSchema>;

const MessageIdentity = { messageId: UuidSchema, sequence: Revision };
/** A message of a thread. A deleted author's message is a neutral marker with no author, body or card. */
export const ThreadMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...MessageIdentity,
    status: z.literal('available'),
    author: PublicPersonRefSchema,
    recordedAt: z.iso.datetime(),
    ...MessageExtrasShape,
    body: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
      z.strictObject({
        kind: z.literal('snippet'),
        snippet: SnippetCardSchema,
        note: ConversationTextSchema.optional(),
      }),
    ]),
  }),
  z.strictObject({ ...MessageIdentity, status: z.literal('unavailable') }),
]);
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
const Messages = z
  .array(ThreadMessageSchema)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((item) => item.messageId)).size === items.length &&
      items.every((item, index) => index === 0 || item.sequence > items[index - 1]!.sequence),
  );

/**
 * One episode of the thread's sequence. Only a declared series gives a `part`. `visited` is the
 * caller's own history alone and never a grade; nothing says what another member has seen.
 * `corrected` means the revision pinned in the sequence is no longer the current one.
 */
export const ThreadEpisodeSchema = z.strictObject({
  assetId: UuidSchema,
  assetRevision: Revision,
  kind: z.enum(['reel', 'scroll']),
  part: PartNumber.optional(),
  title: z.string().min(1).max(240),
  state: z.enum(['ready', 'corrected', 'unavailable']),
  visited: z.boolean(),
});
export type ThreadEpisode = z.infer<typeof ThreadEpisodeSchema>;

/**
 * Where a member is in the thread's series: on a part, or finished it. A coarse, self-reported place
 * (D-065), shown only to the members of a thread they joined and only while the member has not hidden
 * it. It is a part and a calendar day, never a playhead, a branch, a selected episode, a seen marker
 * or a time of day: `day` is a date, so a finer time does not parse. It is not consumption evidence.
 */
export const ThreadPlaceSchema = z.strictObject({
  person: PublicPersonRefSchema,
  you: z.boolean(),
  part: PartNumber,
  state: z.enum(['on', 'finished']),
  /** The UTC calendar day the member reached this place, as YYYY-MM-DD. */
  day: z.iso.date(),
});
export type ThreadPlace = z.infer<typeof ThreadPlaceSchema>;

export const ThreadParticipantSchema = z.strictObject({
  person: PublicPersonRefSchema,
  /** The person who started the thread, or someone they invited. */
  role: z.enum(['starter', 'member']),
  /** False while the invitation is not accepted yet. */
  joined: z.boolean(),
  you: z.boolean(),
});
export type ThreadParticipant = z.infer<typeof ThreadParticipantSchema>;

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
const OwnSettings = z.strictObject({ readThroughSequence: Counter, muted: z.boolean() });
const continuation = <T extends z.ZodType>(cursor: T) =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('end') }),
    z.strictObject({ kind: z.literal('more'), cursor }),
  ]);

/**
 * Starts a thread with current friends. Retrying the same command returns the same thread. Every
 * friend must be a current friend of the caller; one that is not makes the whole command
 * unavailable, and nothing says which. Friends get an invitation, never a silent membership.
 */
export const CreateContentThreadSchema = z.strictObject({
  ...Command,
  root: ConversationContentRefSchema,
  friendPersonIds: z
    .array(UuidSchema)
    .min(1)
    .max(MAX_THREAD_FRIENDS)
    .refine((ids) => new Set(ids).size === ids.length),
  name: ThreadName.optional(),
});
export const ContentThreadCreationSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('thread.create'),
  thread: ContentThreadRefSchema,
});

export const ReadContentThreadSchema = z.strictObject({
  ...Read,
  thread: ContentThreadRefSchema,
  limit: Limit,
});
export const ContentThreadViewSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  /** Not yet accepted: the invitation shows the content and who invited, never the messages. */
  z.strictObject({
    ...ScopedRead,
    status: z.literal('invitation'),
    thread: ContentThreadRefSchema,
    name: ThreadName.optional(),
    root: ConversationContentProjectionSchema,
    invitedBy: PublicPersonRefSchema,
    participantCount: Revision,
  }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      thread: ContentThreadRefSchema,
      name: ThreadName.optional(),
      root: ConversationContentProjectionSchema,
      participants: z
        .array(ThreadParticipantSchema)
        .min(1)
        .max(MAX_THREAD_FRIENDS + 1),
      sequence: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('single') }),
        z.strictObject({ kind: z.literal('series'), total: z.number().int().min(1).max(99) }),
      ]),
      episodes: z.array(ThreadEpisodeSchema).min(1).max(99),
      own: OwnSettings,
      latestMessageSequence: Counter,
      messages: Messages,
      limit: Limit,
      history: continuation(ConversationHistoryCursorSchema),
      catchUpCursor: ConversationChangesCursorSchema,
    })
    .refine(
      (view) =>
        view.messages.length <= view.limit &&
        view.own.readThroughSequence <= view.latestMessageSequence &&
        (view.latestMessageSequence === 0
          ? view.messages.length === 0
          : view.messages.at(-1)?.sequence === view.latestMessageSequence),
    ),
]);
export type ContentThreadView = z.infer<typeof ContentThreadViewSchema>;

export const ReadThreadHistorySchema = z.strictObject({
  ...Read,
  thread: ContentThreadRefSchema,
  limit: Limit,
  cursor: ConversationHistoryCursorSchema,
});
export const ThreadHistoryPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('refresh_required'),
    requestCursor: ConversationHistoryCursorSchema,
  }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      thread: ContentThreadRefSchema,
      limit: Limit,
      requestCursor: ConversationHistoryCursorSchema,
      messages: Messages,
      continuation: continuation(ConversationHistoryCursorSchema),
    })
    .refine(
      (page) =>
        page.messages.length <= page.limit &&
        (page.continuation.kind !== 'more' || page.continuation.cursor !== page.requestCursor),
    ),
]);

export const ReadThreadChangesSchema = z.strictObject({
  ...Read,
  thread: ContentThreadRefSchema,
  limit: Limit,
  cursor: ConversationChangesCursorSchema,
});
export const ThreadChangesPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('refresh_required'),
    requestCursor: ConversationChangesCursorSchema,
  }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    thread: ContentThreadRefSchema,
    limit: Limit,
    requestCursor: ConversationChangesCursorSchema,
    fromChangeSequence: Counter,
    throughChangeSequence: Counter,
    changes: z.array(z.strictObject({ changeSequence: Revision, message: ThreadMessageSchema })).max(50),
    continuation: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('more'), cursor: ConversationChangesCursorSchema }),
      z.strictObject({ kind: z.literal('caught_up'), cursor: ConversationChangesCursorSchema }),
    ]),
  }),
]);

/**
 * Sends a text message or a snippet. The server checks the anchor against the exact revision: a
 * Reel range inside its duration, a passage on a stable block with its quote, a block's settings
 * from its own parameter declarations. A snippet of withdrawn or corrected content is refused.
 * The same command and body replay the first answer; the same command with another body is refused.
 */
export const SendThreadMessageSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  body: SendThreadBodySchema,
  /** A message of this same thread (a flat quote); any other ID is refused. */
  replyTo: UuidSchema.optional(),
});
export const ThreadMessageAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('thread.send'),
  thread: ContentThreadRefSchema,
  messageId: UuidSchema,
  messageSequence: Revision,
  sent: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text') }),
    z.strictObject({ kind: z.literal('snippet'), anchor: z.enum(['reel_range', 'scroll_passage', 'scroll_block']) }),
  ]),
});

/** Accepts or declines an invitation. Joining makes the history readable; declining ends the invitation. */
/** Puts one of the five reactions on a message of the thread, or takes it off (`present` is the wanted state). */
export const ReactToThreadMessageSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  messageId: UuidSchema,
  kind: MessageReactionKindSchema,
  present: z.boolean(),
});
export const ThreadReactionAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('thread.react'),
  thread: ContentThreadRefSchema,
  messageId: UuidSchema,
  kind: MessageReactionKindSchema,
  present: z.boolean(),
  changed: z.boolean(),
});
export const RespondToThreadInvitationSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  response: z.enum(['join', 'decline']),
});
export const ThreadInvitationResponseAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('thread.respond'),
  response: z.enum(['join', 'decline']),
  /** The caller's reference after the response; a decline gives none that opens anything. */
  thread: ContentThreadRefSchema,
});

export const MarkThreadReadSchema = z.strictObject({
  ...Command,
  thread: ContentThreadRefSchema,
  throughSequence: Counter,
});
export const ThreadReadAcceptanceSchema = z
  .strictObject({
    ...Receipt,
    operation: z.literal('thread.read'),
    thread: ContentThreadRefSchema,
    requestedThroughSequence: Counter,
    acceptedThroughSequence: Counter,
  })
  .refine((acceptance) => acceptance.acceptedThroughSequence >= acceptance.requestedThroughSequence);

export const LeaveThreadSchema = z.strictObject({ ...Command, thread: ContentThreadRefSchema });
export const ThreadLeaveAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('thread.leave'),
  thread: ContentThreadRefSchema,
});

export const ReadThreadInboxSchema = z.strictObject({ ...Read, limit: Limit });
export const ThreadSummarySchema = z.strictObject({
  thread: ContentThreadRefSchema,
  name: ThreadName.optional(),
  root: ConversationContentProjectionSchema,
  /** Invited threads show who invited; joined threads show the people in them. */
  state: z.enum(['invited', 'joined']),
  /** The caller's own public person ID, so a row can write "You" for their own last message. */
  ownPersonId: UuidSchema,
  people: z
    .array(PublicPersonRefSchema)
    .min(1)
    .max(MAX_THREAD_FRIENDS + 1),
  latestMessageSequence: Counter,
  own: OwnSettings,
  lastActivityAt: z.iso.datetime(),
  lastMessage: ThreadMessageSchema.optional(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export const ThreadInboxSchema = z.strictObject({
  ...ScopedRead,
  status: z.literal('ready'),
  limit: Limit,
  viewRevision: Counter,
  items: z.array(ThreadSummarySchema).max(50),
});

/**
 * The places of a thread's series as the caller may see them. `hidden` is the caller's own switch. A
 * member who hides, has not set a place, left, was removed, or blocks the caller (or is blocked by them)
 * is simply not listed, and nothing says which; a thread that is not a series has none. The caller's own
 * place is listed with `you` while they share it. A stranger gets `unavailable`.
 */
export const ReadThreadPlacesSchema = z.strictObject({ ...Read, thread: ContentThreadRefSchema });
export const ThreadPlacesSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    thread: ContentThreadRefSchema,
    hidden: z.boolean(),
    places: z
      .array(ThreadPlaceSchema)
      .max(MAX_THREAD_FRIENDS + 1)
      .refine((places) => new Set(places.map((place) => place.person.personId)).size === places.length),
  }),
]);
export type ThreadPlaces = z.infer<typeof ThreadPlacesSchema>;

/**
 * What a place command answers: the caller's scope and what the command did, and no time. A place command
 * is idempotent by its wanted state, so it has no command ID, keeps no receipt and has nothing to replay
 * (D-152): a receipt would hold the exact time of every report.
 */
const PlaceAcceptance = { version: Version, scope: ConversationScopeSchema };

/**
 * Reports the caller's own place. Written only by the member's own client, when they open a part of
 * the thread's series or finish it. The server checks that the part is in the series, keeps a place
 * that is further along, stamps the day itself and writes nothing while the caller hides. Repeating it
 * changes nothing. Not consumption evidence for anyone.
 */
export const SetThreadPlaceSchema = z.strictObject({
  version: Version,
  thread: ContentThreadRefSchema,
  part: PartNumber,
  state: z.enum(['on', 'finished']),
});
export const ThreadPlaceAcceptanceSchema = z.strictObject({
  ...PlaceAcceptance,
  operation: z.literal('thread.place'),
  thread: ContentThreadRefSchema,
  /**
   * `stored`: the place moved. `unchanged`: the caller was already there or further on. `hidden`: the
   * caller hides, so nothing was written.
   */
  result: z.enum(['stored', 'unchanged', 'hidden']),
});

/**
 * Hides or shows where the caller is in this thread (a wanted state, so a repeat changes nothing).
 * Hiding deletes the caller's place in the same step; showing again waits for their next open.
 */
export const SetThreadPlaceHiddenSchema = z.strictObject({
  version: Version,
  thread: ContentThreadRefSchema,
  hidden: z.boolean(),
});
export const ThreadPlaceHiddenAcceptanceSchema = z.strictObject({
  ...PlaceAcceptance,
  operation: z.literal('thread.place-hidden'),
  thread: ContentThreadRefSchema,
  hidden: z.boolean(),
  changed: z.boolean(),
});

/** A call has two or three options (`scroll-limits.v2`); this is the zero-based index of one. */
const CallOption = z.number().int().min(0).max(2);

/** One member's pick, shown only after the reveal and only to a member who locked their own. */
export const ThreadCallPickSchema = z.strictObject({
  person: PublicPersonRefSchema,
  you: z.boolean(),
  option: CallOption,
  right: z.boolean(),
});
export type ThreadCallPick = z.infer<typeof ThreadCallPickSchema>;

/** What every stage shows: the question, which part it comes before, and how many of the thread have called. */
const ThreadCallBase = {
  part: PartNumber,
  assetId: UuidSchema,
  assetRevision: Revision,
  prompt: z.string().min(1).max(200),
  options: z.array(z.string().min(1).max(120)).min(2).max(3),
  /** Members the caller may count (they take part, no block either way) who have locked. */
  called: z
    .number()
    .int()
    .min(0)
    .max(MAX_THREAD_FRIENDS + 1),
  /** Members the caller may count. */
  of: z
    .number()
    .int()
    .min(1)
    .max(MAX_THREAD_FRIENDS + 1),
};

/**
 * The caller's view of one call (D-155). Where it is in its life decides what it carries, so a stage that must
 * not show a pick, the right answer or who called cannot carry one:
 * - `open`: the caller has not locked and may. The question, the options and counts.
 * - `locked`: they locked. Their own option, and counts. The others' picks and the right answer stay hidden.
 * - `revealed`: they locked and the party has finished the part (or two days passed since the first lock). The
 *   right answer, why, everyone's picks the caller may see, and the common guess once there are 30 calls.
 * - `closed`: they never locked and now may not: they started the part, or it was revealed without them. Counts only.
 */
export const ThreadCallSchema = z.discriminatedUnion('stage', [
  z.strictObject({ ...ThreadCallBase, stage: z.literal('open') }),
  z.strictObject({ ...ThreadCallBase, stage: z.literal('locked'), option: CallOption }),
  z.strictObject({
    ...ThreadCallBase,
    stage: z.literal('revealed'),
    /** The caller's own pick. */
    option: CallOption,
    /** The right option. */
    answer: CallOption,
    /** Why the answer is what it is, written with the Scroll. */
    explain: z.string().min(1).max(600),
    /** The warm second look; present only when the caller's own pick was not the right one. */
    twist: z.string().min(1).max(600).optional(),
    /** Whether the caller's own pick was right. A right call is one spark; a wrong one costs nothing. */
    right: z.boolean(),
    picks: z
      .array(ThreadCallPickSchema)
      .min(1)
      .max(MAX_THREAD_FRIENDS + 1)
      .refine((picks) => new Set(picks.map((pick) => pick.person.personId)).size === picks.length),
    rightCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_THREAD_FRIENDS + 1),
    /** The most common pick across every thread, past 30 calls (D-157): an option and a whole percent, no one's pick. */
    commonGuess: z.strictObject({ option: CallOption, percent: z.number().int().min(1).max(100) }).optional(),
  }),
  z.strictObject({ ...ThreadCallBase, stage: z.literal('closed'), reason: z.enum(['started', 'revealed']) }),
]);
export type ThreadCall = z.infer<typeof ThreadCallSchema>;

/**
 * The calls of a thread's series as the caller may see them: one for each part whose Scroll has an authored
 * Call it, in part order. A thread that is not a series has none, and neither does a part that is a Reel or a
 * Scroll without a call. A stranger gets `unavailable`.
 */
export const ReadThreadCallsSchema = z.strictObject({ ...Read, thread: ContentThreadRefSchema });
export const ThreadCallsSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    thread: ContentThreadRefSchema,
    calls: z
      .array(ThreadCallSchema)
      .max(99)
      .refine((calls) => new Set(calls.map((call) => call.part)).size === calls.length),
  }),
]);
export type ThreadCalls = z.infer<typeof ThreadCallsSchema>;

/**
 * Locks the caller's pick on the call of one part. The first lock stands: a repeat, or another pick, answers
 * `stands` and changes nothing, so there is no command ID and no receipt (D-156). `recordingGeneration` is the
 * generation of the person's recording policy the client last read: a pick is a play result, so while recording
 * is paused nothing is stored (D-083). The command carries no correctness and no stop: the server finds the call
 * in the thread's series and judges it from the immutable revision.
 */
export const LockThreadCallSchema = z.strictObject({
  version: Version,
  thread: ContentThreadRefSchema,
  part: PartNumber,
  option: CallOption,
  recordingGeneration: RecordingGenerationSchema,
});
const CallLockAcceptance = {
  version: Version,
  scope: ConversationScopeSchema,
  operation: z.literal('thread.call-lock'),
};
export const ThreadCallLockAcceptanceSchema = z.discriminatedUnion('recorded', [
  z.strictObject({
    ...CallLockAcceptance,
    recorded: z.literal(true),
    thread: ContentThreadRefSchema,
    part: PartNumber,
    /**
     * `locked`: stored now. `stands`: the caller had already locked, and that pick stands. `closed`: the call
     * is closed to them (they started the part, or it was revealed), and nothing was stored.
     */
    result: z.enum(['locked', 'stands', 'closed']),
  }),
  z.strictObject({
    ...CallLockAcceptance,
    recorded: z.literal(false),
    reason: z.enum(['recording_paused', 'recording_generation_stale']),
    currentGeneration: RecordingGenerationSchema,
  }),
]);
export type ThreadCallLockAcceptance = z.infer<typeof ThreadCallLockAcceptanceSchema>;

/**
 * Opens a snippet: where it points now. `ready` names the content to open and the anchor in it;
 * `mapped` is true when a correction moved the anchor through an explicit compatible mapping, and
 * `settingsReset` when shared settings no longer fit the block. `changed` means the moment is no
 * longer there: the card offers the current content and never plays or shows the old range.
 * Opening a snippet is not an encounter and writes nothing; reading or playing it afterwards is
 * an ordinary encounter of the original content.
 */
export const OpenThreadSnippetSchema = z.strictObject({
  ...Read,
  thread: ContentThreadRefSchema,
  messageId: UuidSchema,
});
export const ResolvedSnippetAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reel_range'), startMs: Millis, endMs: Millis }),
  z.strictObject({
    kind: z.literal('scroll_passage'),
    blockId: LocalId,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    /** What the sender quoted; the passage was found again under the same words. */
    quote: z.string().min(1).max(600),
  }),
  z.strictObject({
    kind: z.literal('scroll_block'),
    blockId: LocalId,
    snapshot: BlockStateSnapshot.optional(),
    /** The block's own label and the settings in words, for the banner above the opened block. */
    label: z.string().min(1).max(240).optional(),
    description: z.string().max(400).optional(),
  }),
]);
const OpenedContent = z.strictObject({
  kind: z.enum(['reel', 'scroll']),
  assetId: UuidSchema,
  assetRevision: Revision,
  title: z.string().min(1).max(240),
});
export const ThreadSnippetOpeningSchema = z.discriminatedUnion('status', [
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
export type ThreadSnippetOpening = z.infer<typeof ThreadSnippetOpeningSchema>;

/** Served by the API's threads controller. Every command rechecks the caller's membership, the friendship it rests on and the source's current state. */
export const threadsContract = {
  create: socialPost('/v1/social/threads/create', CreateContentThreadSchema, ContentThreadCreationSchema),
  read: socialPost('/v1/social/threads/read', ReadContentThreadSchema, ContentThreadViewSchema),
  history: socialPost('/v1/social/threads/history', ReadThreadHistorySchema, ThreadHistoryPageSchema),
  changes: socialPost('/v1/social/threads/changes', ReadThreadChangesSchema, ThreadChangesPageSchema),
  send: socialPost('/v1/social/threads/send', SendThreadMessageSchema, ThreadMessageAcceptanceSchema),
  react: socialPost('/v1/social/threads/react', ReactToThreadMessageSchema, ThreadReactionAcceptanceSchema),
  respond: socialPost(
    '/v1/social/threads/respond',
    RespondToThreadInvitationSchema,
    ThreadInvitationResponseAcceptanceSchema,
  ),
  markRead: socialPost('/v1/social/threads/mark-read', MarkThreadReadSchema, ThreadReadAcceptanceSchema),
  leave: socialPost('/v1/social/threads/leave', LeaveThreadSchema, ThreadLeaveAcceptanceSchema),
  inbox: socialPost('/v1/social/threads/inbox', ReadThreadInboxSchema, ThreadInboxSchema),
  openSnippet: socialPost('/v1/social/threads/snippets/open', OpenThreadSnippetSchema, ThreadSnippetOpeningSchema),
  places: socialPost('/v1/social/threads/places/read', ReadThreadPlacesSchema, ThreadPlacesSchema),
  setPlace: socialPost('/v1/social/threads/places/set', SetThreadPlaceSchema, ThreadPlaceAcceptanceSchema),
  setPlaceHidden: socialPost(
    '/v1/social/threads/places/hide',
    SetThreadPlaceHiddenSchema,
    ThreadPlaceHiddenAcceptanceSchema,
  ),
  calls: socialPost('/v1/social/threads/calls/read', ReadThreadCallsSchema, ThreadCallsSchema),
  lockCall: socialPost('/v1/social/threads/calls/lock', LockThreadCallSchema, ThreadCallLockAcceptanceSchema),
};
