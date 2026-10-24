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
import { announceBlocksChanged } from './blocks';
import { outboxRetryDelay, type OutboxTimers } from './recorder/outbox';
import { blockFriend } from './talk-inbox';

/** How long the acknowledgement of "Not interested" offers Undo. The constraint itself lasts longer. */
export const UNDO_WINDOW_MS = 8_000;

/** Reports kept for a connection at most; the oldest are dropped first. */
export const QUEUED_REPORT_LIMIT = 10;

const STORAGE_KEY = 'feedback.reports.v1';

export type QueuedReport =
  | { readonly kind: 'content_error'; readonly request: ContentErrorReportRequest }
  | { readonly kind: 'abuse'; readonly request: AbuseReportRequest };

/** Where "Not interested" stands for the last asset the person tapped it on (P03 card 2). */
export type NotInterestedState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving'; readonly assetId: string }
  /** Saved. `resume` is whatever the caller handed in to put the person back where they were on Undo. */
  | { readonly status: 'acknowledged'; readonly assetId: string; readonly resume: string | undefined }
  | { readonly status: 'undoing'; readonly assetId: string }
  | { readonly status: 'failed'; readonly assetId: string; readonly step: 'mark' | 'undo' };

export interface FeedbackState {
  readonly notInterested: NotInterestedState;
  /** Reports waiting for a connection ("Will send when online"). */
  readonly queued: number;
}

/**
 * What sending a report came to. `queued` means no answer came: the report is kept, sent again with
 * the same command ID, and the person is told it will go when they are online. `try_again` is the
 * server's trouble: nothing is kept, and the person's retry reuses the same ID.
 */
export type ReportOutcome =
  | { readonly status: 'received'; readonly receipt: ReportReceipt }
  | { readonly status: 'queued' }
  | { readonly status: 'refused'; readonly reason: 'unavailable' | 'too_many' | 'try_again' };

export interface FeedbackStore {
  readonly getState: () => FeedbackState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the asset out of the person's offers. True once the server has said so. */
  readonly markNotInterested: (assetId: string, resume?: string) => Promise<boolean>;
  /** Repeats the step that failed with the same command ID. */
  readonly retryNotInterested: () => Promise<boolean>;
  /** Takes the last mark back. True once the server has said so; the caller then restores `resume`. */
  readonly undoNotInterested: () => Promise<boolean>;
  /** Hides the acknowledgement; the constraint stays. */
  readonly dismissNotInterested: () => void;
  readonly sendReport: (report: QueuedReport) => Promise<ReportOutcome>;
  /** Blocks a person after a report. True when the block was accepted. */
  readonly blockPerson: (personId: string) => Promise<boolean>;
  /** Reads reports kept from an earlier run and sends them. Safe to call whenever a feedback surface opens. */
  readonly resume: () => void;
}

export interface FeedbackStoreOptions {
  readonly scope: AccountScope;
  readonly newId: () => string;
  readonly timers?: OutboxTimers;
  /** A number in [0, 1) for retry jitter. */
  readonly random?: () => number;
}

const defaultTimers: OutboxTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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

type Delivery = ReportOutcome | { readonly status: 'offline' };

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

const stores = new WeakMap<object, FeedbackStore>();

/**
 * The scope's feedback store, created on first use (P03, D-055). It holds three things the screens
 * share: the acknowledgement of "Not interested" with its timed Undo, which must outlive the sheet
 * that started it and survive the move to the next subject; the reports waiting for a connection,
 * kept in the scope's storage so a reload does not lose them; and blocking a person after a report.
 *
 * Every command's ID is minted once per intent and reused by each retry. Nothing here reads a report
 * back: the person gets a receipt, and what the safety team does with it is not theirs to see.
 */
export function feedbackFor(options: FeedbackStoreOptions): FeedbackStore {
  const existing = stores.get(options.scope);
  if (existing !== undefined) return existing;
  const store = createFeedbackStore(options);
  stores.set(options.scope, store);
  return store;
}

export function createFeedbackStore(options: FeedbackStoreOptions): FeedbackStore {
  const { scope, newId } = options;
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  const listeners = new Set<() => void>();
  let state: FeedbackState = { notInterested: { status: 'idle' }, queued: 0 };
  let queue: QueuedReport[] = [];
  let loaded = false;
  let draining = false;
  let attempt = 0;
  let retryTimer: unknown;
  let graceTimer: unknown;
  /** The step in flight or failed, with its command ID, so a retry repeats exactly it. */
  let intent: { readonly step: 'mark' | 'undo'; readonly commandId: string; readonly resume: string | undefined } | undefined;

  function publish(patch: Partial<FeedbackState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  scope.onEnd?.(() => {
    timers.clearTimeout(retryTimer);
    timers.clearTimeout(graceTimer);
    listeners.clear();
  });

  // --- Not interested -----------------------------------------------------------------------

  function startGrace(): void {
    timers.clearTimeout(graceTimer);
    graceTimer = timers.setTimeout(() => {
      if (state.notInterested.status === 'acknowledged') publish({ notInterested: { status: 'idle' } });
    }, UNDO_WINDOW_MS);
  }

  async function runMark(assetId: string, commandId: string, resume: string | undefined): Promise<boolean> {
    timers.clearTimeout(graceTimer);
    intent = { step: 'mark', commandId, resume };
    publish({ notInterested: { status: 'saving', assetId } });
    try {
      const answer = await scope.api.feedback.notInterested({ commandId, assetId });
      if (!scope.active) return false;
      if (answer.commandId !== commandId || answer.assetId !== assetId) throw new Error('not_interested_lineage');
      intent = undefined;
      publish({ notInterested: { status: 'acknowledged', assetId, resume } });
      startGrace();
      return true;
    } catch {
      publish({ notInterested: { status: 'failed', assetId, step: 'mark' } });
      return false;
    }
  }

  async function runUndo(assetId: string, commandId: string, resume: string | undefined): Promise<boolean> {
    timers.clearTimeout(graceTimer);
    intent = { step: 'undo', commandId, resume };
    publish({ notInterested: { status: 'undoing', assetId } });
    try {
      const answer = await scope.api.feedback.undoNotInterested({ commandId, assetId });
      if (!scope.active) return false;
      if (answer.commandId !== commandId || answer.assetId !== assetId) throw new Error('not_interested_lineage');
      intent = undefined;
      publish({ notInterested: { status: 'idle' } });
      return true;
    } catch {
      publish({ notInterested: { status: 'failed', assetId, step: 'undo' } });
      return false;
    }
  }

  // --- Reports ------------------------------------------------------------------------------

  const persist = (): void => {
    if (!scope.active) return;
    if (queue.length === 0) scope.storage.remove(STORAGE_KEY);
    else scope.storage.set(STORAGE_KEY, JSON.stringify(queue));
    publish({ queued: queue.length });
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
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markNotInterested: (assetId, resume) => runMark(assetId, newId(), resume),
    retryNotInterested() {
      const failed = state.notInterested;
      if (failed.status !== 'failed' || intent === undefined) return Promise.resolve(false);
      return failed.step === 'mark'
        ? runMark(failed.assetId, intent.commandId, intent.resume)
        : runUndo(failed.assetId, intent.commandId, intent.resume);
    },
    undoNotInterested() {
      const marked = state.notInterested;
      if (marked.status !== 'acknowledged') return Promise.resolve(false);
      return runUndo(marked.assetId, newId(), marked.resume);
    },
    dismissNotInterested() {
      timers.clearTimeout(graceTimer);
      if (state.notInterested.status !== 'saving' && state.notInterested.status !== 'undoing')
        publish({ notInterested: { status: 'idle' } });
    },
    async sendReport(report) {
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
    async blockPerson(personId) {
      const blocked = await blockFriend(scope, newId, personId);
      if (blocked && scope.active) announceBlocksChanged(scope);
      return blocked;
    },
    resume() {
      load();
      void drain();
    },
  };
}
