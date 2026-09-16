import {z} from 'zod';

/** ADR-0012 metadata contracts. Parsing is not authorization or a database transition. */
const id = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const instant = z.iso.datetime({offset:true});
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = count.min(1);
const epoch = z.number().int().min(0).max(2147483647);
/** PostgreSQL bigint wire values never pass through a lossy JS number. */
export const reasoningCounter = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint');
const fence = reasoningCounter.refine((value) => value !== '0', 'A claimed lease needs a positive fence');

export const reasoningClass = z.enum([
  'interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping',
]);
export const reasoningJobState = z.enum(['queued','running','waiting','completed','failed','cancelled','expired']);
export const reasoningStepState = z.enum(['pending','active','awaiting_reconciliation','succeeded','failed','cancelled','superseded']);
export const reasoningWake = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('direct'),intentId:id}).strict(),
  z.object({kind:z.literal('dirty'),scopeKey:label,throughSequence:reasoningCounter}).strict(),
]);
export const reasoningLease = z.object({owner:label,fence,expiresAt:instant}).strict();
export const reasoningJob = z.object({
  version:z.literal(1),jobId:id,universeId:id,privacyEpoch:epoch,wake:reasoningWake,
  class:reasoningClass,state:reasoningJobState,deadline:instant,
  budgetOwnerId:id,policyVersion:label,lease:reasoningLease.nullable(),
}).strict();
export const reasoningStep = z.object({
  version:z.literal(1),stepId:id,jobId:id,universeId:id,privacyEpoch:epoch,
  state:reasoningStepState,ordinal:positiveCount,contextBundleId:id,
}).strict();

export const reasoningRead = z.object({
  kind:z.enum(['entity','source','permission','policy']),
  scope:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('universe'),universeId:id}).strict(),
    z.object({kind:z.literal('public')}).strict(),
  ]),
  key:label,revision:reasoningCounter,
}).strict();
export const reasoningContext = z.object({
  version:z.literal(1),contextBundleId:id,jobId:id,universeId:id,privacyEpoch:epoch,
  contentHash:hash,policyVersion:label,sourcePolicyVersion:label,
  reads:z.array(reasoningRead).max(1024),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, read] of value.reads.entries()) {
    if (read.scope.kind === 'universe' && read.scope.universeId !== value.universeId) {
      context.addIssue({code:'custom',path:['reads',index,'scope'],message:'Foreign private scope'});
    }
    const key = JSON.stringify([read.kind,read.scope,read.key]);
    if (seen.has(key)) context.addIssue({code:'custom',path:['reads',index],message:'Duplicate read identity'});
    seen.add(key);
  }
});

export const reasoningUsage = z.object({
  inputTokens:count.nullable(),outputTokens:count.nullable(),
  cacheReadTokens:count.nullable(),cacheWriteTokens:count.nullable(),
  costMicroUsd:count.nullable(),
}).strict();
export const reasoningReservation = z.object({
  reservationId:id,bucketId:id,attemptId:id,reservationSetId:id,
  state:z.enum(['held','accounted','released']),
  dimension:z.enum(['global_budget','owner_budget','provider_account','route_quota','request_rate',
    'input_rate','output_rate','combined_rate','remote_concurrency','job_budget']),
  unit:z.enum(['tokens','requests','slots','micro_usd']),amount:positiveCount,
  windowId:label.nullable(),
}).strict();
export const reasoningPermit = z.object({
  version:z.literal(1),permitId:id,attemptId:id,reservationSetId:id,
  routeId:label,routeProfileVersion:label,expiresAt:instant,
  lifecycle:z.discriminatedUnion('state',[
    z.object({state:z.literal('reserved')}).strict(),
    z.object({state:z.literal('consumed'),dispatchId:id,consumedAt:instant}).strict(),
    z.object({state:z.literal('revoked'),closedAt:instant}).strict(),
    z.object({state:z.literal('expired'),closedAt:instant}).strict(),
  ]),
  reservations:z.array(reasoningReservation).min(1).max(64),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const buckets = new Set<string>();
  value.reservations.forEach((reservation,index) => {
    if (reservation.attemptId !== value.attemptId || reservation.reservationSetId !== value.reservationSetId) {
      context.addIssue({code:'custom',path:['reservations',index],message:'Foreign attempt or reservation set'});
    }
    if (ids.has(reservation.reservationId) || buckets.has(reservation.bucketId)) {
      context.addIssue({code:'custom',path:['reservations',index],message:'Duplicate reservation or bucket'});
    }
    ids.add(reservation.reservationId);buckets.add(reservation.bucketId);
    const unitByDimension: Record<string,string> = {request_rate:'requests',input_rate:'tokens',output_rate:'tokens',
      combined_rate:'tokens',remote_concurrency:'slots'};
    const expected = unitByDimension[reservation.dimension];
    if (expected && reservation.unit !== expected) {
      context.addIssue({code:'custom',path:['reservations',index,'unit'],message:'Incompatible reservation unit'});
    }
  });
});

const dispatched = {dispatchId:id,committedAt:instant};
export const reasoningDispatch = z.discriminatedUnion('state',[
  z.object({state:z.literal('reserved')}).strict(),
  z.object({state:z.literal('dispatch_committed'),...dispatched}).strict(),
  z.object({state:z.literal('unknown'),...dispatched,observedAt:instant,
    reason:z.enum(['transport_loss','deadline','local_cancel','lease_loss','crash'])}).strict(),
  z.object({state:z.literal('responded'),...dispatched,receiptId:id,receivedAt:instant,
    outcome:z.enum(['success','refusal','error','unclassified']),
    remoteDisposition:z.enum(['terminal','unconfirmed'])}).strict(),
  z.object({state:z.literal('not_sent'),closedAt:instant,
    reason:z.enum(['cancelled','expired','privacy_changed','lease_lost','permit_expired'])}).strict(),
]);
export const reasoningAttempt = z.object({
  version:z.literal(1),attemptId:id,jobId:id,stepId:id,universeId:id,privacyEpoch:epoch,
  ordinal:positiveCount,previousAttemptId:id.nullable(),
  leaseFence:fence,contextBundleId:id,requestId:id,requestHash:hash,
  routeId:label,routeProfileVersion:label,permitId:id,reservationSetId:id,
  maxOutputTokens:positiveCount,deadline:instant,dispatch:reasoningDispatch,
  outputAuthority:z.enum(['eligible','withdrawn']),
}).strict().superRefine((value, context) => {
  if ((value.ordinal === 1) !== (value.previousAttemptId === null) || value.previousAttemptId === value.attemptId) {
    context.addIssue({code:'custom',path:['previousAttemptId'],message:'Invalid attempt lineage'});
  }
  const withdrawn = value.dispatch.state === 'not_sent' || (value.dispatch.state === 'unknown' &&
    (value.dispatch.reason === 'deadline' || value.dispatch.reason === 'local_cancel'));
  if (withdrawn && value.outputAuthority !== 'withdrawn') {
    context.addIssue({code:'custom',path:['outputAuthority'],message:'Closed or cancelled output must be withdrawn'});
  }
});

/** Minimal restricted receipt input, never a provider callback/public client body. */
export const reasoningReceipt = z.object({
  version:z.literal(1),receiptId:id,attemptId:id,dispatchId:id,requestId:id,
  routeId:label,routeProfileVersion:label,
  evidenceKind:z.enum(['original_transport','provider_lookup','operator_reconciliation']),
  observedAt:instant,remoteDisposition:z.enum(['terminal','unconfirmed']),
  outcome:z.enum(['success','refusal','error','unclassified']),
  httpStatus:z.number().int().min(100).max(599).nullable(),usage:reasoningUsage,
}).strict();
export const reasoningSettlement = z.object({
  version:z.literal(1),settlementId:id,attemptId:id,receiptId:id,
  receiptFingerprint:hash,basis:z.enum(['measured','conservative_closure']),
  revision:positiveCount,supersedesSettlementId:id.nullable(),
  adjustments:z.array(z.object({bucketId:id,unit:z.enum(['tokens','requests','slots','micro_usd']),
    delta:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)}).strict()).max(64),
  usage:reasoningUsage,
  liability:z.enum(['held','partially_settled','settled']),
  remoteConcurrency:z.enum(['held','released']),
}).strict().superRefine((value, context) => {
  if ((value.revision === 1) !== (value.supersedesSettlementId === null) || value.supersedesSettlementId === value.settlementId) {
    context.addIssue({code:'custom',path:['supersedesSettlementId'],message:'Invalid settlement revision lineage'});
  }
  if (new Set(value.adjustments.map((adjustment)=>adjustment.bucketId)).size !== value.adjustments.length) {
    context.addIssue({code:'custom',path:['adjustments'],message:'Duplicate adjustment bucket'});
  }
});

/** These are protocol edges, not executable transition authorization. ADR guards also apply. */
export const REASONING_ATTEMPT_EDGES = {
  reserved:['dispatch_committed','not_sent'],
  dispatch_committed:['responded','unknown'],
  unknown:['responded'],
  responded:['responded'], // New authenticated evidence; append a revision, never resend.
  not_sent:[],
} as const;

export type ReasoningJob = z.infer<typeof reasoningJob>;
export type ReasoningStep = z.infer<typeof reasoningStep>;
export type ReasoningContext = z.infer<typeof reasoningContext>;
export type ReasoningPermit = z.infer<typeof reasoningPermit>;
export type ReasoningAttempt = z.infer<typeof reasoningAttempt>;
export type ReasoningReceipt = z.infer<typeof reasoningReceipt>;
export type ReasoningSettlement = z.infer<typeof reasoningSettlement>;
