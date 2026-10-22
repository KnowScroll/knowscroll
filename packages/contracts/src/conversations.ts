import { z } from 'zod';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { EncounterMetadataSchema } from './navigation.js';
import { PublicPersonRefSchema } from './sharing.js';
import { socialPost } from './social-problems.js';

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
const MessageIdentity = { messageId: UuidSchema, sequence: Revision };
/** Only actual human authors in this phase. Deleted private bodies/attachments become neutral
 * markers; no erased author, old body, source/private evidence, peer position or AI stand-in. */
export const ConversationMessageSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...MessageIdentity,
    status: z.literal('available'),
    author: PublicPersonRefSchema,
    recordedAt: z.iso.datetime(),
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
/** Authenticated/confidential, purpose+world+caller+epoch+membership+limit-bound server tokens.
 * No token grants authority; keep ephemeral, never logs/storage/notices. Expiry/rotation gives
 * refresh_required, never a silently substituted first page. A finite window has a captured
 * change ceiling; continuous appends cannot make one traversal unbounded. Runtime policy later. */
export const ConversationInboxCursorSchema = z.string().regex(/^kci1_[A-Za-z0-9_-]{43,1024}$/);
export const ConversationHistoryCursorSchema = z.string().regex(/^kch1_[A-Za-z0-9_-]{43,1024}$/);
export const ConversationChangesCursorSchema = z.string().regex(/^kcc1_[A-Za-z0-9_-]{43,1024}$/);
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

/** A deliberate current accepted friend1:1 only. Future backend reuses the private pair aggregate
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
export const DirectConversationSummarySchema = z
  .strictObject({
    conversation: DirectConversationRefSchema,
    peer: PublicPersonRefSchema,
    latestMessageSequence: Counter,
    own: OwnSettings,
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
        r.messages.every((m) => m.sequence <= r.latestMessageSequence),
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
 * neutral tombstone. No socket delivery/ack establishes durable message receipt or seen status. */
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
export const SendConversationMessageSchema = z.strictObject({
  ...Command,
  conversation: DirectConversationRefSchema,
  body: SendConversationBodySchema,
});
/** Historical acceptance only. Keep the identical command/body after an unknown outcome, even
 * if a later retry is rejected; no replacement UUID or automatic ambiguous resend. The future
 * adapter atomically commits message+receipt+requiredpg-bosswork; notices carry IDs only.
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

/** Declarations only. ReadId/scope/selector/cursor/limit echoes must match the actual initiating
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
  markRead: socialPost(
    '/v1/social/conversations/mark-read',
    MarkConversationReadSchema,
    ConversationReadAcceptanceSchema,
  ),
  mute: socialPost('/v1/social/conversations/mute', MuteConversationSchema, ConversationMuteAcceptanceSchema),
  leave: socialPost('/v1/social/conversations/leave', LeaveConversationSchema, ConversationLeaveAcceptanceSchema),
};
export type DirectConversationRef = z.infer<typeof DirectConversationRefSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type SendConversationMessage = z.infer<typeof SendConversationMessageSchema>;
export type ConversationChangesPage = z.infer<typeof ConversationChangesPageSchema>;
