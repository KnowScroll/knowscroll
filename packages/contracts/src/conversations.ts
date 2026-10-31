import { z } from 'zod';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { EncounterMetadataSchema } from './navigation.js';
import { PublicPersonRefSchema } from './sharing.js';
import { socialJsonData, socialPost } from './social-problems.js';

const Version = z.literal('direct-conversation.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Limit = z.number().int().min(1).max(50);
export const ConversationScopeSchema = z.strictObject({ accountId: UuidSchema, privacyEpoch: Revision });
/** Opaque conversation and caller participation identity; never the private pair root/revision.
 * Current account/epoch, accepted pair lineage, membership and block gates precede ALL replay.
 * Peer read/mute/presence/private block events never advance a caller-visible revision. */
export const DirectConversationRefSchema = z.strictObject({
  conversationId: UuidSchema,
  membershipId: UuidSchema,
  membershipRevision: Revision,
});
export const ConversationContentRefSchema = z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision });
const AvailableContent = z.strictObject({
  status: z.literal('available'),
  target: ConversationContentRefSchema,
  metadata: EncounterMetadataSchema,
});
const CorrectedContent = z
  .strictObject({
    status: z.literal('corrected'),
    target: ConversationContentRefSchema,
    current: ConversationContentRefSchema.extend({ metadata: EncounterMetadataSchema }),
  })
  .refine((r) => r.current.assetId === r.target.assetId && r.current.assetRevision !== r.target.assetRevision);
/** Access-checked public consumer metadata only. Correction preserves the original exact target;
 * the recipient must deliberately select the new revision and use the real canonical Open path.
 * A card is never a playback/media/exposure grant or proof of a personal encounter. */
export const ShareableContentProjectionSchema = z.discriminatedUnion('status', [AvailableContent, CorrectedContent]);
export const ConversationContentProjectionSchema = z.union([
  ShareableContentProjectionSchema,
  z.strictObject({ status: z.literal('unavailable'), target: ConversationContentRefSchema }),
]);
/** Plain untrusted reader text; no HTML/Markdown execution or message body in general logs. */
export const ConversationTextSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (s) =>
      s.trim() === s &&
      [...s].every((c) => {
        const n = c.codePointAt(0)!;
        return n === 10 || n === 9 || (n >= 32 && (n < 127 || n > 159));
      }),
  );
export const SendConversationBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
  z.strictObject({
    kind: z.literal('content'),
    target: ConversationContentRefSchema,
    note: ConversationTextSchema.optional(),
  }),
]);
/**
 * The five reactions of Talk (T3: Spark, Mind blown, Ha, Heart, Question). The set is closed and
 * has no emoji keyboard: a client draws each kind itself. A person can hold one of each kind on a
 * message, so the kinds are independent of one another.
 */
export const MESSAGE_REACTION_KINDS = ['spark', 'mind_blown', 'ha', 'heart', 'question'] as const;
export const MessageReactionKindSchema = z.enum(MESSAGE_REACTION_KINDS);
export type MessageReactionKind = z.infer<typeof MessageReactionKindSchema>;
/**
 * One kind of reaction on a message, as the reader sees it: the people who put it there (without
 * anyone the reader blocked) and whether the reader is one of them. The pill shows the number of
 * people and "tap to see who" lists them (T3 kit); no time and no other reaction detail is carried.
 */
export const MessageReactionSchema = z.strictObject({
  kind: MessageReactionKindSchema,
  mine: z.boolean(),
  people: z.array(PublicPersonRefSchema).min(1).max(9),
});
/** Each kind at most once, in the order of `MESSAGE_REACTION_KINDS`; a message with none omits the field. */
export const MessageReactionsSchema = z
  .array(MessageReactionSchema)
  .min(1)
  .max(MESSAGE_REACTION_KINDS.length)
  .refine((items) => new Set(items.map((item) => item.kind)).size === items.length);
/**
 * The message a reply answers, in the same conversation. `original` is read when the page is built:
 * an author and the first words, or "unavailable" once the original was removed (its author's account
 * was deleted). A client that holds the original itself prefers what it holds.
 */
export const MessageQuoteSchema = z.strictObject({
  messageId: UuidSchema,
  sequence: Revision,
  original: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      author: PublicPersonRefSchema,
      /** The first words of a text message or a card's note; empty for a card without a note. */
      preview: z.string().max(160),
    }),
    z.strictObject({ status: z.literal('unavailable') }),
  ]),
});
export type MessageQuote = z.infer<typeof MessageQuoteSchema>;
/** The optional parts every available message of a conversation or thread can carry. */
export const MessageExtrasShape = {
  reactions: MessageReactionsSchema.optional(),
  replyTo: MessageQuoteSchema.optional(),
};

const MessageIdentity = { messageId: UuidSchema, sequence: Revision };
/** Only actual human authors in this phase. Deleted private bodies/attachments become neutral
 * markers; no erased author, old body, source/private evidence, peer position or AI stand-in. */
export const ConversationMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...MessageIdentity,
    status: z.literal('available'),
    author: PublicPersonRefSchema,
    recordedAt: z.iso.datetime(),
    ...MessageExtrasShape,
    body: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: ConversationTextSchema }),
      z.strictObject({
        kind: z.literal('content'),
        content: ConversationContentProjectionSchema,
        note: ConversationTextSchema.optional(),
      }),
    ]),
  }),
  z.strictObject({ ...MessageIdentity, status: z.literal('unavailable') }),
]);
const Messages = z
  .array(ConversationMessageSchema)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((x) => x.messageId)).size === items.length &&
      items.every((x, i) => i === 0 || x.sequence > items[i - 1]!.sequence),
  );
/** Opaque keyset positions: the inbox cursor holds the last row's activity time and conversation,
 * the history cursor the oldest sequence already seen, the changes cursor the last change seen.
 * They hold nothing the caller does not already have and grant nothing: every use rechecks
 * membership, and a position that does not belong to the named conversation gives
 * refresh_required, never a silently substituted first page. */
export const ConversationInboxCursorSchema = z.string().regex(/^kci1_[A-Za-z0-9_-]{22,1024}$/);
export const ConversationHistoryCursorSchema = z.string().regex(/^kch1_[A-Za-z0-9_-]{22,1024}$/);
export const ConversationChangesCursorSchema = z.string().regex(/^kcc1_[A-Za-z0-9_-]{22,1024}$/);
const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};
const Command = { version: Version, commandId: CommandIdSchema };
const continuation = <T extends z.ZodType>(cursor: T) =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('end') }),
    z.strictObject({ kind: z.literal('more'), cursor }),
  ]);

/** A deliberate current accepted friend 1:1 only. The backend reuses the private pair aggregate
 * as the SOLE shared locking authority, with a separate opaque conversation ID. Never lock pair
 * root then another conversation root. Leave/withdrawal ends that participation; re-friending
 * cannot silently revive old membership or command authority. No group/thread/invite protocol. */
export const StartDirectConversationSchema = z.strictObject({
  ...Command,
  peerPersonId: UuidSchema,
  expectedPairRevision: Revision,
});
export const DirectConversationAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('conversation.start'),
  conversation: DirectConversationRefSchema,
  peerPersonId: UuidSchema,
});
export const ReadConversationInboxSchema = z.strictObject({
  ...Read,
  limit: Limit,
  cursor: ConversationInboxCursorSchema.optional(),
});
const OwnSettings = z.strictObject({ readThroughSequence: Counter, muted: z.boolean() });
/** Present (true) only after the other person left: history stays readable, nothing more can be sent. */
const Ended = z.literal(true).optional();
/**
 * How far the other person has read while their own switch was on: SEEN (D-066, D-150). What they read while it was
 * off is never in it, even after they turn it on. Present only while the conversation stands and both
 * people share their read position. Its absence gives no reason (the other person hides theirs, the reader hides
 * their own, either person left). A position, never a time: the time under a message is when it was sent.
 */
const PeerRead = z.strictObject({ throughSequence: Counter }).optional();
export const DirectConversationSummarySchema = z
  .strictObject({
    conversation: DirectConversationRefSchema,
    peer: PublicPersonRefSchema,
    latestMessageSequence: Counter,
    own: OwnSettings,
    ended: Ended,
    lastMessage: ConversationMessageSchema.optional(),
  })
  .refine(
    (r) =>
      r.own.readThroughSequence <= r.latestMessageSequence &&
      (r.latestMessageSequence === 0
        ? r.lastMessage === undefined
        : r.lastMessage?.sequence === r.latestMessageSequence),
  );
export const ConversationInboxSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...ScopedRead,
    status: z.literal('refresh_required'),
    limit: Limit,
    requestCursor: ConversationInboxCursorSchema,
  }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      limit: Limit,
      requestCursor: ConversationInboxCursorSchema.optional(),
      viewRevision: Counter,
      items: z.array(DirectConversationSummarySchema).max(50),
      continuation: continuation(ConversationInboxCursorSchema),
    })
    .refine(
      (r) =>
        r.items.length <= r.limit &&
        new Set(r.items.map((x) => x.conversation.conversationId)).size === r.items.length &&
        (r.continuation.kind !== 'more' || r.continuation.cursor !== r.requestCursor),
    ),
]);
export const ReadDirectConversationSchema = z.strictObject({
  ...Read,
  conversation: DirectConversationRefSchema,
  limit: Limit,
});
export const DirectConversationSnapshotSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      conversation: DirectConversationRefSchema,
      peer: PublicPersonRefSchema,
      own: OwnSettings,
      peerRead: PeerRead,
      ended: Ended,
      latestMessageSequence: Counter,
      messages: Messages,
      limit: Limit,
      history: continuation(ConversationHistoryCursorSchema),
      catchUpCursor: ConversationChangesCursorSchema,
    })
    .refine(
      (r) =>
        r.messages.length <= r.limit &&
        r.own.readThroughSequence <= r.latestMessageSequence &&
        (r.peerRead === undefined || r.peerRead.throughSequence <= r.latestMessageSequence) &&
        // The initial window includes the latest bubble (including a neutral tombstone).
        // Otherwise catch-up could start past a committed message absent from this snapshot.
        (r.latestMessageSequence === 0
          ? r.messages.length === 0
          : r.messages.at(-1)?.sequence === r.latestMessageSequence),
    ),
]);
export const ReadConversationHistorySchema = z.strictObject({
  ...Read,
  conversation: DirectConversationRefSchema,
  limit: Limit,
  cursor: ConversationHistoryCursorSchema,
});
export const ConversationHistoryPageSchema = z.discriminatedUnion('status', [
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
      conversation: DirectConversationRefSchema,
      limit: Limit,
      requestCursor: ConversationHistoryCursorSchema,
      messages: Messages,
      continuation: continuation(ConversationHistoryCursorSchema),
    })
    .refine(
      (r) =>
        r.messages.length <= r.limit && (r.continuation.kind !== 'more' || r.continuation.cursor !== r.requestCursor),
    ),
]);
export const ReadConversationChangesSchema = z.strictObject({
  ...Read,
  conversation: DirectConversationRefSchema,
  limit: Limit,
  cursor: ConversationChangesCursorSchema,
});
/** Change sequence orders durable visible creation/redaction, NOT peer private preferences.
 * Stable message.sequence keeps original bubble order when a later change replaces it with a
 * neutral tombstone. No socket delivery/ack establishes durable message receipt or seen status:
 * SEEN is the page's `peerRead`, read from the server, and only while both people share it. */
export const ConversationChangeSchema = z
  .strictObject({ changeSequence: Revision, message: ConversationMessageSchema })
  .refine((r) => r.message.sequence <= r.changeSequence);
export const ConversationChangesPageSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('refresh_required'),
    requestCursor: ConversationChangesCursorSchema,
  }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      conversation: DirectConversationRefSchema,
      limit: Limit,
      requestCursor: ConversationChangesCursorSchema,
      ended: Ended,
      peerRead: PeerRead,
      fromChangeSequence: Counter,
      throughChangeSequence: Counter,
      changes: z.array(ConversationChangeSchema).max(50),
      continuation: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('more'), cursor: ConversationChangesCursorSchema }),
        z.strictObject({ kind: z.literal('caught_up'), cursor: ConversationChangesCursorSchema }),
      ]),
    })
    .refine((r) => {
      const last = r.changes.at(-1)?.changeSequence ?? r.fromChangeSequence;
      const byId = new Map<string, number>();
      const bySequence = new Map<number, string>();
      for (const { message } of r.changes) {
        if (
          (byId.has(message.messageId) && byId.get(message.messageId) !== message.sequence) ||
          (bySequence.has(message.sequence) && bySequence.get(message.sequence) !== message.messageId)
        )
          return false;
        byId.set(message.messageId, message.sequence);
        bySequence.set(message.sequence, message.messageId);
      }
      return (
        r.fromChangeSequence <= r.throughChangeSequence &&
        (r.peerRead === undefined || r.peerRead.throughSequence <= r.throughChangeSequence) &&
        r.changes.length <= r.limit &&
        r.changes.every(
          (x, i) =>
            x.changeSequence > r.fromChangeSequence &&
            x.changeSequence <= r.throughChangeSequence &&
            (i === 0 || x.changeSequence > r.changes[i - 1]!.changeSequence),
        ) &&
        (r.continuation.kind === 'more'
          ? r.changes.length > 0 && last < r.throughChangeSequence && r.continuation.cursor !== r.requestCursor
          : last === r.throughChangeSequence)
      );
    }),
]);
/** `replyTo` names a message of this same conversation (a flat quote, never nested); any other ID is refused. */
export const SendConversationMessageSchema = z.strictObject({
  ...Command,
  conversation: DirectConversationRefSchema,
  body: SendConversationBodySchema,
  replyTo: UuidSchema.optional(),
});
/** Historical acceptance only. Keep the identical command/body after an unknown outcome, even
 * if a later retry is rejected; no replacement UUID or automatic ambiguous resend. The backend
 * commits the message, its receipt and the members' inbox hints in one transaction; hints carry
 * IDs only and are disposable.
 * Read/receipt replay rechecks current pair/membership/block/source authority first. */
export const ConversationMessageAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('message.send'),
  conversation: DirectConversationRefSchema,
  messageId: UuidSchema,
  messageSequence: Revision,
  sent: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text') }),
    z.strictObject({ kind: z.literal('content'), target: ConversationContentRefSchema }),
  ]),
});
/** Current own resource lookup after an unknown send, including after Clear. This is not
 * historical command replay. Current pair/block/member/source identity gates precede lookup;
 * the immutable sent identity never grants present access, reauthorises an old body or resends.
 * Unavailable is not proof of not-sent; preserve the original pending command and its uncertainty. */
const OwnSendSelectorSchema = z.strictObject({ kind: z.literal('command'), commandId: CommandIdSchema });
export const ReadOwnConversationSendSchema = socialJsonData(
  z.strictObject({
    ...Read,
    conversation: DirectConversationRefSchema,
    selector: OwnSendSelectorSchema,
  }),
);
export const OwnConversationSendSchema = socialJsonData(
  z.discriminatedUnion('status', [
    z.strictObject({
      ...ScopedRead,
      selector: OwnSendSelectorSchema,
      status: z.literal('unavailable'),
    }),
    z.strictObject({
      ...ScopedRead,
      conversation: DirectConversationRefSchema,
      selector: OwnSendSelectorSchema,
      status: z.literal('accepted'),
      messageId: UuidSchema,
      messageSequence: Revision,
      recordedAt: z.iso.datetime(),
      sent: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('text') }),
        z.strictObject({ kind: z.literal('content'), target: ConversationContentRefSchema }),
      ]),
    }),
  ]),
);

/**
 * Puts one reaction on a message, or takes it off: `present` is the wanted state, so a repeat of
 * either is a no-op that still answers accepted. Reacting needs the same standing as sending.
 */
export const ReactToConversationMessageSchema = z.strictObject({
  ...Command,
  conversation: DirectConversationRefSchema,
  messageId: UuidSchema,
  kind: MessageReactionKindSchema,
  present: z.boolean(),
});
export const ConversationReactionAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('message.react'),
  conversation: DirectConversationRefSchema,
  messageId: UuidSchema,
  kind: MessageReactionKindSchema,
  present: z.boolean(),
  /** False when the reaction was already in the wanted state. */
  changed: z.boolean(),
});

export const MarkConversationReadSchema = z.strictObject({
  ...Command,
  conversation: DirectConversationRefSchema,
  throughSequence: Counter,
});
export const ConversationReadAcceptanceSchema = z
  .strictObject({
    ...Receipt,
    operation: z.literal('conversation.read'),
    conversation: DirectConversationRefSchema,
    requestedThroughSequence: Counter,
    acceptedThroughSequence: Counter,
  })
  .refine((r) => r.acceptedThroughSequence >= r.requestedThroughSequence);
export const MuteConversationSchema = z.strictObject({
  ...Command,
  conversation: DirectConversationRefSchema,
  muted: z.boolean(),
});
export const ConversationMuteAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('conversation.mute'),
  conversation: DirectConversationRefSchema,
  muted: z.boolean(),
});
export const LeaveConversationSchema = z.strictObject({ ...Command, conversation: DirectConversationRefSchema });
export const ConversationLeaveAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('conversation.leave'),
  conversation: DirectConversationRefSchema,
});

/** Served by the API's conversations controller. ReadId/scope/selector/cursor/limit echoes must match the actual initiating
 * scope and nonregressive watermark in consumers. Syntax proves neither authority nor delivery.
 * Inbox order is last visible message commit time DESC, conversationId ASC; no private peer
 * preference/presence event changes that order. Snapshot+catch-up cursor share one root transaction.
 * Each message ID keeps its original sequence across edits/tombstones; consumers reject remapping.
 * Clear preserves account-lifetime Social but fences old-epoch commands and purges client scopes.
 * No message/share/read/selection contributes consumption Evidence, learning or world formation. */
export const conversationsContract = {
  start: socialPost(
    '/v1/social/conversations/start',
    StartDirectConversationSchema,
    DirectConversationAcceptanceSchema,
  ),
  inbox: socialPost('/v1/social/conversations/inbox', ReadConversationInboxSchema, ConversationInboxSchema),
  read: socialPost('/v1/social/conversations/read', ReadDirectConversationSchema, DirectConversationSnapshotSchema),
  history: socialPost('/v1/social/conversations/history', ReadConversationHistorySchema, ConversationHistoryPageSchema),
  changes: socialPost('/v1/social/conversations/changes', ReadConversationChangesSchema, ConversationChangesPageSchema),
  send: socialPost('/v1/social/conversations/send', SendConversationMessageSchema, ConversationMessageAcceptanceSchema),
  readOwnSend: socialPost(
    '/v1/social/conversations/send/read',
    ReadOwnConversationSendSchema,
    OwnConversationSendSchema,
  ),
  react: socialPost(
    '/v1/social/conversations/react',
    ReactToConversationMessageSchema,
    ConversationReactionAcceptanceSchema,
  ),
  markRead: socialPost(
    '/v1/social/conversations/mark-read',
    MarkConversationReadSchema,
    ConversationReadAcceptanceSchema,
  ),
  mute: socialPost('/v1/social/conversations/mute', MuteConversationSchema, ConversationMuteAcceptanceSchema),
  leave: socialPost('/v1/social/conversations/leave', LeaveConversationSchema, ConversationLeaveAcceptanceSchema),
};
export type DirectConversationRef = z.infer<typeof DirectConversationRefSchema>;
export type ConversationContentRef = z.infer<typeof ConversationContentRefSchema>;
export type ConversationContentProjection = z.infer<typeof ConversationContentProjectionSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type DirectConversationSummary = z.infer<typeof DirectConversationSummarySchema>;
export type SendConversationMessage = z.infer<typeof SendConversationMessageSchema>;
export type ConversationChangesPage = z.infer<typeof ConversationChangesPageSchema>;

export type ReadOwnConversationSend = z.infer<typeof ReadOwnConversationSendSchema>;
export type OwnConversationSend = z.infer<typeof OwnConversationSendSchema>;

const CurrentOwnSendReadSchema = socialJsonData(
  z.strictObject({
    scope: ConversationScopeSchema,
    conversation: DirectConversationRefSchema,
  }),
);
/** Correlation only, never an authority check. Pass independently obtained current scope and
 * participation after the real gates. A missing/stale/malformed value refuses without falling
 * back to an old receipt. UUID comparisons use canonical case, without rewriting the body. */
export function ownConversationSendForRead(
  request: unknown,
  reply: unknown,
  current: unknown,
): OwnConversationSend | undefined {
  const input = ReadOwnConversationSendSchema.safeParse(request);
  const output = OwnConversationSendSchema.safeParse(reply);
  const actual = CurrentOwnSendReadSchema.safeParse(current);
  if (!input.success || !output.success || !actual.success) return undefined;
  const a = input.data,
    b = output.data,
    c = actual.data;
  const sameId = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const sameConversation = (
    x: z.infer<typeof DirectConversationRefSchema>,
    y: z.infer<typeof DirectConversationRefSchema>,
  ) =>
    sameId(x.conversationId, y.conversationId) &&
    sameId(x.membershipId, y.membershipId) &&
    x.membershipRevision === y.membershipRevision;
  if (
    !sameId(a.readId, b.readId) ||
    !sameId(a.selector.commandId, b.selector.commandId) ||
    !sameId(b.scope.accountId, c.scope.accountId) ||
    b.scope.privacyEpoch !== c.scope.privacyEpoch ||
    !sameConversation(a.conversation, c.conversation) ||
    (b.status === 'accepted' && !sameConversation(b.conversation, c.conversation))
  )
    return undefined;
  return b;
}
