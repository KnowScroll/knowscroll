import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';
import {
  ConversationScopeSchema,
  DirectConversationRefSchema,
  ConversationContentRefSchema,
  ConversationContentProjectionSchema,
  ShareableContentProjectionSchema,
} from './conversations.js';
import { socialPost } from './social-problems.js';

const Version = z.literal('content-share.v1');
const Read = { version: Version, readId: UuidSchema };
const Command = { version: Version, commandId: CommandIdSchema };
/** Public metadata is the SAME public allowlist for every caller: no sender, conversation,
 * relationship, private body or media grant. A public card cannot reveal a peer's block state.
 * Private possession alone grants nothing: current membership/pair/block/Content checks apply. */
export const ContentShareAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public_metadata') }),
  z.strictObject({ kind: z.literal('conversation'), conversation: DirectConversationRefSchema }),
]);
export const ContentShareTokenSchema = z.string().regex(/^kssh_[A-Za-z0-9_-]{43}$/);
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
  shareId: UuidSchema,
};
export const CreateContentShareSchema = z.strictObject({
  ...Command,
  target: ConversationContentRefSchema,
  audience: ContentShareAudienceSchema,
});
export const ContentShareCreationAcceptanceSchema = z
  .strictObject({
    ...Receipt,
    operation: z.literal('content-share.create'),
    target: ConversationContentRefSchema,
    audience: ContentShareAudienceSchema,
    expiresAt: z.iso.datetime(),
  })
  .refine((r) => Date.parse(r.expiresAt) > Date.parse(r.recordedAt));
/** Immutable receipt never stores/returns a bearer secret. First response delivers it separately
 * once. A lost response retries the original command/body, recovers the same shareId with no
 * token, then requires deliberate revoke/new command if the token was lost. Never auto-reissue. */
export const CreateContentShareResultSchema = z
  .strictObject({
    acceptance: ContentShareCreationAcceptanceSchema,
    delivery: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('available'), token: ContentShareTokenSchema }),
      z.strictObject({ status: z.literal('unavailable') }),
    ]),
  })
  .refine((r) => !r.acceptance.replayed || r.delivery.status === 'unavailable');
export const RevokeContentShareSchema = z.strictObject({ ...Command, shareId: UuidSchema });
export const ContentShareRevocationAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('content-share.revoke'),
});
/** Fresh current own-resource read, not replay of an old-epoch command. Minimal same-account
 * selector can recover the committed resource after Clear without reauthorizing the old body. */
export const ReadOwnContentShareSchema = z.strictObject({
  ...Read,
  selector: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('share'), shareId: UuidSchema }),
    z.strictObject({ kind: z.literal('command'), commandId: CommandIdSchema }),
  ]),
});
export const OwnContentShareSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...Read,
      scope: ConversationScopeSchema,
      status: z.literal('unavailable'),
      selector: ReadOwnContentShareSchema.shape.selector,
    }),
    z.strictObject({
      ...Read,
      scope: ConversationScopeSchema,
      status: z.literal('available'),
      selector: ReadOwnContentShareSchema.shape.selector,
      shareId: UuidSchema,
      target: ConversationContentRefSchema,
      audience: ContentShareAudienceSchema,
      state: z.enum(['active', 'revoked', 'expired']),
      expiresAt: z.iso.datetime(),
    }),
  ])
  .refine((r) => r.status !== 'available' || r.selector.kind !== 'share' || r.selector.shareId === r.shareId);
/** The person's own live links, newest first, at most 50: the way to see and stop what they shared.
 * Revoked and expired links are not listed. The card shows what a link points at now, so a
 * withdrawn asset reads as unavailable. */
export const ListOwnContentSharesSchema = z.strictObject({ ...Read });
export const OwnContentSharesSchema = z.strictObject({
  ...Read,
  scope: ConversationScopeSchema,
  items: z
    .array(
      z.strictObject({
        shareId: UuidSchema,
        target: ConversationContentRefSchema,
        audience: ContentShareAudienceSchema,
        createdAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        content: ConversationContentProjectionSchema,
      }),
    )
    .max(50),
});
/** Sensitive JSON only; no token in ordinary API URLs/logs/errors/receipts/notices/storage.
 * The dedicated future /s/:token landing must isolate proxy/referrer/OG handling. It does not
 * join a conversation/thread or create any receipt/exposure merely by resolving a link. */
export const ResolveContentShareSchema = z.strictObject({ ...Read, token: ContentShareTokenSchema });
export const ResolvedContentShareSchema = z.discriminatedUnion('status', [
  // Indistinguishable unknown/expired/revoked/withdrawn/private-denied/block/membership loss.
  z.strictObject({ ...Read, status: z.literal('unavailable') }),
  z.strictObject({ ...Read, status: z.literal('public_metadata'), content: ShareableContentProjectionSchema }),
  z.strictObject({
    ...Read,
    status: z.literal('conversation'),
    scope: ConversationScopeSchema,
    conversation: DirectConversationRefSchema,
    content: ShareableContentProjectionSchema,
  }),
]);
/** Public anonymous metadata has its separate public-content-shares.ts boundary; this private
 * JSON resolver must never be broadly unscoped or used as a public union fallback.
 * Every current read/replay requires current authority; never treat an old receipt as continued
 * access. Correction keeps exact original ref, explicit current ref, and requires a deliberate
 * canonical Open/activation. External copy/system intent is not confirmed delivery or recall.
 * Social survives Clear; full account deletion separately removes authored private bodies and
 * revokes private links, preserving other people's independent messages. No external recall claim. */
export const contentSharesContract = {
  create: socialPost('/v1/social/content-shares/create', CreateContentShareSchema, CreateContentShareResultSchema),
  revoke: socialPost(
    '/v1/social/content-shares/revoke',
    RevokeContentShareSchema,
    ContentShareRevocationAcceptanceSchema,
  ),
  own: socialPost('/v1/social/content-shares/read', ReadOwnContentShareSchema, OwnContentShareSchema),
  list: socialPost('/v1/social/content-shares/list', ListOwnContentSharesSchema, OwnContentSharesSchema),
  resolve: socialPost('/v1/social/content-shares/resolve', ResolveContentShareSchema, ResolvedContentShareSchema),
};
export type ContentShareToken = z.infer<typeof ContentShareTokenSchema>;
export type CreateContentShare = z.infer<typeof CreateContentShareSchema>;
export type ResolvedContentShare = z.infer<typeof ResolvedContentShareSchema>;
export type OwnContentShares = z.infer<typeof OwnContentSharesSchema>;
