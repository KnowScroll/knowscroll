import { oc } from '@orpc/contract';
import { z } from 'zod';
import { UuidSchema } from './ids.js';

/**
 * Operator (#248, D-044): what an operator sees of the running system. Not consumer UI: the server
 * answers every route here with `NOT_FOUND` (404) unless the signed-in account is one of the
 * world's operators, so a normal account learns nothing about it. The answers are read from the
 * allowlisted `ops` views: IDs, states, times, counts and codes. Never a prompt, a model answer, a
 * request or message text, an address or a score.
 */

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Time = z.iso.datetime();
const Code = z.string().min(1).max(80);

/** A source Tier 0 has none for, or a view that could not be read. Shown as unavailable, never estimated. */
export const OperatorUnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: z.enum(['no_tier0_source', 'view_missing', 'read_failed']),
});

function piece<T extends z.ZodType>(data: T) {
  return z.union([z.strictObject({ status: z.literal('available'), data }), OperatorUnavailableSchema]);
}

const QueueRow = z.strictObject({
  queue: Code,
  ready: Count,
  scheduled: Count,
  retrying: Count,
  active: Count,
  failed: Count,
  oldestWaitingSeconds: Count.nullable(),
  lastCompletedAt: Time.nullable(),
});

const OutcomeCount = z.strictObject({ state: Code, count: Count });

const ErrorRow = z.strictObject({
  occurredAt: Time,
  source: Code,
  refId: UuidSchema,
  state: Code.nullable(),
  code: Code.nullable(),
  label: Code.nullable(),
});

const ProductionRunRow = z.strictObject({
  productionRunId: UuidSchema,
  recipeKey: Code,
  take: Count,
  state: Code,
  writerRunState: Code.nullable(),
  modelAttempts: Count,
  refusedAnswers: Count,
  assetId: UuidSchema.nullable(),
  createdAt: Time,
  completedAt: Time.nullable(),
});

const RefusedAnswerRow = z.strictObject({
  attemptId: UuidSchema,
  step: Code.nullable(),
  model: Code.nullable(),
  reason: Code.nullable(),
  issueCount: Count,
  issueCodes: z.array(Code).max(64),
  answerChars: Count,
  truncated: z.boolean(),
  recordedAt: Time,
});

const ReelOrderRow = z.strictObject({
  reelOrderId: UuidSchema,
  scriptName: Code,
  until: Code,
  attempts: Count,
  settledCents: Count,
  claimedOpenCents: Count,
  latestAttemptState: Code.nullable(),
  createdAt: Time,
  publishedAt: Time.nullable(),
});

const UsageSummary = z.strictObject({
  windowHours: Count,
  attempts: Count,
  tokensReported: Count,
  attemptsWithoutReportedUsage: Count,
});

const CartographerSummary = z.strictObject({
  counts: z.array(OutcomeCount).max(16),
  recent: z
    .array(
      z.strictObject({
        runId: UuidSchema,
        status: Code,
        outcome: Code.nullable(),
        desiredRevision: Count,
        updatedAt: Time,
      }),
    )
    .max(50),
});

const PrivacySummary = z.strictObject({
  groups: z.array(z.strictObject({ kind: Code, state: Code, count: Count, oldestRequestedAt: Time })).max(32),
  failed: z
    .array(z.strictObject({ operationId: UuidSchema, kind: Code, failureCode: Code, requestedAt: Time }))
    .max(50),
});

/** The six panels of the Operator artboard, read at one moment. */
export const OperatorPanelsSchema = z.strictObject({
  generatedAt: Time,
  overview: z.strictObject({
    queues: piece(z.array(QueueRow).max(60)),
    providerOutcomes: piece(z.array(OutcomeCount).max(16)),
    recentErrors: piece(z.array(ErrorRow).max(50)),
    serviceHealth: OperatorUnavailableSchema,
    requestLatency: OperatorUnavailableSchema,
    mediaDisk: OperatorUnavailableSchema,
  }),
  production: z.strictObject({
    runs: piece(z.array(ProductionRunRow).max(50)),
    refusedAnswers: piece(z.array(RefusedAnswerRow).max(50)),
    reelOrders: piece(z.array(ReelOrderRow).max(50)),
    usage: piece(UsageSummary),
  }),
  universeChange: z.strictObject({ cartographer: piece(CartographerSummary) }),
  realtime: z.strictObject({ delivery: OperatorUnavailableSchema }),
  privacy: z.strictObject({
    operations: piece(PrivacySummary),
    retentionJobs: piece(z.array(QueueRow).max(60)),
    droppedDiagnostics: OperatorUnavailableSchema,
  }),
});

export type OperatorPanelsResponse = z.infer<typeof OperatorPanelsSchema>;

/** Reads the panels. `NOT_FOUND` (404) for anyone who is not an operator of this world. */
export const readOperatorPanelsContract = oc
  .route({ method: 'GET', path: '/v1/operator/panels', successStatus: 200, tags: ['operator'] })
  .output(OperatorPanelsSchema);

export const JourneySubjectSchema = z.enum([
  'request',
  'production_run',
  'exposure',
  'reel_order',
  'attempt',
  'run',
  'asset',
  'universe',
]);

const JourneyStep = z.strictObject({
  at: Time,
  endedAt: Time.nullable(),
  stage: Code,
  title: z.string().min(1).max(80),
  state: Code.nullable(),
  code: Code.nullable(),
  label: Code.nullable(),
  count: Count.nullable(),
  ref: UuidSchema.nullable(),
  scope: z.enum(['personal', 'shared']),
});

/** A timeline across modules, oldest first, with the gaps the records leave and whether it was cut short. */
export const JourneySchema = z.strictObject({
  subject: JourneySubjectSchema,
  subjectId: UuidSchema,
  steps: z.array(JourneyStep).max(300),
  gaps: z.array(z.strictObject({ stage: Code, ref: UuidSchema.nullable(), note: z.string().min(1).max(200) })).max(300),
  truncated: z.boolean(),
});

export type JourneyResponse = z.infer<typeof JourneySchema>;

/**
 * The journey of one record: a request, production run, Reel order, model attempt, reasoning run,
 * exposure or asset. An asset answers with its shared steps only. `NOT_FOUND` (404) when nothing
 * carries the ID, and for anyone who is not an operator.
 */
export const readOperatorJourneyContract = oc
  .route({ method: 'GET', path: '/v1/operator/journeys/{id}', successStatus: 200, tags: ['operator'] })
  .input(z.strictObject({ id: UuidSchema }))
  .output(JourneySchema);

export const operatorContract = {
  panels: readOperatorPanelsContract,
  journey: readOperatorJourneyContract,
};
