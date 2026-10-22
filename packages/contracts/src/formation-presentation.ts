import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { GeographyRevisionsSchema } from './geography.js';
import { SceneClientCapabilitiesSchema, SceneReadScopeSchema, supportsSceneV1 } from './scenes.js';
import { problemCatalogue, problemTypeUri } from './problems.js';

/** Delivery policy only: no formation threshold, consumption or learning assertion. */
export const FORMATION_PRESENTATION_POLICY = {
  version: 'formation-presentation.v1',
  freshnessSeconds: 300,
  claimSeconds: 30,
  fullDurationMs: 2400,
  maxTargets: 8,
} as const;
const Version = z.literal(FORMATION_PRESENTATION_POLICY.version);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Time = z.iso.datetime();
const Label = z
  .string()
  .min(1)
  .max(160)
  .refine((s) => s.trim().length > 0);

/** Minimized actual committed creation facts, never a proposal or client formation command.
 * Scene must independently prove current manifest/chunk target readiness before eligibility.
 * Labels, truth framing and IDs belong to the own account/epoch; no support/source/score/geometry. */
export const FormationPresentationFactSchema = z
  .strictObject({
    transitionId: UuidSchema,
    recordedAt: Time,
    geography: GeographyRevisionsSchema,
    targets: z
      .array(
        z.strictObject({
          objectId: UuidSchema,
          parentId: UuidSchema,
          kind: z.enum(['system', 'star', 'planet', 'region']),
          objectRevision: Revision,
          label: Label,
          truthStatus: z.enum(['factual', 'hypothetical']),
        }),
      )
      .min(1)
      .max(FORMATION_PRESENTATION_POLICY.maxTargets),
    sequence: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('final_still') }),
      z.strictObject({
        kind: z.literal('planet'),
        planetId: UuidSchema,
        /** Only matching system AND star creations in this same commit enable new-system beats. */
        newSystem: z.strictObject({ systemId: UuidSchema, starId: UuidSchema }).optional(),
        durationMs: z.literal(FORMATION_PRESENTATION_POLICY.fullDurationMs),
      }),
    ]),
  })
  .superRefine((f, ctx) => {
    if (
      f.geography.structureRevision !== f.geography.revision ||
      new Set(f.targets.map((t) => t.objectId)).size !== f.targets.length ||
      f.targets.some((t) => t.objectRevision !== f.geography.revision || t.objectId === t.parentId)
    )
      ctx.addIssue({ code: 'custom', message: 'Creation facts must retain their exact committed identities.' });
    for (const target of f.targets) {
      const parent = f.targets.find((t) => t.objectId === target.parentId);
      if (
        parent &&
        (target.kind === 'system' ||
          parent.kind !== (target.kind === 'region' ? 'planet' : 'system') ||
          parent.truthStatus !== target.truthStatus)
      )
        ctx.addIssue({ code: 'custom', message: 'Creation parent identity and truth framing must agree.' });
    }
    if (f.sequence.kind !== 'planet') return;
    const sequence = f.sequence;
    const planet = f.targets.find((t) => t.objectId === sequence.planetId && t.kind === 'planet');
    if (
      !planet ||
      (sequence.newSystem &&
        !(['system', 'star'] as const).every((kind) =>
          f.targets.some(
            (t) =>
              t.kind === kind &&
              t.objectId === (kind === 'system' ? sequence.newSystem!.systemId : sequence.newSystem!.starId) &&
              t.truthStatus === planet.truthStatus &&
              (kind !== 'star' || t.parentId === sequence.newSystem!.systemId) &&
              planet.parentId === sequence.newSystem!.systemId,
          ),
        ))
    )
      ctx.addIssue({ code: 'custom', message: 'Sequence beats require matching actual creation facts.' });
  });

export const FormationPresentationReadTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('next') }),
  z.strictObject({ kind: z.literal('transition'), transitionId: UuidSchema }),
]);
/** Read only: no claim/receipt/shown mark, expiry cleanup, job or model call. */
export const ReadFormationPresentationSchema = z.strictObject({
  version: Version,
  readId: UuidSchema,
  target: FormationPresentationReadTargetSchema,
  capabilities: SceneClientCapabilitiesSchema,
});
const ReadFields = {
  version: Version,
  readId: UuidSchema,
  scope: SceneReadScopeSchema,
  target: FormationPresentationReadTargetSchema,
  capabilities: SceneClientCapabilitiesSchema,
  recordedAt: Time,
  currentGeography: GeographyRevisionsSchema,
  sceneRevision: Counter,
};
const Eligibility = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('claimable'), until: Time }),
  z.strictObject({ status: z.literal('final'), reason: z.enum(['late', 'already_claimed', 'terminal']) }),
]);
/** At most one candidate, max8 targets. final means render the existing map's final state;
 * never replay a story or invent shown. Claimable is not a claim or animation permission.
 * Compare readId/selection/capabilities/current AccountScope and nonregressive watermarks.
 * Syntax cannot prove current projection, real formation or server single-claim uniqueness. */
export const FormationPresentationReadSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...ReadFields, status: z.literal('none') }),
    z.strictObject({
      ...ReadFields,
      status: z.literal('available'),
      fact: FormationPresentationFactSchema,
      eligibility: Eligibility,
    }),
    z.strictObject({
      ...ReadFields,
      status: z.literal('unavailable'),
      reason: z.enum(['temporarily_unavailable', 'target_unavailable', 'projection_pending', 'limit']),
    }),
    z.strictObject({ ...ReadFields, status: z.literal('unsupported_version') }),
  ])
  .superRefine((s, ctx) => {
    if (
      (s.status === 'available' && !supportsSceneV1(s.capabilities)) ||
      (s.status === 'unsupported_version' && supportsSceneV1(s.capabilities)) ||
      (s.status === 'none' && s.target.kind !== 'next')
    )
      ctx.addIssue({ code: 'custom', message: 'Read state is inconsistent with its selection or capabilities.' });
    if (s.status !== 'available') return;
    const f = s.fact;
    if (
      (s.target.kind === 'transition' && s.target.transitionId !== f.transitionId) ||
      f.geography.revision > s.currentGeography.revision ||
      f.geography.structureRevision > s.currentGeography.structureRevision ||
      f.geography.activityRevision > s.currentGeography.activityRevision ||
      f.targets.some((t) => t.kind === 'system' && t.parentId !== s.scope.universeId) ||
      Date.parse(f.recordedAt) > Date.parse(s.recordedAt) ||
      s.sceneRevision === 0
    )
      ctx.addIssue({ code: 'custom', message: 'Presentation must bind an actual current projected transition.' });
    if (
      s.eligibility.status === 'claimable' &&
      (Date.parse(s.eligibility.until) !==
        Date.parse(f.recordedAt) + FORMATION_PRESENTATION_POLICY.freshnessSeconds * 1000 ||
        Date.parse(s.recordedAt) >= Date.parse(s.eligibility.until))
    )
      ctx.addIssue({ code: 'custom', message: 'Animation freshness cannot be renewed by a read.' });
  });

/** One fresh local attempt nonce and command per deliberate claim, identical body on unknown.
 * At-most-one server claim for the transition across devices MUST commit before animation.
 * No client clock, claimed owner, presentation status or duration can supply authority. */
export const ClaimFormationPresentationSchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  transitionId: UuidSchema,
  attemptNonce: UuidSchema,
});
export const FormationPresentationClaimSchema = z
  .strictObject({
    claimId: UuidSchema,
    claimedAt: Time,
    expiresAt: Time,
  })
  .refine(
    (c) => Date.parse(c.expiresAt) === Date.parse(c.claimedAt) + FORMATION_PRESENTATION_POLICY.claimSeconds * 1000,
  );
const ReceiptFields = {
  commandId: CommandIdSchema,
  transitionId: UuidSchema,
  attemptNonce: UuidSchema,
  recordedAt: Time,
};
/** Historical immutable receipt. replayed never renews expiry and is NEVER animation eligibility. */
export const FormationPresentationClaimReceiptSchema = z
  .discriminatedUnion('outcome', [
    z.strictObject({ ...ReceiptFields, outcome: z.literal('claimed'), claim: FormationPresentationClaimSchema }),
    z.strictObject({
      ...ReceiptFields,
      outcome: z.literal('not_claimed'),
      reason: z.enum(['already_claimed', 'terminal', 'expired', 'unavailable']),
    }),
  ])
  .refine((r) => r.outcome !== 'claimed' || r.recordedAt === r.claim.claimedAt);
const CurrentClaim = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('active'), observedAt: Time, claimId: UuidSchema, expiresAt: Time }),
  z.strictObject({
    status: z.literal('final'),
    observedAt: Time,
    reason: z.enum(['expired', 'terminal', 'unavailable', 'not_claimed']),
  }),
]);
/** Current authority/status is separate from immutable replay. Only active + exact receipt claim
 * + fresh actual AccountScope may start ONE local attempt. Recheck expiry/foreground before start;
 * synchronously fence duplicate callbacks/remounts. No optimistic start on lost acknowledgement.
 * An expired claimed receipt returns current final; no reissue or new claim after reload. */
export const FormationPresentationClaimAcceptanceSchema = z
  .strictObject({
    version: Version,
    scope: SceneReadScopeSchema,
    receipt: FormationPresentationClaimReceiptSchema,
    replayed: z.boolean(),
    current: CurrentClaim,
  })
  .superRefine((s, ctx) => {
    const r = s.receipt,
      c = s.current;
    if (Date.parse(c.observedAt) < Date.parse(r.recordedAt))
      ctx.addIssue({ code: 'custom', message: 'Current claim status cannot predate its receipt.' });
    if (
      c.status === 'final' &&
      ((c.reason === 'expired' &&
        (r.outcome !== 'claimed' || Date.parse(c.observedAt) < Date.parse(r.claim.expiresAt))) ||
        (c.reason === 'not_claimed' && r.outcome !== 'not_claimed'))
    )
      ctx.addIssue({ code: 'custom', message: 'Final claim status must retain its actual receipt outcome.' });
    if (
      c.status === 'active' &&
      (r.outcome !== 'claimed' ||
        c.claimId !== r.claim.claimId ||
        c.expiresAt !== r.claim.expiresAt ||
        Date.parse(c.observedAt) >= Date.parse(c.expiresAt))
    )
      ctx.addIssue({ code: 'custom', message: 'Historical receipt cannot renew or replace animation eligibility.' });
  });

const Disposition = z.enum(['shown', 'skipped']);
/** shown follows actual completed full sequence OR mounted reduced-motion final still/caption.
 * Skip, background/leave/interruption use skipped. Scope end stops locally and dispatches nothing
 * under another scope. Neither acknowledgement is consumption, learning or formation evidence. */
export const AcknowledgeFormationPresentationSchema = z.strictObject({
  version: Version,
  commandId: CommandIdSchema,
  transitionId: UuidSchema,
  claimId: UuidSchema,
  attemptNonce: UuidSchema,
  disposition: Disposition,
});
/** Immutable terminal receipt. An already terminal claim retains its actual old disposition;
 * a delayed shown cannot overwrite an expiry/interruption skip. Retry only the original body. */
export const FormationPresentationAcknowledgementSchema = z
  .strictObject({
    version: Version,
    scope: SceneReadScopeSchema,
    commandId: CommandIdSchema,
    transitionId: UuidSchema,
    claimId: UuidSchema,
    attemptNonce: UuidSchema,
    recordedAt: Time,
    replayed: z.boolean(),
    requestedDisposition: Disposition,
    disposition: Disposition,
    outcome: z.enum(['recorded', 'already_terminal']),
  })
  .refine((s) => s.outcome === 'already_terminal' || s.requestedDisposition === s.disposition);

export const FormationPresentationProblemIssueSchema = z.strictObject({
  path: z
    .array(
      z.enum([
        'version',
        'readId',
        'commandId',
        'target',
        'kind',
        'transitionId',
        'claimId',
        'attemptNonce',
        'disposition',
        'capabilities',
        'descriptors',
        'chunks',
        'manifests',
        'generators',
        'families',
        'detail',
        'reducedMotion',
        'unknown',
      ]),
    )
    .max(8),
  code: z.enum([
    'invalid_type',
    'invalid_value',
    'invalid_union',
    'too_small',
    'too_big',
    'invalid_format',
    'unrecognized_keys',
    'custom',
  ]),
});
const Codes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'CONFLICT',
  'COMMAND_KEY_REUSED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_REQUEST',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
function error<C extends (typeof Codes)[number]>(code: C) {
  const d = problemCatalogue[code];
  return {
    status: d.status,
    message: d.title,
    data: z.strictObject({
      type: z.literal(problemTypeUri(code)),
      title: z.literal<(typeof problemCatalogue)[C]['title']>(d.title),
      status: z.literal<(typeof problemCatalogue)[C]['status']>(d.status),
      code: z.literal(code),
      issues: z.array(FormationPresentationProblemIssueSchema).max(32).optional(),
    }),
  };
}
const errors = {
  INVALID_REQUEST: error('INVALID_REQUEST'),
  UNAUTHENTICATED: error('UNAUTHENTICATED'),
  FORBIDDEN: error('FORBIDDEN'),
  ORIGIN_NOT_ALLOWED: error('ORIGIN_NOT_ALLOWED'),
  UNIVERSE_UNAVAILABLE: error('UNIVERSE_UNAVAILABLE'),
  PRIVACY_EPOCH_CHANGED: error('PRIVACY_EPOCH_CHANGED'),
  SCOPE_MISMATCH: error('SCOPE_MISMATCH'),
  CONFLICT: error('CONFLICT'),
  COMMAND_KEY_REUSED: error('COMMAND_KEY_REUSED'),
  PAYLOAD_TOO_LARGE: error('PAYLOAD_TOO_LARGE'),
  UNSUPPORTED_MEDIA_TYPE: error('UNSUPPORTED_MEDIA_TYPE'),
  UNPROCESSABLE_REQUEST: error('UNPROCESSABLE_REQUEST'),
  SERVICE_UNAVAILABLE: error('SERVICE_UNAVAILABLE'),
  INTERNAL: error('INTERNAL'),
};
export const FormationPresentationProblemSchema = z.union(Object.values(errors).map((e) => e.data));
/** Converter-produced direct RFC9457 documents; no HTTP serializer or consumer is installed. */
function problemResponses(operation: OpenAPI.OperationObject): OpenAPI.OperationObject {
  for (const status of new Set(Codes.map((c) => String(problemCatalogue[c].status)))) {
    const response = operation.responses?.[status];
    if (!response || '$ref' in response) throw new Error('Missing formation presentation error metadata');
    const schema = response.content?.['application/json']?.schema;
    if (!schema || '$ref' in schema || !schema.oneOf)
      throw new Error('Unsupported formation presentation error metadata');
    const documents = schema.oneOf.flatMap((b) => {
      if (
        '$ref' in b ||
        !b.properties ||
        !('data' in b.properties) ||
        !b.properties['defined'] ||
        '$ref' in b.properties['defined'] ||
        b.properties['defined'].const !== true
      )
        return [];
      return [b.properties['data']];
    });
    if (documents.length !== Codes.filter((c) => String(problemCatalogue[c].status) === status).length)
      throw new Error('Incomplete formation presentation error metadata');
    response.content = { 'application/problem+json': { schema: { oneOf: documents } } };
  }
  return operation;
}
const route = { method: 'POST', successStatus: 200, tags: ['universe'], spec: problemResponses } as const;
/** Declarations only: later consumers own current scope/epoch/Clear, no-store, real committed
 * facts, single-claim transaction/receipts, finite expiry recovery and complete erasure. */
export const formationPresentationContract = {
  read: oc
    .route({ ...route, path: '/v1/universe/formation/read' })
    .errors(errors)
    .input(ReadFormationPresentationSchema)
    .output(FormationPresentationReadSchema),
  claim: oc
    .route({ ...route, path: '/v1/universe/formation/claim' })
    .errors(errors)
    .input(ClaimFormationPresentationSchema)
    .output(FormationPresentationClaimAcceptanceSchema),
  acknowledge: oc
    .route({ ...route, path: '/v1/universe/formation/acknowledge' })
    .errors(errors)
    .input(AcknowledgeFormationPresentationSchema)
    .output(FormationPresentationAcknowledgementSchema),
};
export type FormationPresentationFact = z.infer<typeof FormationPresentationFactSchema>;
export type ReadFormationPresentation = z.infer<typeof ReadFormationPresentationSchema>;
export type FormationPresentationRead = z.infer<typeof FormationPresentationReadSchema>;
export type ClaimFormationPresentation = z.infer<typeof ClaimFormationPresentationSchema>;
export type FormationPresentationClaim = z.infer<typeof FormationPresentationClaimSchema>;
export type FormationPresentationClaimReceipt = z.infer<typeof FormationPresentationClaimReceiptSchema>;
export type FormationPresentationClaimAcceptance = z.infer<typeof FormationPresentationClaimAcceptanceSchema>;
export type AcknowledgeFormationPresentation = z.infer<typeof AcknowledgeFormationPresentationSchema>;
export type FormationPresentationAcknowledgement = z.infer<typeof FormationPresentationAcknowledgementSchema>;
export type FormationPresentationProblem = z.infer<typeof FormationPresentationProblemSchema>;
