import { z } from 'zod';
import { UuidSchema } from './ids.js';
import { FriendPairViewSchema, SharingListCursorSchema } from './sharing.js';
import { socialPost } from './social-problems.js';

const Version = z.literal('friend-pages.v2');
const FriendsFilter = z.enum(['friends', 'blocked']);
const RequestsFilter = z.enum(['incoming', 'outgoing']);
const Input = {
  version: Version,
  /** Fresh read correlation, never an action command, authenticated identity or cursor grant. */
  requestId: UuidSchema,
  limit: z.number().int().min(1).max(50),
  cursor: SharingListCursorSchema.optional(),
};

/** Pure bounded read. The backend authenticates current scope and the opaque cursor separately. */
export const ReadFriendsPageSchema = z
  .strictObject({ ...Input, filter: FriendsFilter })
  .refine((r) => !r.cursor || r.cursor.filter === r.filter);
export const ReadFriendRequestsPageSchema = z
  .strictObject({ ...Input, filter: RequestsFilter })
  .refine((r) => !r.cursor || r.cursor.filter === r.filter);

/** A page of a captured finite scan, not necessarily a page containing a visible row.
 * Empty items with next is an advancing scan continuation; ONLY absence of next exhausts it.
 * The server authenticates protocol/scope/filter/head/limit/anchor/ceiling/expiry and checks
 * current eligibility. Consumers compare requestId/scope/filter/head to their initiating read,
 * bound items by the requested limit and refuse nonadvancing tokens. Schemas cannot prove those
 * cross-request facts, token authenticity, row eligibility, finite advancement or authority.
 * Public snapshotRevision excludes private pair transitions, peer epochs and presence changes. */
export const FriendPagesPageSchema = z
  .strictObject({
    version: Version,
    requestId: UuidSchema,
    scope: SharingListCursorSchema.shape.scope,
    filter: SharingListCursorSchema.shape.filter,
    snapshotRevision: SharingListCursorSchema.shape.snapshotRevision,
    items: z.array(FriendPairViewSchema).max(50),
    next: SharingListCursorSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (
      r.items.some((p) => p.state !== r.filter) ||
      new Set(r.items.map((p) => p.peer.personId.toLowerCase())).size !== r.items.length
    )
      ctx.addIssue({ code: 'custom', message: 'Page items must match the unique public filter.' });
    if (
      r.next &&
      (r.next.filter !== r.filter ||
        r.next.snapshotRevision !== r.snapshotRevision ||
        r.next.scope.accountId !== r.scope.accountId ||
        r.next.scope.privacyEpoch !== r.scope.privacyEpoch)
    )
      ctx.addIssue({ code: 'custom', message: 'Scan continuation must bind this scope, filter and public snapshot.' });
  });

export const FriendsPageSchema = FriendPagesPageSchema.safeExtend({ filter: FriendsFilter });
export const FriendRequestsPageSchema = FriendPagesPageSchema.safeExtend({ filter: RequestsFilter });

/** Separate version/paths: malformed v2 input must never downgrade into unimplemented v1 reads.
 * Closed Social problems are reused; unknown validation path tokens must be masked as unknown.
 * These declarations mount no controller, cursor codec, cache/auth guard, maintenance or work. */
export const friendPagesContract = {
  friends: socialPost('/v1/social/friends/page', ReadFriendsPageSchema, FriendsPageSchema),
  requests: socialPost('/v1/social/requests/page', ReadFriendRequestsPageSchema, FriendRequestsPageSchema),
};

export type ReadFriendsPage = z.infer<typeof ReadFriendsPageSchema>;
export type ReadFriendRequestsPage = z.infer<typeof ReadFriendRequestsPageSchema>;
export type FriendPagesPage = z.infer<typeof FriendPagesPageSchema>;
export type FriendsPage = z.infer<typeof FriendsPageSchema>;
export type FriendRequestsPage = z.infer<typeof FriendRequestsPageSchema>;
