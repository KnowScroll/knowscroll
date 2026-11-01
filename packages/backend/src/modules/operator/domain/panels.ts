/**
 * The shape of the Operator screen's panels (D-044): rows from the `ops` views, each piece either
 * available or honestly unavailable. Nothing here names a person, a prompt or a message.
 */

/** A source the Tier 0 stack does not have, or a view that could not be read (D-006 l: never faked). */
export interface Unavailable {
  readonly status: 'unavailable';
  readonly reason: 'no_tier0_source' | 'view_missing' | 'read_failed';
}

export type Piece<T> = { readonly status: 'available'; readonly data: T } | Unavailable;

export const NO_TIER0_SOURCE: Unavailable = { status: 'unavailable', reason: 'no_tier0_source' };

export interface QueueRow {
  readonly queue: string;
  readonly ready: number;
  readonly scheduled: number;
  readonly retrying: number;
  readonly active: number;
  readonly failed: number;
  readonly oldestWaitingSeconds: number | null;
  readonly lastCompletedAt: Date | null;
}

export interface OutcomeCount {
  readonly state: string;
  readonly count: number;
}

export interface UsageSummary {
  readonly windowHours: number;
  readonly attempts: number;
  /** Tokens the provider reported, summed. Attempts without a report are counted below, not guessed. */
  readonly tokensReported: number;
  readonly attemptsWithoutReportedUsage: number;
}

export interface ErrorRow {
  readonly occurredAt: Date;
  readonly source: string;
  readonly refId: string;
  readonly state: string | null;
  readonly code: string | null;
  readonly label: string | null;
}

export interface ProductionRunRow {
  readonly productionRunId: string;
  readonly recipeKey: string;
  readonly take: number;
  readonly state: string;
  readonly writerRunState: string | null;
  readonly modelAttempts: number;
  readonly refusedAnswers: number;
  readonly assetId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface RefusedAnswerRow {
  readonly attemptId: string;
  readonly step: string | null;
  readonly model: string | null;
  readonly reason: string | null;
  readonly issueCount: number;
  readonly issueCodes: readonly string[];
  readonly answerChars: number;
  readonly truncated: boolean;
  readonly recordedAt: Date;
}

export interface ReelOrderRow {
  readonly reelOrderId: string;
  readonly scriptName: string;
  readonly until: string;
  readonly attempts: number;
  readonly settledCents: number;
  readonly claimedOpenCents: number;
  readonly latestAttemptState: string | null;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface CartographerRunRow {
  readonly runId: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly desiredRevision: number;
  readonly updatedAt: Date;
}

export interface CartographerSummary {
  readonly counts: readonly OutcomeCount[];
  readonly recent: readonly CartographerRunRow[];
}

export interface PrivacyOperationGroup {
  readonly kind: string;
  readonly state: string;
  readonly count: number;
  readonly oldestRequestedAt: Date;
}

export interface PrivacySummary {
  readonly groups: readonly PrivacyOperationGroup[];
  /** Operations that recorded a failure code, newest first. */
  readonly failed: readonly {
    readonly operationId: string;
    readonly kind: string;
    readonly failureCode: string;
    readonly requestedAt: Date;
  }[];
}

/** One report to the safety team: what it is about and when, never its note, its sender or the person reported. */
export interface ReportRow {
  readonly reportId: string;
  readonly kind: 'content_error' | 'abuse';
  readonly category: string;
  readonly targetKind: 'asset' | 'message' | 'room_message' | 'person' | 'deleted_account';
  readonly assetId: string | null;
  readonly messageId: string | null;
  readonly roomId: string | null;
  readonly hasNote: boolean;
  readonly createdAt: Date;
}

export interface ReportsSummary {
  /** Reports received in the last 24 hours. */
  readonly last24Hours: number;
  /** The newest reports first. */
  readonly recent: readonly ReportRow[];
}

/**
 * One room's AI calls over the last 24 hours, from the turn ledger: counts only, never a message or a person.
 * `refused` counts the unprompted turns a cap refused, by the cap; they posted nothing and showed nothing.
 */
export interface RoomCallsRow {
  readonly roomId: string;
  /** Turns a member asked for. */
  readonly asked: number;
  /** Turns a resident took on its own (the router allowed them). */
  readonly unprompted: number;
  readonly unpromptedLastHour: number;
  readonly refused: readonly { readonly cap: string; readonly count: number }[];
  readonly lastAt: Date;
}

export interface RoomCallsSummary {
  /** Busiest rooms first. */
  readonly rooms: readonly RoomCallsRow[];
}

/** The six panels of the artboard, the reports list and the rooms' AI calls. Pieces with no Tier 0 source are `unavailable`. */
export interface OperatorPanels {
  readonly generatedAt: Date;
  readonly overview: {
    readonly queues: Piece<readonly QueueRow[]>;
    readonly providerOutcomes: Piece<readonly OutcomeCount[]>;
    readonly recentErrors: Piece<readonly ErrorRow[]>;
    readonly serviceHealth: Unavailable;
    readonly requestLatency: Unavailable;
    readonly mediaDisk: Unavailable;
  };
  readonly production: {
    readonly runs: Piece<readonly ProductionRunRow[]>;
    readonly refusedAnswers: Piece<readonly RefusedAnswerRow[]>;
    readonly reelOrders: Piece<readonly ReelOrderRow[]>;
    readonly usage: Piece<UsageSummary>;
  };
  readonly universeChange: { readonly cartographer: Piece<CartographerSummary> };
  readonly safety: { readonly reports: Piece<ReportsSummary> };
  readonly rooms: { readonly calls: Piece<RoomCallsSummary> };
  readonly realtime: { readonly delivery: Unavailable };
  readonly privacy: {
    readonly operations: Piece<PrivacySummary>;
    readonly retentionJobs: Piece<readonly QueueRow[]>;
    readonly droppedDiagnostics: Unavailable;
  };
}

/**
 * The jobs that remove or reconcile old records. Their last run is the "retention jobs" panel. A
 * test checks every name is a declared queue.
 */
export const RETENTION_QUEUES: readonly string[] = [
  'identity.sweep-sign-in-records',
  'identity.recover-clear-operations',
  'identity.recover-account-deletions',
  'reasoning.purge-expired-requests',
  'reasoning.sweep-dispatched-attempts',
  'feedback.purge-reports',
  'supply.purge-quick-answers',
  'scenes.expire-formation',
  'scenes.recover-formation',
];
