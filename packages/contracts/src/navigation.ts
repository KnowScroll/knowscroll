import { oc } from '@orpc/contract';
import { z } from 'zod';
import { ClientCapabilities } from './content.js';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';

const Revision = z.number().int().min(1);
const IntentRevision = z.number().int().min(0);
const Format = z.enum(['reel', 'scroll']);
const OpaqueContentId = z.string().min(1).max(160);

/** Public, consumer-facing content only. No producer, source, score or model fields belong here. */
export const EncounterMetadataSchema = z.strictObject({
  kind: Format,
  title: z.string().min(1).max(240),
  summary: z.string().max(2000),
  language: z.string().min(1).max(35),
});

/**
 * An admitted relationship, never a claim inferred by the client. Only series steps carry Part
 * labels. A format sibling shares explanation identity; a related move is another explanation.
 * Series identity is opaque (the existing Scroll DSL uses opaque content IDs, not UUIDs).
 */
const SeriesPositionSchema = z.strictObject({
  seriesId: OpaqueContentId,
  seriesRevision: Revision,
  part: z.number().int().min(1).max(99),
});
const SeriesStepRelationSchema = SeriesPositionSchema.extend({ kind: z.literal('series_step') });
const RelatedMoveRelationSchema = z.strictObject({
  kind: z.literal('related_move'),
  label: z.string().min(1).max(160),
});

export const EncounterRelationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('discovery') }),
  SeriesStepRelationSchema,
  RelatedMoveRelationSchema,
  z.strictObject({ kind: z.literal('format_variant') }),
  z.strictObject({ kind: z.literal('return') }),
]);

/**
 * Existing inventory and an already-committed request are different states. `pending` may only
 * describe real durable supply work; navigation never creates a missing variant or a fake offer.
 * An absent sibling with no such request is `unavailable` until the content-request owner acts.
 */
export const FormatVariantSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), kind: Format, assetId: AssetIdSchema, assetRevision: Revision }),
  z.strictObject({ status: z.literal('pending'), kind: Format, requestId: UuidSchema }),
  z.strictObject({ status: z.literal('unavailable'), kind: Format }),
]);

/**
 * A prepared offer is not an exposure and grants no rendering/evidence authority. Activation must
 * recheck its owner/epoch, session intent, expiry, immutable revision and current asset eligibility
 * independently. Buffered offers are not observations. Decision IDs are opaque ops correlation.
 */
export const EncounterOfferSchema = z.strictObject({
  offerId: UuidSchema,
  decisionId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: Revision,
  explanationUnitId: OpaqueContentId,
  metadata: EncounterMetadataSchema,
  relation: EncounterRelationSchema,
  variants: z
    .array(FormatVariantSchema)
    .max(2)
    .refine(
      (variants) => new Set(variants.map((variant) => variant.kind)).size === variants.length,
      'One availability state per format.',
    ),
});

/** A Composer session, distinct from an authentication session; both revision fields travel together. */
export const ExperienceSessionRefSchema = z.strictObject({
  sessionId: UuidSchema,
  expectedIntentRevision: IntentRevision,
});

/** A displayed, admitted link and immutable target; a stale card must not silently change destination. */
export const ExpectedContinuationSchema = z.strictObject({
  linkId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: Revision,
});

/** Initial discovery omits `session`; resuming discovery names a session and its expected intent. */
export const OpenDiscoveryRequestSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    target: z.strictObject({ kind: z.literal('discover') }),
    session: ExperienceSessionRefSchema.optional(),
    capabilities: ClientCapabilities,
    recordingGeneration: RecordingGenerationSchema.optional(),
  })
  .refine((r) => !Object.hasOwn(r, 'recordingGeneration') || r.recordingGeneration !== undefined, {
    path: ['recordingGeneration'],
    message: 'A supplied recording generation must be defined.',
  });

/**
 * A deliberate fresh revisit, such as opening Saved before Explore has an active encounter. It
 * may create a Composer session without a `from` offer/exposure. The consumer must recheck both
 * current asset admission/access and this exact immutable revision; a saved reference never
 * bypasses withdrawal. It returns a Composer outcome, not the interim direct exposure response.
 * Opening alone is not consumption or a return bonus. Local anchors/playheads are not uploaded.
 */
export const OpenRevisitRequestSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    target: z.strictObject({ kind: z.literal('return'), assetId: AssetIdSchema, assetRevision: Revision }),
    session: ExperienceSessionRefSchema.optional(),
    capabilities: ClientCapabilities,
    recordingGeneration: RecordingGenerationSchema.optional(),
  })
  .refine((r) => !Object.hasOwn(r, 'recordingGeneration') || r.recordingGeneration !== undefined, {
    path: ['recordingGeneration'],
    message: 'A supplied recording generation must be defined.',
  });

/**
 * Semantic moves, not gesture directions. A previous series step is a new forward navigation in
 * history; it is never platform Back. `return` is an explicit fresh revisit (for example Saved),
 * whose qualification/separation is decided by evidence policy. Restoring a parked Back entry is
 * local AccountScope state, sends no command/activation and earns no new return contribution.
 * Exact block offsets, playheads and play state stay private in that local scope, never this wire.
 */
export const NavigationIntentSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('vertical'), direction: z.enum(['next', 'previous']) }),
  z.strictObject({
    mode: z.literal('series'),
    direction: z.enum(['next', 'previous']),
    expectedContinuation: ExpectedContinuationSchema.optional(),
  }),
  z.strictObject({ mode: z.literal('related'), expectedContinuation: ExpectedContinuationSchema.optional() }),
  z.strictObject({ mode: z.literal('variant'), to: Format }),
  z.strictObject({
    mode: z.literal('return'),
    target: z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision }),
  }),
]);

/**
 * One ID per deliberate move, reused unchanged on retry. Expected intent fences an old offline
 * command. `from` names a previously activated, still-authorised/eligible offer and exposure of
 * this session and epoch, including a locally parked member restored by Back. Expected intent is
 * always the latest server session revision, never a parked entry's captured revision. A new
 * deliberate move from that member commits a new intent; Back itself sends no command.
 * The server derives owner/epoch from the authenticated AccountScope, never from body fields.
 */
export const NavigateExperienceRequestSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    sessionId: UuidSchema,
    expectedIntentRevision: IntentRevision,
    from: z.strictObject({ offerId: UuidSchema, exposureId: UuidSchema }),
    intent: NavigationIntentSchema,
    recordingGeneration: RecordingGenerationSchema.optional(),
  })
  .refine((r) => !Object.hasOwn(r, 'recordingGeneration') || r.recordingGeneration !== undefined, {
    path: ['recordingGeneration'],
    message: 'A supplied recording generation must be defined.',
  });

const NavigationOutcomeFields = {
  commandId: CommandIdSchema,
  sessionId: UuidSchema,
  intentRevision: IntentRevision,
  /** Personal-scope catch-up watermark; separate from session intent revision. */
  revision: z.number().int().min(0),
  decisionId: UuidSchema,
  replayed: z.boolean(),
};

/**
 * Immutable receipt outcomes; a replay keeps its original pending state. No provider/network
 * wait on HTTP. Pending keeps the current encounter in place; exhaustion is a natural stopping
 * point and never fabricates Part N+1. No state auto-activates an offer or claims consumption.
 */
export const NavigationOutcomeSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      ...NavigationOutcomeFields,
      status: z.literal('ready'),
      offer: EncounterOfferSchema,
      bufferedOffers: z.array(EncounterOfferSchema).max(2),
    })
    .refine(({ offer, bufferedOffers }) => {
      const offers = [offer, ...bufferedOffers];
      return (
        new Set(offers.map((item) => item.offerId)).size === offers.length &&
        new Set(offers.map((item) => item.explanationUnitId)).size === offers.length
      );
    }, 'A buffer cannot repeat an offer or explanation through another format.'),
  z
    .strictObject({
      ...NavigationOutcomeFields,
      status: z.literal('pending'),
      reason: z.enum(['buffer_preparing', 'requested_supply_pending']),
      /** Present only when pending is backed by an existing, caller-authorised supply request. */
      requestId: UuidSchema.optional(),
    })
    .refine(
      (outcome) =>
        outcome.reason === 'requested_supply_pending'
          ? outcome.requestId !== undefined
          : outcome.requestId === undefined,
      'Supply pending requires a real request; buffer preparation has no supply request.',
    ),
  z.strictObject({
    ...NavigationOutcomeFields,
    status: z.literal('exhausted'),
    reason: z.enum([
      'no_eligible_content',
      'series_boundary',
      'no_related_ready',
      'variant_unavailable',
      'return_unavailable',
    ]),
  }),
]);

/**
 * Rechecks a prepared offer at activation, even after an identical navigation replay. No client
 * asset/position assertion can substitute for that authority check. The result is the existing
 * activation response plus the immutable asset/exposure lineage and session/offer identity.
 */
export const ActivateOfferRequestSchema = z
  .strictObject({
    commandId: CommandIdSchema,
    target: z.strictObject({
      kind: z.literal('offer'),
      sessionId: UuidSchema,
      offerId: UuidSchema,
      expectedIntentRevision: IntentRevision,
    }),
    recordingGeneration: RecordingGenerationSchema.optional(),
  })
  .refine((r) => !Object.hasOwn(r, 'recordingGeneration') || r.recordingGeneration !== undefined, {
    path: ['recordingGeneration'],
    message: 'A supplied recording generation must be defined.',
  });

export const ActivateOfferResponseSchema = z.strictObject({
  commandId: CommandIdSchema,
  sessionId: UuidSchema,
  offerId: UuidSchema,
  intentRevision: IntentRevision,
  exposureId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: Revision,
  kind: Format,
  activatedAt: z.iso.datetime(),
  revision: z.number().int().min(0),
  replayed: z.boolean(),
});

/** Public availability, not a prepared offer or rendering authority. No phantom target while pending. */
export const ContinuationStateSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    linkId: UuidSchema,
    target: z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision }),
    metadata: EncounterMetadataSchema,
    relation: z.discriminatedUnion('kind', [SeriesStepRelationSchema, RelatedMoveRelationSchema]),
  }),
  /** Only an existing, caller-authorised durable supply request may make a continuation pending. */
  z.strictObject({ status: z.literal('pending'), requestId: UuidSchema }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['series_boundary', 'no_related_ready', 'withdrawn']),
  }),
]);

export const ExposureContextRequestSchema = z.strictObject({ exposureId: UuidSchema });

/**
 * A current authorised read, never an immutable receipt/offer snapshot. The consumer validates
 * own activated exposure, epoch, exact asset revision and current eligibility without creating an
 * exposure. `session` exists only for Composer members and returns the latest session intent for
 * catch-up after Back or a stale-intent conflict. Positions stay in AccountScope, never this read.
 */
export const ExposureContextResponseSchema = z.strictObject({
  exposureId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: Revision,
  revision: z.number().int().min(0),
  session: z.strictObject({ sessionId: UuidSchema, intentRevision: IntentRevision }).optional(),
  actions: z.strictObject({ saved: z.boolean(), liked: z.boolean(), hidden: z.boolean() }),
  series: SeriesPositionSchema.optional(),
  variants: EncounterOfferSchema.shape.variants,
  continuations: z.strictObject({
    seriesPrevious: ContinuationStateSchema.refine(
      (state) => state.status !== 'ready' || state.relation.kind === 'series_step',
      'A series continuation must describe a declared series step.',
    ),
    seriesNext: ContinuationStateSchema.refine(
      (state) => state.status !== 'ready' || state.relation.kind === 'series_step',
      'A series continuation must describe a declared series step.',
    ),
    related: ContinuationStateSchema.refine(
      (state) => state.status !== 'ready' || state.relation.kind === 'related_move',
      'A related continuation cannot be labelled as a series part.',
    ),
  }),
});

export type EncounterMetadata = z.infer<typeof EncounterMetadataSchema>;
export type EncounterOffer = z.infer<typeof EncounterOfferSchema>;
export type OpenDiscoveryRequest = z.infer<typeof OpenDiscoveryRequestSchema>;
export type OpenRevisitRequest = z.infer<typeof OpenRevisitRequestSchema>;
export type NavigateExperienceRequest = z.infer<typeof NavigateExperienceRequestSchema>;
export type NavigationOutcome = z.infer<typeof NavigationOutcomeSchema>;
export type ActivateOfferRequest = z.infer<typeof ActivateOfferRequestSchema>;
export type ContinuationState = z.infer<typeof ContinuationStateSchema>;
export type ExposureContextResponse = z.infer<typeof ExposureContextResponseSchema>;

export const navigateExperienceContract = oc
  .route({ method: 'POST', path: '/v1/experience/navigate', successStatus: 200, tags: ['experience'] })
  .input(NavigateExperienceRequestSchema)
  .output(NavigationOutcomeSchema);

export const exposureContextContract = oc
  .route({
    method: 'GET',
    path: '/v1/experience/exposures/{exposureId}/context',
    successStatus: 200,
    tags: ['experience'],
  })
  .input(ExposureContextRequestSchema)
  .output(ExposureContextResponseSchema);
