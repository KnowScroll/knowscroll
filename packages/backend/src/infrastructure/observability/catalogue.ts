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
  // Evidence intake (API) and projection (worker). Counts and codes; no event, block or exposure
  // content (D-017); personal-linkable IDs are withheld from the journal by the sink projection.
  'evidence.observations_ingested': {
    severity: 'info',
    module: 'evidence',
    fields: ['requestId', 'count', 'outcome', 'reasonCode'],
  },
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
  'reasoning.requests_purged': { severity: 'info', module: 'reasoning', fields: ['count'] },
  'reasoning.purge_failed': { severity: 'warn', module: 'reasoning', fields: ['error'] },
  // A refused production answer could not be kept for diagnosis; the attempt's outcome is unchanged.
  'reasoning.rejected_answer_not_recorded': { severity: 'warn', module: 'reasoning', fields: ['attemptId', 'error'] },
  'migrate.started': { severity: 'info', module: 'migrate', fields: ['count'] },
  'migrate.completed': { severity: 'info', module: 'migrate', fields: ['count', 'migration', 'durationMs'] },
  'migrate.failed': { severity: 'fatal', module: 'migrate', fields: ['migration', 'reasonCode', 'error'] },
} as const satisfies Record<string, EventSpec>;

export type DiagnosticEvent = keyof typeof diagnosticCatalogue;

type FieldsOf<E extends DiagnosticEvent> = (typeof diagnosticCatalogue)[E]['fields'][number];

/** The fields a call to `logEvent(event, …)` may pass: only those the catalogue lists for it. */
export type EventFields<E extends DiagnosticEvent> = {
  readonly [K in FieldsOf<E>]?: FieldTypes[K];
} & ((typeof diagnosticCatalogue)[E]['severity'] extends 'by-call'
  ? { readonly severity: Severity }
  : { readonly severity?: never });
