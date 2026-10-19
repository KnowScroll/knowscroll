import pino, { type DestinationStream, type Logger } from 'pino';
import {
  diagnosticCatalogue,
  type DiagnosticEvent,
  type EventFields,
  type FieldName,
  type Severity,
} from './catalogue.js';
import { sanitiseError, scrubText } from './sanitise.js';

/**
 * Writes one catalogued diagnostic event. The only application logging path (blueprint §26).
 * Emit success events after the corresponding transaction commits; a log line is never proof
 * of a committed effect.
 */
export type LogEvent = <E extends DiagnosticEvent>(event: E, fields?: EventFields<E>) => void;

export interface EventLogOptions {
  /** `api`, `worker` or `migrate`. */
  readonly service: string;
  /** World name (`dev`, `stage`, `ci`, …). */
  readonly environment: string;
  /** Build revision (commit SHA or `unknown`). */
  readonly revision: string;
  /** Where lines go; defaults to stdout, which journald captures on the VPS. */
  readonly destination?: DestinationStream;
  /** Lowest severity written. Defaults to `info`. */
  readonly minimumSeverity?: Severity;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const codeLikePattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const routePattern = /^\/[A-Za-z0-9/_:.{}*-]{0,199}$|^unmatched$/;
const methodPattern = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;

type Validator = (value: unknown) => unknown;
const REJECTED = Symbol('rejected');

const asId: Validator = (value) => (typeof value === 'string' && idPattern.test(value) ? value : REJECTED);
const asCode: Validator = (value) => (typeof value === 'string' && codeLikePattern.test(value) ? value : REJECTED);
const asCount: Validator = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : REJECTED;
const asText =
  (limit: number): Validator =>
  (value) =>
    typeof value === 'string' ? scrubText(value).slice(0, limit) : REJECTED;

const validators: Record<FieldName, Validator> = {
  operationId: asId,
  requestId: asId,
  commandId: asId,
  eventId: asId,
  causationId: asId,
  correlationId: asId,
  encounterId: asId,
  exposureId: asId,
  decisionId: asId,
  demandId: asId,
  jobId: asId,
  runId: asId,
  attemptId: asId,
  proposalId: asId,
  deltaId: asId,
  receiptId: asId,
  contentRevisionId: asId,
  traceId: asId,
  spanId: asId,
  outcome: asCode,
  reasonCode: asCode,
  durationMs: asCount,
  method: (value) => (typeof value === 'string' && methodPattern.test(value) ? value : REJECTED),
  route: (value) => (typeof value === 'string' && routePattern.test(value) ? value : REJECTED),
  status: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : REJECTED,
  queue: asCode,
  retryCount: asCount,
  count: asCount,
  revision: asCount,
  migration: asCode,
  signal: (value) => (typeof value === 'string' && /^SIG[A-Z0-9]{2,10}$/.test(value) ? value : REJECTED),
  pid: asCount,
  nodeVersion: (value) => (typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value) ? value : REJECTED),
  context: (value) => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : REJECTED),
  message: asText(300),
  problems: (value) =>
    Array.isArray(value)
      ? value.slice(0, 20).map((item) => (typeof item === 'string' ? scrubText(item).slice(0, 200) : '[invalid]'))
      : REJECTED,
  error: (value) => sanitiseError(value),
};

/**
 * The general journal is not a per-person store with selective deletion (blueprint §26 "Logging
 * retention and erasure must agree"), so its projection keeps only IDs that cannot be joined to
 * a person: the per-request ID and trace context. Personal-linkable IDs (commands, receipts,
 * jobs, runs, attempts, evidence) belong in erasable domain/diagnostic records.
 */
export const JOURNAL_FIELDS: ReadonlySet<FieldName> = new Set<FieldName>([
  'requestId',
  'traceId',
  'spanId',
  'outcome',
  'reasonCode',
  'durationMs',
  'method',
  'route',
  'status',
  'queue',
  'retryCount',
  'count',
  'revision',
  'migration',
  'signal',
  'pid',
  'nodeVersion',
  'context',
  'message',
  'problems',
  'error',
]);

const severityRank: Record<Severity, number> = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** Creates the process's `logEvent`, writing the journal projection through Pino. */
export function createEventLog(options: EventLogOptions): LogEvent {
  const logger: Logger = pino(
    {
      level: options.minimumSeverity ?? 'info',
      base: null,
      timestamp: false,
      messageKey: 'eventMessage',
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination ?? pino.destination({ dest: 1, sync: true }),
  );
  return (event, fields) => {
    const spec = diagnosticCatalogue[event];
    const input = (fields ?? {}) as Record<string, unknown>;
    const severity: Severity =
      spec.severity === 'by-call' ? ((input['severity'] as Severity | undefined) ?? 'info') : spec.severity;
    if (severityRank[severity] < severityRank[options.minimumSeverity ?? 'info']) return;
    const record: Record<string, unknown> = {
      schemaVersion: 'diagnostic.v1',
      time: new Date().toISOString(),
      service: options.service,
      module: spec.module,
      environment: options.environment,
      revision: options.revision,
      event,
    };
    let rejected = 0;
    let withheld = 0;
    for (const name of spec.fields as readonly FieldName[]) {
      if (!(name in input) || input[name] === undefined) continue;
      if (!JOURNAL_FIELDS.has(name)) {
        withheld += 1;
        continue;
      }
      const value = validators[name](input[name]);
      if (value === REJECTED) rejected += 1;
      else record[name] = value;
    }
    if (rejected > 0) record['rejectedFields'] = rejected;
    if (withheld > 0) record['withheldFields'] = withheld;
    logger[severity](record);
  };
}
