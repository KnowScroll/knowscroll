/**
 * Wire types for the released bootstrap HTTP contract
 * (docs/contracts/bootstrap-http.md, docs/contracts/trace-revisit.md).
 *
 * `packages/contracts` already holds the strict zod shapes the backend and
 * Android client validate against; we reuse those schemas here (read-only
 * import, no edits to packages/**) instead of re-typing the rules and
 * risking drift. This file only adds the response-side shapes the contracts
 * package does not itself export (Universe/Trace/Feed/Event), mirroring
 * apps/mobile/.../data/Models.kt field-for-field.
 */
import { z } from 'zod';
import { traceRevisitReceipt, traceRevisitScroll } from '../../../../packages/contracts/src/trace-revisit.ts';

export type ScrollAsset = z.infer<typeof traceRevisitScroll>;

export const capabilities = z
  .object({ reasoning: z.boolean(), reels: z.boolean(), worldEvolution: z.boolean() })
  .strict();
export type Capabilities = z.infer<typeof capabilities>;

export const trace = z
  .object({ eventId: z.string(), assetId: z.string(), title: z.string(), createdAt: z.string() })
  .strict();
export type Trace = z.infer<typeof trace>;

export const universe = z
  .object({
    universeId: z.string(),
    revision: z.number(),
    privacyEpoch: z.number().int(),
    // ADR-0030 added this to the bootstrap response. The schema is strict, so omitting a field the
    // server now sends fails every universe load and the reader sees an honest-looking "unavailable"
    // for a server that is perfectly healthy. Null means recording is running.
    recordingPausedAt: z.string().nullable(),
    traces: z.array(trace),
    capabilities,
  })
  .strict();
export type Universe = z.infer<typeof universe>;

/** The feed item extends the documented Scroll shape with a non-authoritative recommendation reason. */
export const feedItemSchema = z
  .object({
    assetId: z.string().uuid(),
    revision: z.number().int().positive(),
    kind: z.literal('Scroll'),
    title: z.string(),
    summary: z.string(),
    body: z.string(),
    sourceTitle: z.string(),
    sourceUrl: z.string().url(),
    truthState: z.string().min(1),
    reason: z.string(),
  })
  .strict();
export type FeedItem = z.infer<typeof feedItemSchema>;

export const feedResponse = z
  .object({
    decisionId: z.string(),
    universeId: z.string(),
    accountRevision: z.number(),
    privacyEpoch: z.number().int(),
    items: z.array(feedItemSchema),
  })
  .strict();
export type FeedResponse = z.infer<typeof feedResponse>;

export const exposureResponse = z.object({ exposureId: z.string(), eventId: z.string() }).strict();
export type ExposureResponse = z.infer<typeof exposureResponse>;

export const interactionResponse = z
  .object({ eventId: z.string(), jobId: z.string(), status: z.string() })
  .strict();
export type InteractionResponse = z.infer<typeof interactionResponse>;

export const eventStatus = z
  .object({
    eventId: z.string(),
    causationId: z.string().nullable(),
    exposureId: z.string().nullable(),
    kind: z.string(),
    jobId: z.string().nullable(),
    jobStatus: z.string().nullable(),
    projected: z.boolean(),
  })
  .strict();
export type EventStatus = z.infer<typeof eventStatus>;

export const traceRevisit = traceRevisitReceipt;
export type TraceRevisit = z.infer<typeof traceRevisit>;

/**
 * `GET /v1/worlds` (docs/contracts/bootstrap-http.md, ADR-0028/#113). `packages/contracts/src/worlds.ts`
 * names this shape as plain TypeScript interfaces (no zod schema exists there to reuse, unlike
 * trace-revisit above), so the strict runtime shape is written directly here, matching that file
 * field-for-field: `WorldSummary` (worldId, sourceTitle, sourceUrl, scrollCount, seenCount) and
 * `WorldSystemResponse` (derivationMethod, system: null | { systemId, worlds }).
 */
export const worldSummarySchema = z
  .object({
    worldId: z.string(),
    sourceTitle: z.string(),
    sourceUrl: z.string(),
    scrollCount: z.number().int().nonnegative(),
    seenCount: z.number().int().nonnegative(),
  })
  .strict();
export type WorldSummary = z.infer<typeof worldSummarySchema>;

export const worldSystemResponseSchema = z
  .object({
    derivationMethod: z.string(),
    // `null` for a universe whose own exposures have not yet reached any recorded source's
    // evidence -- never an empty object standing in for "nothing yet" (ADR-0028).
    system: z
      .object({ systemId: z.string(), worlds: z.array(worldSummarySchema) })
      .strict()
      .nullable(),
  })
  .strict();
export type WorldSystemResponse = z.infer<typeof worldSystemResponseSchema>;

/** Documented truth states and their required presentation (definition.md section 12). */
export const TRUTH_STATE_MEANING: Record<string, string> = {
  documented: 'Directly supported by strong cited evidence. Source access and date are shown.',
  synthesis: 'A source-grounded explanation produced by the system. Sources plus a generated label are shown.',
  interpretation: 'A reasoned perspective rather than settled fact. Perspective and counterview are shown.',
  disputed: 'Credible sources materially disagree. Disagreement is shown before you act on it.',
  modelled: 'Produced by an explicit simulation or causal model. Assumptions, model and uncertainty are shown.',
  counterfactual: 'Explores a world that did not occur. The divergence point and assumptions are shown.',
  fictional: 'Invented for narrative or play. Framing is unmistakably fictional.',
};
