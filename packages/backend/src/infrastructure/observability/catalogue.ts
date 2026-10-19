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
  'realtime.connection_refused': { severity: 'info', module: 'realtime', fields: ['reasonCode', 'error'] },
  'realtime.subscription_refused': { severity: 'info', module: 'realtime', fields: ['reasonCode'] },
  'reasoning.attempt_settled': {
    severity: 'info',
    module: 'reasoning',
    fields: ['attemptId', 'runId', 'outcome', 'reasonCode', 'durationMs'],
  },
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
