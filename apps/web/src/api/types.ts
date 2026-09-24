/**
 * Wire types for the released bootstrap HTTP contract
 * (docs/contracts/bootstrap-http.md, docs/contracts/trace-revisit.md).
 *
 * `packages/contracts` already holds the strict zod shapes the backend and
 * Android client validate against; we reuse those schemas here (read-only
 * import, no edits to packages/**) instead of re-typing the rules and
 * risking drift. This file only adds the response-side shapes the contracts
 * package does not itself export (Event), mirroring
 * apps/mobile/.../data/Models.kt field-for-field.
 *
 * Universe/Trace/Capabilities/Feed/Worlds are the bootstrap reads this client parses on load
 * (GET /v1/universe, GET /v1/feed, GET /v1/worlds); their schemas live once in
 * packages/contracts/src/web-bootstrap.ts and are imported, not re-typed, so a field added there
 * is felt here at compile time instead of silently drifting (#115; ADR-0030's recordingPausedAt
 * gap in #120/#121 is exactly the failure mode this closes).
 */
import { z } from 'zod';
import { traceRevisitReceipt, traceRevisitScroll } from '../../../../packages/contracts/src/trace-revisit.ts';
import { privacyLifecycleInput, privacyResetInput } from '../../../../packages/contracts/src/index.ts';
import {
  capabilitiesSchema,
  traceSchema,
  universeSchema,
  feedItemSchema as sharedFeedItemSchema,
  feedResponseSchema as sharedFeedResponseSchema,
  worldSummarySchema as sharedWorldSummarySchema,
  worldSystemResponseSchema as sharedWorldSystemResponseSchema,
  type Capabilities,
  type Trace,
  type Universe,
  type FeedItem,
  type FeedResponse,
  type WorldSummary,
  type WorldSystemResponse,
} from '../../../../packages/contracts/src/web-bootstrap.ts';

export type ScrollAsset = z.infer<typeof traceRevisitScroll>;

export const capabilities = capabilitiesSchema;
export type { Capabilities };

export const trace = traceSchema;
export type { Trace };

export const universe = universeSchema;
export type { Universe };

/** The feed item extends the documented Scroll shape with a non-authoritative recommendation reason. */
export const feedItemSchema = sharedFeedItemSchema;
export type { FeedItem };

export const feedResponse = sharedFeedResponseSchema;
export type { FeedResponse };

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
 * `GET /v1/worlds` (docs/contracts/bootstrap-http.md, ADR-0028/#113). The strict runtime shape
 * (`WorldSummary`/`WorldSystemResponse`) lives once in packages/contracts/src/web-bootstrap.ts,
 * alongside universe/feed above, and is imported rather than re-typed (#115). Note
 * `packages/contracts/src/worlds.ts` separately names the same shape as plain TypeScript
 * interfaces for other, non-web consumers; that file is untouched by this change.
 */
export const worldSummarySchema = sharedWorldSummarySchema;
export type { WorldSummary };

export const worldSystemResponseSchema = sharedWorldSystemResponseSchema;
export type { WorldSystemResponse };

/**
 * ADR-0030 / #119: pause, export and reset. Request bodies reuse the contracts package's own
 * strict zod shapes (`privacyLifecycleInput`/`privacyResetInput`) for their exact field set and
 * validation, exactly like every other request this file builds against a shared contract.
 * Response shapes are written here field-for-field against `packages/contracts/src/index.ts`'s
 * plain TypeScript types (`PrivacyRecordingReceipt`/`PrivacyExportResult`/`PrivacyResetReceipt`),
 * the same pattern this file used for worlds/universe/feed before those moved to
 * web-bootstrap.ts -- no zod schema for these three exists in the contracts package to reuse.
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
    branchOpens: z.number().int().nonnegative(),
    connectionFeedback: z.number().int().nonnegative(),
    semanticProposals: z.number().int().nonnegative(),
    attentionAccounts: z.number().int().nonnegative(),
    hypotheses: z.number().int().nonnegative(),
    encounterFeedback: z.number().int().nonnegative(),
    askAnswers: z.number().int().nonnegative(),
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
    semantic: z
      .object({
        branchOpens: z.array(exportRowSchema),
        connectionFeedback: z.array(exportRowSchema),
        proposals: z.array(exportRowSchema),
        bridges: z.array(exportRowSchema),
      })
      .strict(),
    personalModel: z
      .object({
        attentionAccounts: z.array(exportRowSchema),
        attentionTransitions: z.array(exportRowSchema),
        hypotheses: z.array(exportRowSchema),
        encounterFeedback: z.array(exportRowSchema),
        atlasPlaces: z.array(exportRowSchema),
        atlasDeltas: z.array(exportRowSchema),
      })
      .strict(),
    askAnswers: z.array(exportRowSchema),
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
