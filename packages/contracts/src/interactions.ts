import { oc } from '@orpc/contract';
import { INTERACTION_KINDS, LocalId } from '@knowscroll/scroll-model';
import { z } from 'zod';
import { AssetIdSchema, UuidSchema } from './ids.js';

/**
 * Observations (blueprint §6 "An observation example", §18 "Shared interaction recorder", §19).
 * The recorder in `client-core` batches what it saw while a Scroll was the active reading surface;
 * `POST /v1/observations/batch` stores it. Acknowledgement means **stored**, never projected: the
 * projected evidence watermark is a different thing, read through the dev diagnostics route.
 *
 * Rules the shapes enforce:
 * - an event names its exposure, asset and revision; the server derives the owner, privacy epoch
 *   and trusted lineage, and never accepts an owner from the client;
 * - times are milliseconds since the recorder started (a monotonic clock), so a client's wall
 *   clock never decides what was seen; `occurredAt` is client wall time, used only as a sanity
 *   check and clamped to the receive time when it claims the future;
 * - payloads are bounded and carry block IDs and numbers only: no text, no pointer frames, and
 *   never a simulation parameter value (D-012);
 * - an event ID is the idempotency key: a retried batch carries the same IDs and counts once.
 */
export const INTERACTION_SCHEMA_VERSION = 'interaction.v1';

/** The observation kinds a Scroll reader emits (`scroll.*`); the server refuses any other kind. */
export const OBSERVATION_KINDS = [
  'scroll.block_coverage',
  'scroll.active_dwell',
  'scroll.block_interaction',
  'reel.playback',
] as const;

/**
 * Deliberate block interactions a reader reports, by kind of gesture, never by value:
 * a control changed or reset, a step moved, a disclosure opened or closed, a drag finished, text
 * copied, the text version opened, a failed block retried.
 */
export const SCROLL_INTERACTION_KINDS = Object.values(INTERACTION_KINDS).flat();
export type ScrollInteractionKind = (typeof SCROLL_INTERACTION_KINDS)[number];

/**
 * Versioned limits of the intake (`observation-limits.v1`), shared so the recorder never builds a
 * batch the server refuses. Bench values, not measured optima; a change is a new version.
 */
export const OBSERVATION_LIMITS = {
  version: 'observation-limits.v1',
  /** Events in one batch. */
  maxEventsPerBatch: 50,
  /** Canonical JSON of one batch request, below the API's 64 KiB body limit. */
  maxBatchBytes: 49_152,
  /** Blocks one coverage event may report (with the next limit, a stored payload stays under 8 KiB). */
  maxBlocksPerCoverage: 24,
  /** Visible intervals one block reports per event. */
  maxIntervalsPerBlock: 8,
  /** Active intervals one dwell event reports. */
  maxActiveIntervals: 64,
  /** Observations stored for one exposure; the intake refuses the rest. */
  maxEventsPerExposure: 1_000,
  /** The longest interval or time offset a client may claim (24 hours). */
  maxClaimMs: 86_400_000,
} as const;

/**
 * The visible fraction of a block's area at which the reader counts it as visible: the boundary the
 * reading observer reports. The server's qualification policy has its own, separately versioned
 * threshold; this constant only fixes what the recorder reports against.
 */
export const READING_VISIBLE_FRACTION = 0.5;

const Millis = z.number().int().min(0).max(OBSERVATION_LIMITS.maxClaimMs);

/** `[fromMs, toMs)` since the recorder started, non-empty. */
export const IntervalSchema = z
  .tuple([Millis, Millis])
  .refine(([from, to]) => to > from, { message: 'interval_empty' });

/** `scroll.block_coverage`: when each block was visible while the article was active. */
export const BlockCoveragePayloadSchema = z.strictObject({
  blocks: z
    .array(
      z.strictObject({
        blockId: LocalId,
        /** Intervals the block was at least `READING_VISIBLE_FRACTION` visible and the article active. */
        intervalsMs: z.array(IntervalSchema).max(OBSERVATION_LIMITS.maxIntervalsPerBlock),
        /** The largest visible fraction (0..1) the block reached in this report. */
        peakFraction: z.number().min(0).max(1),
      }),
    )
    .max(OBSERVATION_LIMITS.maxBlocksPerCoverage),
});

/** `scroll.active_dwell`: when the article was active **and** at least one block was visible. */
export const ActiveDwellPayloadSchema = z.strictObject({
  activeIntervalsMs: z.array(IntervalSchema).max(OBSERVATION_LIMITS.maxActiveIntervals),
});

/** `scroll.block_interaction`: one deliberate interaction. Never carries a value. */
export const BlockInteractionPayloadSchema = z.strictObject({
  blockId: LocalId,
  kind: z.enum(SCROLL_INTERACTION_KINDS),
  atMs: Millis,
});

/** Continuous, visible, foreground playback samples; seeks, buffering and loop jumps emit none. */
export const ReelPlaybackPayloadSchema = z.strictObject({
  samples: z
    .array(
      z
        .strictObject({
          activeMs: IntervalSchema,
          mediaMs: z
            .tuple([z.number().int().min(0).max(60_000), z.number().int().min(0).max(60_000)])
            .refine(([from, to]) => to > from),
        })
        .refine(
          ({ activeMs, mediaMs }) =>
            activeMs[1] - activeMs[0] <= 1500 && mediaMs[1] - mediaMs[0] <= activeMs[1] - activeMs[0] + 100,
        ),
    )
    .max(64),
});

const envelope = {
  schemaVersion: z.literal(INTERACTION_SCHEMA_VERSION),
  /** The client's event ID: the idempotency key, reused on every retry. */
  eventId: UuidSchema,
  /** The recorder session (one per reading of one exposure); not the authentication session. */
  sessionId: UuidSchema,
  /** 1, 2, 3 ... within the session; a gap means events were lost. */
  deviceSequence: z.number().int().min(1).max(2_000_000_000),
  exposureId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
};

export const InteractionEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('reel.playback'), payload: ReelPlaybackPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('scroll.block_coverage'), payload: BlockCoveragePayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('scroll.active_dwell'), payload: ActiveDwellPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('scroll.block_interaction'), payload: BlockInteractionPayloadSchema }),
]);

export type InteractionEvent = z.infer<typeof InteractionEventSchema>;

/**
 * `POST /v1/observations/batch`. A batch is bounded (`OBSERVATION_LIMITS`); `instrumentationVersion`
 * says which recorder build produced it, so a qualification can tell missing instrumentation from
 * a short reading.
 */
export const ObservationBatchRequestSchema = z.strictObject({
  instrumentationVersion: z.number().int().min(1).max(1_000),
  events: z.array(InteractionEventSchema).min(1).max(OBSERVATION_LIMITS.maxEventsPerBatch),
});

export type ObservationBatchRequest = z.infer<typeof ObservationBatchRequestSchema>;

/** Why one event was refused. Final: the client drops it and never retries it. */
export const OBSERVATION_REJECTIONS = [
  'exposure_unknown',
  'exposure_not_active',
  'lineage_mismatch',
  'block_unknown',
  'interaction_kind_invalid',
  'too_old',
  'exposure_event_limit',
] as const;

export const ObservationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ eventId: UuidSchema, status: z.literal('accepted') }),
  /** Already stored under this event ID: counted once, never again. */
  z.strictObject({ eventId: UuidSchema, status: z.literal('duplicate') }),
  z.strictObject({ eventId: UuidSchema, status: z.literal('rejected'), reason: z.enum(OBSERVATION_REJECTIONS) }),
]);

export const ObservationBatchResponseSchema = z.strictObject({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  rejected: z.number().int().min(0),
  /** One result per event, in request order. Every status is final: remove the event from the outbox. */
  results: z.array(ObservationResultSchema),
  /** The universe revision at the time of the answer (the watermark clients compare with hints). */
  revision: z.number().int().min(0),
});

export type ObservationBatchResponse = z.infer<typeof ObservationBatchResponseSchema>;

export const submitObservationsContract = oc
  .route({ method: 'POST', path: '/v1/observations/batch', successStatus: 200, tags: ['evidence'] })
  .input(ObservationBatchRequestSchema)
  .output(ObservationBatchResponseSchema);

/**
 * `GET /v1/diagnostics/exposures/{exposureId}/evidence`: the committed evidence of one exposure
 * for the **dev-only** diagnostics view. An operator surface, never consumer UI: it exists only in
 * the worlds where operator tools exist (`dev`, `stage`, `ci`, `local`) and answers 404 elsewhere.
 * It reads durable state, so a missed hint costs nothing: the view refetches when a hint arrives
 * above the revision it holds.
 */
export const EvidenceDiagnosticsRequestSchema = z.object({ exposureId: UuidSchema });

export const EvidenceDiagnosticsResponseSchema = z.object({
  /** The universe revision this was read at (compare with `scope_changed` hints). */
  revision: z.number().int().min(0),
  exposureId: UuidSchema,
  observations: z.object({
    /** Observations stored for the exposure: the intake watermark. */
    count: z.number().int().min(0),
    lastReceivedAt: z.iso.datetime().nullable(),
  }),
  /** The latest committed evidence revision, or null while none has been projected yet. */
  evidence: z
    .object({
      revision: z.number().int().min(1),
      /** The highest observation the revision was computed from. */
      inputWatermark: z.number().int().min(1),
      policyVersion: z.string(),
      qualification: z.enum(['qualified', 'not_qualified', 'unknown']),
      q: z.number().min(0).max(1),
      coverage: z.number().min(0).max(1),
      activeDwellMs: z.number().int().min(0),
      estimatedReadingMs: z.number().int().min(0),
      committedAt: z.iso.datetime(),
    })
    .nullable(),
});

export type EvidenceDiagnosticsResponse = z.infer<typeof EvidenceDiagnosticsResponseSchema>;

export const evidenceDiagnosticsContract = oc
  .route({
    method: 'GET',
    path: '/v1/diagnostics/exposures/{exposureId}/evidence',
    successStatus: 200,
    tags: ['diagnostics'],
  })
  .input(EvidenceDiagnosticsRequestSchema)
  .output(EvidenceDiagnosticsResponseSchema);
