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
import { privacyLifecycleInput, privacyResetInput } from '../../../../packages/contracts/src/index.ts';

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

/**
 * ADR-0030 / #119: pause, export and reset. Request bodies reuse the contracts package's own
 * strict zod shapes (`privacyLifecycleInput`/`privacyResetInput`) for their exact field set and
 * validation, exactly like every other request this file builds against a shared contract.
 * Response shapes are written here field-for-field against `packages/contracts/src/index.ts`'s
 * plain TypeScript types (`PrivacyRecordingReceipt`/`PrivacyExportResult`/`PrivacyResetReceipt`),
 * the same pattern `worldSystemResponseSchema` above already uses because no zod schema exists
 * there to reuse.
 */
export type PrivacyLifecycleRequest = z.infer<typeof privacyLifecycleInput>;
export type PrivacyResetRequest = z.infer<typeof privacyResetInput>;

/** The one deliberate confirmation literal Reset requires (ADR-0030); reused verbatim as the
 * phrase the reader must type in the panel, so the UI gate and the wire contract are the same
 * words rather than two independently-invented ones that could drift apart. */
export const RESET_CONFIRMATION = 'reset-personal-universe' as const;

export const privacyRecordingReceiptSchema = z
  .object({
    receiptId: z.string(),
    action: z.union([z.literal('pause'), z.literal('resume')]),
    privacyEpoch: z.number().int(),
    recordingPausedAt: z.string().nullable(),
    appliedAt: z.string(),
  })
  .strict();
export type PrivacyRecordingReceipt = z.infer<typeof privacyRecordingReceiptSchema>;

export const privacyExportRowCountsSchema = z
  .object({
    decisions: z.number().int().nonnegative(),
    ledger: z.number().int().nonnegative(),
    exposures: z.number().int().nonnegative(),
    traces: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    deviceSessions: z.number().int().nonnegative(),
    reasoningJobs: z.number().int().nonnegative(),
    reasoningSteps: z.number().int().nonnegative(),
    reasoningReceipts: z.number().int().nonnegative(),
    reasoningAccounting: z.number().int().nonnegative(),
  })
  .strict();
export type PrivacyExportRowCounts = z.infer<typeof privacyExportRowCountsSchema>;

export const privacyExportDeviceSessionSchema = z
  .object({
    deviceId: z.string(),
    origin: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type PrivacyExportDeviceSession = z.infer<typeof privacyExportDeviceSessionSchema>;

/**
 * `decisions`/`ledger`/`exposures`/`traces`/`jobs` are raw recorded rows with no shared shape the
 * contracts package itself types beyond `unknown[]` (`packages/contracts/src/index.ts`'s own
 * `PrivacyExportResult`); this client never renders or interprets their fields, only offers the
 * whole export as a file, so validating them as opaque records -- present, an object, nothing
 * asserted about their contents -- matches what this surface actually depends on.
 */
const exportRowSchema = z.record(z.string(), z.unknown());
export const privacyExportResultSchema = z
  .object({
    receiptId: z.string(),
    privacyEpoch: z.number().int(),
    exportedAt: z.string(),
    rowCounts: privacyExportRowCountsSchema,
    account: z.object({ email: z.string().nullable() }).strict(),
    universe: z
      .object({
        id: z.string(),
        revision: z.number().int(),
        privacyEpoch: z.number().int(),
        recordingPausedAt: z.string().nullable(),
      })
      .strict(),
    accounts: z.object({ keptAssetIds: z.array(z.string()), revision: z.number().int() }).strict(),
    decisions: z.array(exportRowSchema),
    ledger: z.array(exportRowSchema),
    exposures: z.array(exportRowSchema),
    traces: z.array(exportRowSchema),
    jobs: z.array(exportRowSchema),
    deviceSessions: z.array(privacyExportDeviceSessionSchema),
    reasoning: z
      .object({
        jobs: z.array(exportRowSchema),
        steps: z.array(exportRowSchema),
        receipts: z.array(exportRowSchema),
        accounting: z.array(exportRowSchema),
      })
      .strict(),
  })
  .strict();
export type PrivacyExportResult = z.infer<typeof privacyExportResultSchema>;

export const privacyResetReceiptSchema = z
  .object({
    receiptId: z.string(),
    epochBefore: z.number().int(),
    epochAfter: z.number().int(),
    sessionsRevoked: z.number().int().nonnegative(),
    resetAt: z.string(),
  })
  .strict();
export type PrivacyResetReceipt = z.infer<typeof privacyResetReceiptSchema>;

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
