import type { PersonalAuthority, ScopeOutcome } from '../../identity/public.js';
import type { ReadPreparedEvidenceInput } from '../../composer/public.js';
import type { ProjectScrollReadingPayload } from '../events.js';
export type ActivityProjectionResult =
  | { readonly kind: 'applied'; readonly activityId: string; readonly revision: number }
  | {
      readonly kind: 'skipped';
      readonly reason:
        'already_applied' | 'exposure_not_active' | 'metadata_missing' | 'epoch_changed' | 'universe_unavailable';
    };
export type ProjectEncounterActivity = (payload: ProjectScrollReadingPayload) => Promise<ActivityProjectionResult>;
export type ReadPreparedActivity = ReadPreparedEvidenceInput;
export type ReconcileEncounterActivity = (
  authority: PersonalAuthority,
  query: { readonly after?: string; readonly limit: number },
) => Promise<
  ScopeOutcome<{
    readonly examined: number;
    readonly queued: number;
    readonly pending: number;
    readonly metadataGaps: number;
    readonly watermark: number;
    readonly pageComplete: boolean;
    readonly nextCursor?: string;
  }>
>;
