import {
  AbuseReportRequestSchema,
  ContentErrorReportRequestSchema,
  type AbuseReportRequest,
  type ContentErrorReportRequest,
  type ReportReceipt,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { ScopeEndedError } from './account-scope';
import { apiProblem } from './api-client';
import { outboxRetryDelay, type OutboxTimers } from './recorder/outbox';

/** Reports kept for a connection at most; the oldest are dropped first. */
export const QUEUED_REPORT_LIMIT = 10;

const STORAGE_KEY = 'feedback.reports.v1';

export type QueuedReport =
  | { readonly kind: 'content_error'; readonly request: ContentErrorReportRequest }
  | { readonly kind: 'abuse'; readonly request: AbuseReportRequest };

/**
 * What sending a report came to. `queued` means no answer came: the report is kept, sent again with
 * the same command ID, and the person is told it will go when they are online. `try_again` is the
 * server's trouble: nothing is kept, and the person's retry reuses the same ID.
 */
export type ReportOutcome =
  | { readonly status: 'received'; readonly receipt: ReportReceipt }
  | { readonly status: 'queued' }
  | { readonly status: 'refused'; readonly reason: 'unavailable' | 'too_many' | 'try_again' };

type Delivery = ReportOutcome | { readonly status: 'offline' };

/** Problems after which a retry cannot help: the target is gone, the request is wrong or the scope has ended. */
const REFUSED = new Set([
  'NOT_FOUND',
  'ASSET_NOT_FOUND',
  'INVALID_REQUEST',
  'COMMAND_KEY_REUSED',
  'UNPROCESSABLE_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
  'SCOPE_MISMATCH',
  'ORIGIN_NOT_ALLOWED',
]);

function parseQueue(raw: string | undefined): QueuedReport[] {
  if (raw === undefined) return [];
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items.flatMap((item: { kind?: unknown; request?: unknown }): QueuedReport[] => {
      if (item.kind === 'content_error') {
        const request = ContentErrorReportRequestSchema.safeParse(item.request);
        return request.success ? [{ kind: 'content_error', request: request.data }] : [];
      }
      if (item.kind === 'abuse') {
        const request = AbuseReportRequestSchema.safeParse(item.request);
        return request.success ? [{ kind: 'abuse', request: request.data }] : [];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export interface ReportQueueOptions {
  readonly scope: AccountScope;
  readonly timers: OutboxTimers;
  /** A number in [0, 1) for retry jitter. */
  readonly random: () => number;
  /** Called whenever the number of waiting reports changes, so the store can publish it. */
  readonly onQueued: (waiting: number) => void;
}

export interface ReportQueue {
  readonly send: (report: QueuedReport) => Promise<ReportOutcome>;
  /** Reads reports kept from an earlier run and sends them. Safe to call whenever a feedback surface opens. */
  readonly resume: () => void;
  /** Ends the retry timer when the scope ends. */
  readonly stop: () => void;
}

/**
 * The reports waiting for a connection (P03, D-055). A report is saved in the scope's storage (at most
 * ten) before it is sent, so a reload does not lose it. With no answer it stays and is sent again with
 * the same command ID after 1, 2, 4 ... 60 seconds; any answer that settles it removes it.
 */
export function createReportQueue(options: ReportQueueOptions): ReportQueue {
  const { scope, timers, random, onQueued } = options;
  let queue: QueuedReport[] = [];
  let loaded = false;
  let draining = false;
  let attempt = 0;
  let retryTimer: unknown;

  const persist = (): void => {
    if (!scope.active) return;
    if (queue.length === 0) scope.storage.remove(STORAGE_KEY);
    else scope.storage.set(STORAGE_KEY, JSON.stringify(queue));
    onQueued(queue.length);
  };

  const forget = (report: QueuedReport): void => {
    queue = queue.filter((kept) => kept.request.commandId !== report.request.commandId);
    persist();
  };

  /** Sends one report and says what came of it. Network trouble keeps the report; anything an answer settles removes it. */
  async function deliver(report: QueuedReport): Promise<Delivery> {
    try {
      const receipt =
        report.kind === 'abuse'
          ? await scope.api.feedback.reportAbuse(report.request)
          : await scope.api.feedback.reportContentError(report.request);
      if (receipt.commandId !== report.request.commandId) throw new Error('report_lineage');
      forget(report);
      return { status: 'received', receipt };
    } catch (error) {
      if (error instanceof ScopeEndedError || !scope.active) return { status: 'refused', reason: 'unavailable' };
      const problem = apiProblem(error);
      // No problem document means no answer at all: the network.
      if (problem === undefined) return { status: 'offline' };
      forget(report);
      if (problem.code === 'TOO_MANY_REQUESTS') return { status: 'refused', reason: 'too_many' };
      return { status: 'refused', reason: REFUSED.has(problem.code) ? 'unavailable' : 'try_again' };
    }
  }

  function scheduleRetry(): void {
    if (!scope.active || queue.length === 0 || retryTimer !== undefined) return;
    const delay = outboxRetryDelay(attempt, random);
    attempt += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, delay);
  }

  /** Delivers the kept reports in order; the first one that gets no answer ends the pass and schedules the next. */
  async function drain(): Promise<void> {
    if (draining || !scope.active) return;
    draining = true;
    try {
      for (const report of [...queue]) {
        const result = await deliver(report);
        if (result.status === 'offline') {
          scheduleRetry();
          return;
        }
        attempt = 0;
      }
    } finally {
      draining = false;
    }
  }

  function load(): void {
    if (loaded || !scope.active) return;
    loaded = true;
    const kept = parseQueue(scope.storage.get(STORAGE_KEY));
    const known = new Set(queue.map((report) => report.request.commandId));
    queue = [...kept.filter((report) => !known.has(report.request.commandId)), ...queue].slice(-QUEUED_REPORT_LIMIT);
    persist();
  }

  return {
    async send(report) {
      load();
      queue = [...queue.filter((kept) => kept.request.commandId !== report.request.commandId), report].slice(
        -QUEUED_REPORT_LIMIT,
      );
      persist();
      const result = await deliver(report);
      if (result.status !== 'offline') {
        void drain();
        return result;
      }
      scheduleRetry();
      return { status: 'queued' };
    },
    resume() {
      load();
      void drain();
    },
    stop() {
      timers.clearTimeout(retryTimer);
    },
  };
}
