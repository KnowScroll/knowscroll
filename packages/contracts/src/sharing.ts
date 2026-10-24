import { oc } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';

const Version = z.literal('sharing.v1');
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const EmptyRead = z.strictObject({});
/** A label safe to show another person: trimmed, no control characters. */
export function isPublicLabel(s: string): boolean {
  return (
    s.trim() === s &&
    [...s].every((character) => {
      const point = character.codePointAt(0)!;
      return point >= 32 && (point < 127 || point > 159);
    })
  );
}
const DisplayName = z.string().min(1).max(80).refine(isPublicLabel);
const Label = z.string().min(1).max(160).refine(isPublicLabel);
const UniqueIds = z
  .array(UuidSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);

/** Explicit chosen handle, never email-derived. No normalization transform on an authorised branch. */
export const SharingHandleSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/);

/** Public opaque person identity, not an account/universe/root locator. Only real accounts in v1.
 * Any future participant union that admits AI must add an explicit labelled AI discriminant. */
export const PublicPersonRefSchema = z.strictObject({
  kind: z.literal('person'),
  personId: UuidSchema,
  handle: SharingHandleSchema,
  displayName: DisplayName,
});

const OwnScope = z.strictObject({ accountId: UuidSchema, privacyEpoch: Revision });
const Envelope = { version: Version, scope: OwnScope };
const Command = { version: Version, commandId: CommandIdSchema };
const Acceptance = {
  ...Envelope,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};

export const ReadOwnSharingProfileSchema = EmptyRead;
export const OwnSharingProfileSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...Envelope, status: z.literal('unclaimed'), profileRevision: z.literal(0) }),
  z.strictObject({
    ...Envelope,
    status: z.literal('claimed'),
    profileRevision: Revision,
    person: PublicPersonRefSchema,
  }),
]);
export const SetSharingProfileSchema = z.strictObject({
  ...Command,
  expectedProfileRevision: Counter,
  handle: SharingHandleSchema,
  displayName: DisplayName,
});
export const SharingProfileAcceptanceSchema = z
  .strictObject({
    ...Acceptance,
    operation: z.literal('profile.set'),
    baseProfileRevision: Counter,
    acceptedProfileRevision: Revision,
  })
  .refine((r) => r.acceptedProfileRevision > r.baseProfileRevision);

/** One coarse result for absent, blocked, undiscoverable and inactive identities. No prefix search. */
export const LookupSharingPersonSchema = z.strictObject({ version: Version, handle: SharingHandleSchema });
export const SharingPersonLookupSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...Envelope, status: z.literal('unavailable') }),
  z.strictObject({ ...Envelope, status: z.literal('available'), person: PublicPersonRefSchema, pairRevision: Counter }),
]);

/** Hidden, expired and unknown presence have exactly one shape. expiryRevision fences delivery;
 * it is independent of pair, preference and projection revisions, never an exact peer timestamp.
 * Unknown has no revision/TTL: private heartbeat, hiding and expiry cannot change that shape.
 * validForMs is a relative freshness lease, not a heartbeat policy or peer event timestamp.
 * Its one-day transport ceiling selects no runtime duration. Future adapters check actual expiry;
 * consumers conservatively age from request start and discard on expiry/freshness loss. */
export const FriendAvailabilitySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unknown') }),
  z.strictObject({
    state: z.enum(['online', 'recently_active']),
    expiryRevision: Revision,
    validForMs: z.number().int().min(1).max(86_400_000),
  }),
]);

/** pairRevision is a CALLER-VISIBLE relationship-view revision, independent of internal pair
 * transitions and presence preference/expiry. Private events cannot advance public list snapshots.
 * Silent decline preserves the sender's outgoing view, public expiry and revision until that
 * fixed expiry. Private decline/peer block cannot surface as revision-stale or timestamps.
 * Future adapters also fence internal locked pair authority; it is never this public counter. */
const PairFields = { peer: PublicPersonRefSchema, pairRevision: Revision };
export const FriendPairViewSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('none'), peer: PublicPersonRefSchema, pairRevision: Counter }),
  z.strictObject({ ...PairFields, state: z.literal('incoming'), requestId: UuidSchema }),
  z.strictObject({ ...PairFields, state: z.literal('outgoing'), requestId: UuidSchema }),
  z.strictObject({ ...PairFields, state: z.literal('friends'), availability: FriendAvailabilitySchema }),
  // Own block only; another side's block is never exposed by a boolean or reason.
  z.strictObject({ ...PairFields, state: z.literal('blocked') }),
]);
export const ReadFriendPairSchema = z.strictObject({ version: Version, peerPersonId: UuidSchema });
export const FriendPairResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...Envelope, status: z.literal('unavailable') }),
  z.strictObject({ ...Envelope, status: z.literal('available'), pair: FriendPairViewSchema }),
]);

const ListKind = z.enum(['friends', 'incoming', 'outgoing', 'blocked']);
/** Token is an opaque server cursor, not an invite capability. Server checks token authenticity,
 * scope/epoch/filter/snapshot before using it. No cursor grants access or exposes a peer root. */
export const SharingListCursorSchema = z.strictObject({
  scope: OwnScope,
  filter: ListKind,
  snapshotRevision: Revision,
  token: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const PageInput = {
  version: Version,
  limit: z.number().int().min(1).max(50),
  cursor: SharingListCursorSchema.optional(),
};
export const ReadFriendsSchema = z
  .strictObject({ ...PageInput, filter: z.enum(['friends', 'blocked']) })
  .refine((r) => !r.cursor || r.cursor.filter === r.filter);
export const ReadFriendRequestsSchema = z
  .strictObject({ ...PageInput, filter: z.enum(['incoming', 'outgoing']) })
  .refine((r) => !r.cursor || r.cursor.filter === r.filter);
export const SharingListPageSchema = z
  .strictObject({
    ...Envelope,
    filter: ListKind,
    snapshotRevision: Revision,
    items: z.array(FriendPairViewSchema).max(50),
    next: SharingListCursorSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (
      r.items.some((p) => p.state !== r.filter) ||
      new Set(r.items.map((p) => p.peer.personId)).size !== r.items.length
    )
      ctx.addIssue({ code: 'custom', message: 'Page items must match the unique filtered snapshot.' });
    if (
      r.next &&
      (r.next.filter !== r.filter ||
        r.next.snapshotRevision !== r.snapshotRevision ||
        r.next.scope.accountId !== r.scope.accountId ||
        r.next.scope.privacyEpoch !== r.scope.privacyEpoch ||
        r.items.length === 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Continuation must bind this scope, filter and nonempty snapshot.' });
  });

/** Bearer capability allowed only in sensitive JSON input and ephemeral first delivery.
 * Adapters must never log it, put it in an API path, queue, notice or ordinary receipt. */
export const FriendInviteTokenSchema = z.string().regex(/^ksfi_[A-Za-z0-9_-]{43}$/);
export const ResolveFriendInviteSchema = z.strictObject({ version: Version, token: FriendInviteTokenSchema });
export const ResolvedFriendInviteSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...Envelope, status: z.literal('unavailable') }),
  z.strictObject({ ...Envelope, status: z.literal('available'), issuer: PublicPersonRefSchema, pairRevision: Counter }),
]);

/** expectedPeerPersonId binds the explicit lookup/resolve selection; handle reassignment or a
 * different invite issuer cannot silently redirect a retry. Initial absent pair revision is 0.
 * Reciprocal requests never accept: acceptance is a separate deliberate command. */
export const RequestFriendSchema = z.strictObject({
  ...Command,
  expectedPeerPersonId: UuidSchema,
  expectedPairRevision: Counter,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('handle'), handle: SharingHandleSchema }),
    z.strictObject({ kind: z.literal('invite'), token: FriendInviteTokenSchema }),
  ]),
});
const ExistingPairCommand = {
  ...Command,
  peerPersonId: UuidSchema,
  expectedPairRevision: Revision,
};
export const AcceptFriendSchema = z.strictObject({ ...ExistingPairCommand, requestId: UuidSchema });
export const DeclineFriendSchema = z.strictObject({ ...ExistingPairCommand, requestId: UuidSchema });
export const CancelFriendRequestSchema = z.strictObject({ ...ExistingPairCommand, requestId: UuidSchema });
export const RemoveFriendSchema = z.strictObject(ExistingPairCommand);
export const BlockFriendSchema = z.strictObject({ ...ExistingPairCommand, expectedPairRevision: Counter });
export const UnblockFriendSchema = z.strictObject(ExistingPairCommand);

/** Immutable committed acceptance, never the current friendship or proof of continued access.
 * Current scope/epochs, pair and relevant visibility authority must be checked BEFORE replay.
 * Same command ID + exact canonical body on retry; changed body is COMMAND_KEY_REUSED.
 * Revision may stay equal for a recorded no-op (including an existing reciprocal request).
 * Decline exposes no sender-facing reason/time; unblock restores no friendship or publication. */
export const FriendCommandAcceptanceSchema = z
  .strictObject({
    ...Acceptance,
    operation: z.enum([
      'friend.request',
      'friend.accept',
      'friend.decline',
      'friend.cancel',
      'friend.remove',
      'friend.block',
      'friend.unblock',
    ]),
    peerPersonId: UuidSchema,
    basePairRevision: Counter,
    acceptedPairRevision: Revision,
  })
  .refine(
    (r) =>
      r.acceptedPairRevision >= r.basePairRevision &&
      (!['friend.accept', 'friend.decline', 'friend.cancel', 'friend.remove', 'friend.unblock'].includes(r.operation) ||
        r.basePairRevision > 0),
  );

export const ReadOwnFriendInvitesSchema = EmptyRead;
export const OwnFriendInviteStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none'), inviteRevision: z.literal(0) }),
  z.strictObject({ status: z.enum(['active', 'revoked', 'expired']), linkId: UuidSchema, inviteRevision: Revision }),
]);
export const OwnFriendInvitesSchema = z.strictObject({ ...Envelope, invite: OwnFriendInviteStatusSchema });
export const CreateFriendInviteSchema = z.strictObject({ ...Command, expectedInviteRevision: Counter });
export const RevokeFriendInviteSchema = z.strictObject({
  ...Command,
  linkId: UuidSchema,
  expectedInviteRevision: Revision,
});
export const FriendInviteAcceptanceSchema = z
  .strictObject({
    ...Acceptance,
    operation: z.enum(['invite.create', 'invite.revoke']),
    linkId: UuidSchema,
    baseInviteRevision: Counter,
    acceptedInviteRevision: Revision,
  })
  .refine(
    (r) =>
      r.acceptedInviteRevision >= r.baseInviteRevision && (r.operation !== 'invite.revoke' || r.baseInviteRevision > 0),
  );

/** Only acceptance is durable. First response may deliver a secret separately, once. Identical
 * replay returns the SAME link reference and unavailable delivery. Lost first delivery requires
 * deliberately revoking that link and creating a new command; never secretly reissue a token. */
export const CreateFriendInviteResultSchema = z
  .strictObject({
    acceptance: FriendInviteAcceptanceSchema.safeExtend({ operation: z.literal('invite.create') }),
    delivery: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('available'), token: FriendInviteTokenSchema }),
      z.strictObject({ status: z.literal('unavailable') }),
    ]),
  })
  .refine(
    (r) =>
      r.acceptance.operation === 'invite.create' && (!r.acceptance.replayed || r.delivery.status === 'unavailable'),
  );

export const VisitorAudienceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('nobody') }),
  z.strictObject({ mode: z.literal('chosen_friends'), personIds: UniqueIds.refine((ids) => ids.length > 0) }),
  z.strictObject({ mode: z.literal('all_friends') }),
]);
/** One of the caller's own systems and whether visitors may see it. `systemId` is the caller's own
 * Geography ID and NEVER appears in a visitor projection; `label` is the owner's own word. */
export const OwnVisibilitySystemSchema = z.strictObject({ systemId: UuidSchema, label: Label, shared: z.boolean() });
/** Own settings only. Audience widening never selects a system automatically. Defaults are nobody,
 * no systems shared and hidden availability (D-006 e), so a person who never opens this page shares
 * nothing. `systems` lists the caller's own factual systems, so one read draws the whole page. */
export const SharingVisibilitySchema = z.strictObject({
  ...Envelope,
  visibilityRevision: Revision,
  audience: VisitorAudienceSchema,
  systems: z.array(OwnVisibilitySystemSchema).max(100),
});
export const ReadSharingVisibilitySchema = EmptyRead;
export const SetSharingVisibilitySchema = z.strictObject({
  ...Command,
  expectedVisibilityRevision: Revision,
  audience: VisitorAudienceSchema,
  sharedSystemIds: UniqueIds,
});
export const SharingVisibilityAcceptanceSchema = z
  .strictObject({
    ...Acceptance,
    operation: z.literal('visibility.set'),
    baseVisibilityRevision: Revision,
    acceptedVisibilityRevision: Revision,
  })
  .refine((r) => r.acceptedVisibilityRevision >= r.baseVisibilityRevision);

export const PresencePreferenceSchema = z.enum(['online', 'recently_active', 'hidden']);
export const OwnPresencePreferenceSchema = z.strictObject({
  ...Envelope,
  presencePreferenceRevision: Revision,
  preference: PresencePreferenceSchema,
});
export const ReadPresencePreferenceSchema = EmptyRead;
export const SetPresencePreferenceSchema = z.strictObject({
  ...Command,
  expectedPresencePreferenceRevision: Revision,
  preference: PresencePreferenceSchema,
});
export const PresencePreferenceAcceptanceSchema = z
  .strictObject({
    ...Acceptance,
    operation: z.literal('presence.preference.set'),
    basePresencePreferenceRevision: Revision,
    acceptedPresencePreferenceRevision: Revision,
  })
  .refine((r) => r.acceptedPresencePreferenceRevision >= r.basePresencePreferenceRevision);

/** The visitor read is a semantic list: systems, each with its planets. This is not a scene DSL or a
 * private Scene/Geography payload with a visibility flag. It carries no position, size, seed, family,
 * activity, reading or count of anything hidden; a client lays the list out itself. A graphical
 * extension would need separately reviewed public geometry, never a private descriptor or anchor. */
export const VisitorCapabilitiesSchema = z.strictObject({ presentations: z.array(z.literal('list.v1')).min(1).max(1) });
const VisitorTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personId: UuidSchema }),
  z.strictObject({ kind: z.literal('handle'), handle: SharingHandleSchema }),
]);
/** What the visitor's answer was built from: their own view of the friendship and the version of
 * what the owner publishes. The owner's settings revision never leaves the owner. */
const VisitorAuthority = z.strictObject({
  pairRevision: Revision,
  publishedProjectionRevision: Revision,
});
export const ReadVisitorWorldSchema = z.strictObject({
  version: Version,
  target: VisitorTarget,
  capabilities: VisitorCapabilitiesSchema,
});
const VisitorRead = { ...Envelope, target: VisitorTarget, capabilities: VisitorCapabilitiesSchema };
const VisitorPlanet = z.strictObject({ publicPlanetId: UuidSchema, label: Label });
const VisitorSystem = z.strictObject({
  publicSystemId: UuidSchema,
  label: Label,
  planets: z.array(VisitorPlanet).max(100),
});
/** At most this many systems are published, and at most this many planets in each. */
export const VISITOR_LIMITS = { systems: 100, planetsPerSystem: 100 } as const;
export const VisitorWorldSnapshotSchema = z
  .discriminatedUnion('status', [
    // Same coarse answer for denial, block, revocation, an unknown person, an ended friendship, an
    // erased or unpublished world: the wire cannot tell a visitor which of them it was.
    z.strictObject({ ...VisitorRead, status: z.literal('unavailable') }),
    z.strictObject({
      ...VisitorRead,
      status: z.literal('available'),
      owner: PublicPersonRefSchema,
      authority: VisitorAuthority,
      projection: z.strictObject({
        presentation: z.literal('list.v1'),
        // Stable only within this authorised publication scope, never private Geography IDs.
        systems: z.array(VisitorSystem).max(VISITOR_LIMITS.systems),
      }),
    }),
  ])
  .superRefine((r, ctx) => {
    if (r.status !== 'available') return;
    const ids = r.projection.systems.flatMap((system) => [
      system.publicSystemId,
      ...system.planets.map((planet) => planet.publicPlanetId),
    ]);
    if (
      (r.target.kind === 'person' && r.target.personId !== r.owner.personId) ||
      (r.target.kind === 'handle' && r.target.handle !== r.owner.handle) ||
      new Set(ids).size !== ids.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Projection must bind the selected public owner and unique public identities.',
      });
  });

export type PublicPersonRef = z.infer<typeof PublicPersonRefSchema>;
export type FriendPairView = z.infer<typeof FriendPairViewSchema>;
export type FriendAvailability = z.infer<typeof FriendAvailabilitySchema>;
export type RequestFriend = z.infer<typeof RequestFriendSchema>;
export type FriendCommandAcceptance = z.infer<typeof FriendCommandAcceptanceSchema>;
export type SharingVisibility = z.infer<typeof SharingVisibilitySchema>;
export type OwnPresencePreference = z.infer<typeof OwnPresencePreferenceSchema>;
export type VisitorWorldSnapshot = z.infer<typeof VisitorWorldSnapshotSchema>;

function post<I extends z.ZodType, O extends z.ZodType>(path: `/v1/social/${string}`, input: I, output: O) {
  return oc
    .route({ method: 'POST', path, successStatus: 200, tags: ['sharing'] })
    .input(input)
    .output(output);
}
function get<I extends z.ZodType, O extends z.ZodType>(path: `/v1/social/${string}`, input: I, output: O) {
  return oc
    .route({ method: 'GET', path, successStatus: 200, tags: ['sharing'] })
    .input(input)
    .output(output);
}
/** HTTP declarations only: no installed routes, grants, receipts, social activity or provider work. */
export const sharingContract = {
  profile: get('/v1/social/profile', ReadOwnSharingProfileSchema, OwnSharingProfileSchema),
  setProfile: post('/v1/social/profile', SetSharingProfileSchema, SharingProfileAcceptanceSchema),
  lookup: post('/v1/social/people/lookup', LookupSharingPersonSchema, SharingPersonLookupSchema),
  pair: post('/v1/social/pairs/read', ReadFriendPairSchema, FriendPairResultSchema),
  friends: post(
    '/v1/social/friends/read',
    ReadFriendsSchema,
    SharingListPageSchema.safeExtend({ filter: z.enum(['friends', 'blocked']) }),
  ),
  requests: post(
    '/v1/social/requests/read',
    ReadFriendRequestsSchema,
    SharingListPageSchema.safeExtend({ filter: z.enum(['incoming', 'outgoing']) }),
  ),
  request: post(
    '/v1/social/friends/request',
    RequestFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.request') }),
  ),
  accept: post(
    '/v1/social/friends/accept',
    AcceptFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.accept') }),
  ),
  decline: post(
    '/v1/social/friends/decline',
    DeclineFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.decline') }),
  ),
  cancel: post(
    '/v1/social/friends/cancel',
    CancelFriendRequestSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.cancel') }),
  ),
  remove: post(
    '/v1/social/friends/remove',
    RemoveFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.remove') }),
  ),
  block: post(
    '/v1/social/friends/block',
    BlockFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.block') }),
  ),
  unblock: post(
    '/v1/social/friends/unblock',
    UnblockFriendSchema,
    FriendCommandAcceptanceSchema.safeExtend({ operation: z.literal('friend.unblock') }),
  ),
  resolveInvite: post('/v1/social/invites/resolve', ResolveFriendInviteSchema, ResolvedFriendInviteSchema),
  invites: get('/v1/social/invites', ReadOwnFriendInvitesSchema, OwnFriendInvitesSchema),
  createInvite: post('/v1/social/invites/create', CreateFriendInviteSchema, CreateFriendInviteResultSchema),
  revokeInvite: post(
    '/v1/social/invites/revoke',
    RevokeFriendInviteSchema,
    FriendInviteAcceptanceSchema.safeExtend({ operation: z.literal('invite.revoke') }),
  ),
  visibility: get('/v1/social/visibility', ReadSharingVisibilitySchema, SharingVisibilitySchema),
  setVisibility: post('/v1/social/visibility', SetSharingVisibilitySchema, SharingVisibilityAcceptanceSchema),
  presencePreference: get('/v1/social/presence/preference', ReadPresencePreferenceSchema, OwnPresencePreferenceSchema),
  setPresencePreference: post(
    '/v1/social/presence/preference',
    SetPresencePreferenceSchema,
    PresencePreferenceAcceptanceSchema,
  ),
  visit: post('/v1/social/visits/read', ReadVisitorWorldSchema, VisitorWorldSnapshotSchema),
};
