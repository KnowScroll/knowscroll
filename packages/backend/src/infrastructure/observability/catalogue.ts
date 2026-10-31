/**
 * The diagnostic event catalogue: the only names `logEvent` accepts, each with its severity and
 * the fields it may carry. Adding an event is a reviewed change to this file.
 *
 * Field vocabulary follows blueprint §26. Which of these fields reach which sink is decided by
 * the sink projection in `log-event.ts`, not by callers.
 */
export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Field names and the value type each accepts. Values are validated at runtime too. */
export interface FieldTypes {
  // Correlation vocabulary (blueprint §26). Personal-linkable IDs never reach the journal.
  operationId: string;
  requestId: string;
  commandId: string;
  eventId: string;
  causationId: string;
  correlationId: string;
  encounterId: string;
  exposureId: string;
  decisionId: string;
  demandId: string;
  jobId: string;
  runId: string;
  attemptId: string;
  proposalId: string;
  deltaId: string;
  receiptId: string;
  contentRevisionId: string;
  traceId: string;
  spanId: string;
  // Operational facts
  outcome: string;
  reasonCode: string;
  durationMs: number;
  method: string;
  route: string;
  status: number;
  queue: string;
  retryCount: number;
  count: number;
  revision: number;
  migration: string;
  signal: string;
  pid: number;
  nodeVersion: string;
  context: string;
  /** Configuration problems as `VARIABLE: kind_code`, never values. */
  problems: readonly string[];
  // Model execution (blueprint §26 "Record policy/model/prompt … versions"): codes and counts only.
  provider: string;
  model: string;
  /** The role (`<module>.<role>`) whose prompt was sent. */
  role: string;
  /** The harness framing version (`hp2` today); the role version is on the attempt record. */
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** Quota preflight observation: remaining percentage of the current interval / week. */
  quotaIntervalPercent: number;
  quotaWeeklyPercent: number;
  /** Any thrown value; `logEvent` sanitises it to class, code and frames. */
  error: unknown;
}

export type FieldName = keyof FieldTypes;

interface EventSpec {
  readonly severity: Severity | 'by-call';
  readonly module: string;
  readonly fields: readonly FieldName[];
}

export const diagnosticCatalogue = {
  'process.started': { severity: 'info', module: 'process', fields: ['pid', 'nodeVersion'] },
  'process.stopping': { severity: 'info', module: 'process', fields: ['signal'] },
  'process.stopped': { severity: 'info', module: 'process', fields: ['durationMs', 'outcome'] },
  'process.start_failed': { severity: 'fatal', module: 'process', fields: ['reasonCode', 'error'] },
  'process.stop_failed': { severity: 'error', module: 'process', fields: ['reasonCode', 'error'] },
  'process.crashed': { severity: 'fatal', module: 'process', fields: ['reasonCode', 'error'] },
  'config.invalid': { severity: 'fatal', module: 'config', fields: ['problems'] },
  'framework.message': {
    severity: 'by-call',
    module: 'framework',
    fields: ['context', 'reasonCode', 'route', 'method', 'error'],
  },
  'http.request_completed': {
    severity: 'info',
    module: 'http',
    fields: ['requestId', 'method', 'route', 'status', 'durationMs', 'outcome', 'reasonCode'],
  },
  'http.unexpected_error': { severity: 'error', module: 'http', fields: ['requestId', 'method', 'route', 'error'] },
  'http.retryable_failure': { severity: 'warn', module: 'http', fields: ['requestId', 'reasonCode', 'error'] },
  'database.idle_client_error': { severity: 'error', module: 'postgres', fields: ['error'] },
  'jobs.error': { severity: 'error', module: 'jobs', fields: ['error'] },
  'jobs.warning': { severity: 'warn', module: 'jobs', fields: ['reasonCode'] },
  'jobs.work_skipped': { severity: 'info', module: 'jobs', fields: ['queue', 'reasonCode'] },
  'jobs.consumer_registered': { severity: 'info', module: 'jobs', fields: ['queue', 'count'] },
  'jobs.schedule_removed': { severity: 'warn', module: 'jobs', fields: ['queue'] },
  'jobs.consumers_draining': { severity: 'info', module: 'jobs', fields: ['count'] },
  'jobs.job_failed': {
    severity: 'warn',
    module: 'jobs',
    fields: ['queue', 'jobId', 'retryCount', 'reasonCode', 'error'],
  },
  'relay.listening': { severity: 'info', module: 'notices', fields: ['reasonCode'] },
  'relay.disconnected': { severity: 'warn', module: 'notices', fields: ['reasonCode', 'error'] },
  'relay.notice_rejected': { severity: 'warn', module: 'notices', fields: ['reasonCode'] },
  'relay.sink_failed': { severity: 'error', module: 'notices', fields: ['reasonCode', 'error'] },
  'realtime.connection_refused': { severity: 'info', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.subscription_refused': { severity: 'info', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.access_revoked': { severity: 'info', module: 'realtime', fields: ['count'] },
  'realtime.relay_failed': { severity: 'error', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.heartbeat_failed': { severity: 'warn', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.typing_failed': { severity: 'warn', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.sockets_reauthenticated': { severity: 'info', module: 'realtime', fields: ['reasonCode', 'count'] },
  // Identity (S1.3). Never an address, token, link, cookie or key: outcomes and codes only.
  'identity.sign_in_requested': { severity: 'info', module: 'identity', fields: ['requestId', 'outcome'] },
  // Once per window per budget (domain, world, client): the alert that sign-in mail is throttled.
  'identity.sign_in_budget_full': { severity: 'warn', module: 'identity', fields: ['reasonCode'] },
  // The scheduled sweep (worker, every 15 minutes): how many expired links and ended sessions went.
  'identity.sign_in_records_swept': { severity: 'info', module: 'identity', fields: ['count'] },
  'identity.sign_in_mail': {
    severity: 'by-call',
    module: 'identity',
    fields: ['outcome', 'reasonCode', 'status', 'durationMs'],
  },
  'identity.signed_in': {
    severity: 'info',
    module: 'identity',
    fields: ['requestId', 'outcome', 'reasonCode', 'context'],
  },
  'identity.sign_in_refused': { severity: 'info', module: 'identity', fields: ['requestId', 'reasonCode'] },
  'identity.signed_out': { severity: 'info', module: 'identity', fields: ['requestId', 'count', 'reasonCode'] },
  'identity.origin_refused': {
    severity: 'warn',
    module: 'identity',
    fields: ['requestId', 'method', 'route', 'reasonCode'],
  },
  'identity.operator_sign_in': { severity: 'by-call', module: 'identity', fields: ['outcome', 'reasonCode', 'error'] },
  // Account deletion (D-043): outcomes and durations only. No account, universe or receipt id.
  'identity.account_deletion_requested': { severity: 'info', module: 'identity', fields: ['requestId', 'outcome'] },
  'identity.account_deletion_processed': {
    severity: 'info',
    module: 'identity',
    fields: ['outcome', 'durationMs'],
  },
  'identity.account_deletions_recovered': { severity: 'info', module: 'identity', fields: ['count'] },
  'identity.data_export_built': { severity: 'info', module: 'identity', fields: ['outcome', 'durationMs'] },
  'reasoning.admission_refused': {
    severity: 'info',
    module: 'reasoning',
    fields: ['runId', 'provider', 'model', 'role', 'promptVersion', 'reasonCode'],
  },
  'reasoning.attempt_reserved': {
    severity: 'info',
    module: 'reasoning',
    fields: ['attemptId', 'runId', 'provider', 'model', 'role', 'promptVersion', 'count'],
  },
  'reasoning.quota_observed': {
    severity: 'info',
    module: 'reasoning',
    fields: [
      'attemptId',
      'runId',
      'provider',
      'model',
      'role',
      'promptVersion',
      'outcome',
      'reasonCode',
      'quotaIntervalPercent',
      'quotaWeeklyPercent',
    ],
  },
  'reasoning.attempt_dispatched': {
    severity: 'info',
    module: 'reasoning',
    fields: ['attemptId', 'runId', 'provider', 'model', 'role', 'promptVersion'],
  },
  // Content admission (the operator command): outcome and codes only, never the source's text.
  'content.scroll_admitted': {
    severity: 'by-call',
    module: 'content',
    fields: ['outcome', 'reasonCode', 'count', 'error'],
  },
  // An operator's decision on a v2 library Scroll at the review gate (D-138): the recipe key (`context`), what
  // happened (`outcome`: released, already_released, rejected, already_rejected or refused), the revision and,
  // for a refusal, its code. Never text of the Scroll or the reason given. Who and when are in `content.revision_reviews`.
  'content.review_decided': {
    severity: 'by-call',
    module: 'content',
    fields: ['context', 'outcome', 'reasonCode', 'revision'],
  },
  // One delivery of the production job of a library recipe: the recipe key (`context`), the final
  // outcome and its first code, and how many paid attempts the job holds. Never a draft or research.
  'content.scroll_production_finished': {
    severity: 'info',
    module: 'content',
    fields: ['context', 'outcome', 'reasonCode', 'count', 'durationMs'],
  },
  // Evidence intake (API) and projection (worker). Counts and codes; no event, block or exposure
  // content (D-017); personal-linkable IDs are withheld from the journal by the sink projection.
  'evidence.observations_ingested': {
    severity: 'info',
    module: 'evidence',
    fields: ['requestId', 'count', 'outcome', 'reasonCode'],
  },
  'composer.buffer_prepared': {
    severity: 'info',
    module: 'composer',
    fields: ['outcome', 'reasonCode', 'count', 'durationMs'],
  },
  // Branches of content threads settled by the sweep (D-049): a count only, never a thread or a person.
  'scenarios.branches_resolved': { severity: 'info', module: 'scenarios', fields: ['count'] },
  // Places given their look by the operator's backfill (D-102): a count only.
  'scenes.looks_backfilled': { severity: 'info', module: 'scenes', fields: ['count'] },
  // A place left without a look, or a scene refused because the plan and its stored objects disagree (D-102): a code only.
  'scenes.look_refused': { severity: 'warn', module: 'scenes', fields: ['reasonCode'] },
  'evidence.reading_projected': {
    severity: 'info',
    module: 'evidence',
    fields: ['outcome', 'reasonCode', 'exposureId', 'durationMs'],
  },
  'reasoning.attempt_settled': {
    severity: 'info',
    module: 'reasoning',
    fields: [
      'attemptId',
      'runId',
      'provider',
      'model',
      'role',
      'promptVersion',
      'outcome',
      'reasonCode',
      'durationMs',
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cachedTokens',
    ],
  },
  'reasoning.attempt_written_off': {
    severity: 'warn',
    module: 'reasoning',
    fields: ['attemptId', 'outcome', 'reasonCode'],
  },
  // Once at worker start: which provider the harness will use (`none` when unconfigured). Never a key.
  'reasoning.provider_configured': { severity: 'info', module: 'reasoning', fields: ['provider', 'model'] },
  // A crash left attempts `dispatched`; the sweep moved them to `unknown` for an operator.
  'reasoning.dispatched_swept': { severity: 'warn', module: 'reasoning', fields: ['count'] },
  // The sweep closed personal runs a role left admitted and idle; the role starts a new run when it next needs one.
  'reasoning.idle_runs_closed': { severity: 'info', module: 'reasoning', fields: ['count'] },
  'reasoning.requests_purged': { severity: 'info', module: 'reasoning', fields: ['count'] },
  // The quiet sweep (D-104): how many universes with a place due to go quiet it handed to a settle.
  'geography.quiet_swept': { severity: 'info', module: 'geography', fields: ['count'] },
  // One universe's settle: what it did (a code) and how many places changed activity. No person, no place.
  'geography.quiet_settled': { severity: 'info', module: 'geography', fields: ['outcome', 'count'] },
  // The night's room items (D-176) failed for one room: its slug and the sanitised error. The other rooms are still drafted and the job retries.
  'rooms.rituals_room_failed': { severity: 'warn', module: 'rooms', fields: ['context', 'error'] },
  // The daily purge removed reports about deleted accounts whose 90 days were over (D-055).
  'feedback.reports_purged': { severity: 'info', module: 'feedback', fields: ['count'] },
  'reasoning.purge_failed': { severity: 'warn', module: 'reasoning', fields: ['error'] },
  // A refused production answer could not be kept for diagnosis; the attempt's outcome is unchanged.
  'reasoning.rejected_answer_not_recorded': { severity: 'warn', module: 'reasoning', fields: ['attemptId', 'error'] },
  'migrate.started': { severity: 'info', module: 'migrate', fields: ['count'] },
  'migrate.completed': { severity: 'info', module: 'migrate', fields: ['count', 'migration', 'durationMs'] },
  'migrate.failed': { severity: 'fatal', module: 'migrate', fields: ['migration', 'reasonCode', 'error'] },
  // A step the migration could not finish but the release can run without (the ops reader role is missing).
  'migrate.warning': { severity: 'warn', module: 'migrate', fields: ['reasonCode'] },
  // Operator reads (D-044): who may look is checked on the server for every call. Counts and codes only.
  'operator.read': { severity: 'info', module: 'operator', fields: ['route', 'outcome', 'count'] },
  'operator.refused': { severity: 'warn', module: 'operator', fields: ['route', 'reasonCode'] },
} as const satisfies Record<string, EventSpec>;

export type DiagnosticEvent = keyof typeof diagnosticCatalogue;

type FieldsOf<E extends DiagnosticEvent> = (typeof diagnosticCatalogue)[E]['fields'][number];

/** The fields a call to `logEvent(event, …)` may pass: only those the catalogue lists for it. */
export type EventFields<E extends DiagnosticEvent> = {
  readonly [K in FieldsOf<E>]?: FieldTypes[K];
} & ((typeof diagnosticCatalogue)[E]['severity'] extends 'by-call'
  ? { readonly severity: Severity }
  : { readonly severity?: never });
