import { oc } from '@orpc/contract';
import { z } from 'zod';
import { ClientCapabilities } from './content.js';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';

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
export const EncounterRelationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('discovery') }),
  z.strictObject({
    kind: z.literal('series_step'),
    seriesId: OpaqueContentId,
    seriesRevision: Revision,
    part: z.number().int().min(1).max(99),
  }),
  z.strictObject({ kind: z.literal('related_move'), label: z.string().min(1).max(160) }),
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

/** Initial discovery omits `session`; resuming discovery names a session and its expected intent. */
export const OpenDiscoveryRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  target: z.strictObject({ kind: z.literal('discover') }),
  session: ExperienceSessionRefSchema.optional(),
  capabilities: ClientCapabilities,
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
  z.strictObject({ mode: z.literal('series'), direction: z.enum(['next', 'previous']) }),
  z.strictObject({ mode: z.literal('related') }),
  z.strictObject({ mode: z.literal('variant'), to: Format }),
  z.strictObject({
    mode: z.literal('return'),
    target: z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision }),
  }),
]);

/**
 * One ID per deliberate move, reused unchanged on retry. Expected intent fences an old offline
 * command; `from` must match the session's authoritative current offer and activated exposure.
 * The server derives owner/epoch from the authenticated AccountScope, never from body fields.
 */
export const NavigateExperienceRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  sessionId: UuidSchema,
  expectedIntentRevision: IntentRevision,
  from: z.strictObject({ offerId: UuidSchema, exposureId: UuidSchema }),
  intent: NavigationIntentSchema,
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
export const ActivateOfferRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  target: z.strictObject({
    kind: z.literal('offer'),
    sessionId: UuidSchema,
    offerId: UuidSchema,
    expectedIntentRevision: IntentRevision,
  }),
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

export type EncounterMetadata = z.infer<typeof EncounterMetadataSchema>;
export type EncounterOffer = z.infer<typeof EncounterOfferSchema>;
export type OpenDiscoveryRequest = z.infer<typeof OpenDiscoveryRequestSchema>;
export type NavigateExperienceRequest = z.infer<typeof NavigateExperienceRequestSchema>;
export type NavigationOutcome = z.infer<typeof NavigationOutcomeSchema>;
export type ActivateOfferRequest = z.infer<typeof ActivateOfferRequestSchema>;

export const navigateExperienceContract = oc
  .route({ method: 'POST', path: '/v1/experience/navigate', successStatus: 200, tags: ['experience'] })
  .input(NavigateExperienceRequestSchema)
  .output(NavigationOutcomeSchema);
