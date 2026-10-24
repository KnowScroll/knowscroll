import type { AccountScope } from './account-scope';
import { announceBlocksChanged } from './blocks';
import { createReportQueue, type QueuedReport, type ReportOutcome } from './feedback-queue';
import { createUndoAcknowledgement, type NotInterestedState, type NotInterestedStep } from './feedback-undo';
import type { OutboxTimers } from './recorder/outbox';
import { blockFriend } from './talk-inbox';

export { QUEUED_REPORT_LIMIT, type QueuedReport, type ReportOutcome } from './feedback-queue';
export { UNDO_WINDOW_MS, type NotInterestedState, type NotInterestedStep } from './feedback-undo';

export interface FeedbackState {
  readonly notInterested: NotInterestedState;
  /** Reports waiting for a connection ("Will send when online"). */
  readonly queued: number;
}

export interface FeedbackStore {
  readonly getState: () => FeedbackState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the asset out of the person's offers. True once the server has said so. */
  readonly markNotInterested: (assetId: string, resume?: string) => Promise<boolean>;
  /** Repeats the step that failed (a save or an Undo) with the same command ID. */
  readonly retryNotInterested: () => Promise<NotInterestedStep>;
  /** Takes the last mark back. Once done, the caller restores `resume`. */
  readonly undoNotInterested: () => Promise<NotInterestedStep>;
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

const stores = new WeakMap<object, FeedbackStore>();

/**
 * The scope's feedback store, created on first use (P03, D-055). It joins three things the screens
 * share: the acknowledgement of "Not interested" with its timed Undo (`feedback-undo.ts`), which must
 * outlive the sheet that started it; the reports waiting for a connection (`feedback-queue.ts`); and
 * blocking a person after a report.
 *
 * Nothing here reads a report back: the person gets a receipt, and what the safety team does with it
 * is not theirs to see.
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

  function publish(patch: Partial<FeedbackState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  const acknowledgement = createUndoAcknowledgement({
    scope,
    newId,
    timers,
    onChange: (notInterested) => publish({ notInterested }),
  });
  const reports = createReportQueue({ scope, timers, random, onQueued: (queued) => publish({ queued }) });

  scope.onEnd?.(() => {
    acknowledgement.stop();
    reports.stop();
    listeners.clear();
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markNotInterested: acknowledgement.mark,
    retryNotInterested: acknowledgement.retry,
    undoNotInterested: acknowledgement.undo,
    dismissNotInterested: acknowledgement.dismiss,
    sendReport: reports.send,
    async blockPerson(personId) {
      const blocked = await blockFriend(scope, newId, personId);
      if (blocked && scope.active) announceBlocksChanged(scope);
      return blocked;
    },
    resume: reports.resume,
  };
}
