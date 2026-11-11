/**
 * Evidence's public surface: the queues other modules enqueue to, their payloads, and the use
 * cases' types. Framework-free; built by `adapters/nest-providers.ts` in the composition roots.
 */
export {
  ApplyActionEvidencePayloadSchema,
  ProjectScrollReadingPayloadSchema,
  projectEncounterActivityQueue,
  applyActionEvidenceQueue,
  projectScrollReadingQueue,
  type ApplyActionEvidencePayload,
  type ProjectScrollReadingPayload,
} from './events.js';
export type { ApplyActionEvidence, ApplyActionEvidenceResult } from './application/apply-action-evidence.js';
export type {
  IngestObservations,
  IngestObservationsCommand,
  IngestObservationsRefusal,
  IngestObservationsResult,
} from './application/ingest-observations.js';
export type { ProjectScrollReading, ProjectScrollReadingResult } from './application/project-scroll-reading.js';
export type {
  ReadEvidenceDiagnostics,
  ReadEvidenceDiagnosticsResult,
} from './application/read-evidence-diagnostics.js';
export type { EvidenceDiagnostics } from './application/ports.js';

export {
  ACTIVITY_POLICY,
  ACTIVITY_POLICY_V0,
  continuationCredit,
  type ActivityChannels,
  type ActivityPolicy,
  type ActivityPolicyVersion,
} from './domain/activity.js';
export type {
  ProjectEncounterActivity,
  ReconcileEncounterActivity,
  ReadPreparedActivity,
  ActivityProjectionResult,
} from './application/activity-contracts.js';
export const PROJECT_ENCOUNTER_ACTIVITY = Symbol('evidence.projectEncounterActivity');
export const RECONCILE_ENCOUNTER_ACTIVITY = Symbol('evidence.reconcileEncounterActivity');
export const READ_PREPARED_ACTIVITY = Symbol('evidence.readPreparedActivity');
export type {
  ActivityDerivedInput,
  RecordingActivityDerivedInput,
  LegacyActivityDerivedInput,
  LegacyActivityDerivedEffect,
  ActivityDerivedEffect,
  ActivityStatistics,
  FormatCell,
  InterestRollup,
  InterestTopic,
  ReadActivityStatistics,
  ReadInterestRollups,
  ReadObservationTail,
  ReadRecentTopicIds,
  ReadTopInterestTopics,
} from './application/context-ports.js';
export const READ_ACTIVITY_STATISTICS = Symbol('evidence.readActivityStatistics');
export const READ_OBSERVATION_TAIL = Symbol('evidence.readObservationTail');

export const READ_RECENT_TOPIC_IDS = Symbol('evidence.readRecentTopicIds');
/** The person's top-K topics by decayed activity (an index range scan) and the system/person roll-ups, for Composer policy v3 (D-420). */
export const READ_TOP_INTEREST_TOPICS = Symbol('evidence.readTopInterestTopics');
export const READ_INTEREST_ROLLUPS = Symbol('evidence.readInterestRollups');

export { OBSERVED_COVERAGE_POLICY, ObservedCoverageSchema } from './domain/coverage.js';
export type { ObservedCoverage } from './domain/coverage.js';
export type { CheckCoverageEvidence } from './application/coverage-ports.js';
export const CHECK_COVERAGE_EVIDENCE = Symbol('evidence.checkCoverageEvidence');

export type { RecordingCoverageWitness, CheckRecordingCoverageEvidence } from './application/coverage-ports.js';
export { recordingCoverageKey } from './application/coverage-ports.js';
export const CHECK_RECORDING_COVERAGE_EVIDENCE = Symbol('evidence.checkRecordingCoverageEvidence');
