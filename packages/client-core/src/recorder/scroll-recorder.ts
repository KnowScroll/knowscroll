import {
  INTERACTION_SCHEMA_VERSION,
  RecordingObservationBatchResponseSchema,
  type InteractionEvent,
  type RecordingObservationBatchRequest,
} from '@knowscroll/contracts';
import type { ApiClient } from '../api-client';
import { apiProblem } from '../api-client';
import { ScopeEndedError, type AccountScope } from '../account-scope';
import { createObservationOutbox, type ObservationOutbox, type SendOutcome } from './outbox';
import type { ReadingObserver } from './observer';
import { ReadingTracker } from './reading-tracker';

/** The build of this recorder; the server treats a lower number than its policy asks for as missing instrumentation. */
export const RECORDER_INSTRUMENTATION_VERSION = 1;

/** Where the reading being recorded comes from: the exposure's lineage the server validates. */
export interface RecordedExposure {
  readonly exposureId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  /** Exact original eligible activation generation, never inferred from an old receipt. */
  readonly recordingGeneration?: number;
  readonly recordingSessionId?: string;
}

export interface RecorderClock {
  /** Monotonic milliseconds (`performance.now()`). */
  readonly monotonicMs: () => number;
  /** Client wall time as ISO-8601 UTC, used only as a sanity claim. */
  readonly wallIso: () => string;
}

export interface RecorderTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ScrollRecorderOptions {
  readonly exposure: RecordedExposure;
  /** The owning account scope: its storage holds the outbox, its API delivers, its end stops everything. */
  readonly scope: Pick<AccountScope, 'api' | 'storage' | 'active'> &
    Partial<Pick<AccountScope, 'account' | 'recording' | 'onEnd'>>;
  /** UUIDs for the recorder session and each event (the app's command-ID generator). */
  readonly newId: () => string;
  readonly clock?: RecorderClock;
  readonly timers?: RecorderTimers;
  /** A report is built at most this often while the article is open (default 15 s). */
  readonly flushIntervalMs?: number;
  /** Test seam: the outbox to use (default: the scope's own, shared by every recorder of the scope). */
  readonly outbox?: ObservationOutbox;
}

export interface ScrollRecorder {
  /** Hand this to the article: it satisfies the renderer's `ScrollReadingObserver`. */
  readonly observer: ReadingObserver;
  /**
   * Starts the periodic report (every `flushIntervalMs` while there is something to say). May be
   * called again after `end()` (a development double-mount re-runs the screen's effect); events the
   * observer receives before `start()` are kept and reported by the first flush.
   */
  start(): void;
  /** Park this same handle: close/flush actual reading, forget renderer state and stop its timer. */
  suspend(): void;
  /**
   * Unpark without changing session/timebase. Fresh visibility AND activity reports are required;
   * resume itself creates no reading. Re-arms the timer only if start() was previously called.
   */
  resume(): void;
  /** Reports what happened since the last flush now (the article transitions, backgrounds, unloads). */
  flush(): void;
  /** The reading is over (the route unmounts): reports the final time and stops the timer. */
  end(): void;
  /** The recorder session ID events carry. */
  readonly sessionId: string;
}

const defaultClock: RecorderClock = {
  monotonicMs: () => performance.now(),
  wallIso: () => new Date().toISOString(),
};

const defaultTimers: RecorderTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One outbox per account scope, shared by every recorder of that scope (and gone with it). */
const scopeOutboxes = new WeakMap<object, ObservationOutbox>();

/** Problems that mean the scope is no longer this client's: stop sending and never write again. */
const SCOPE_ENDED_PROBLEMS: ReadonlySet<string> = new Set([
  'SCOPE_MISMATCH',
  'PRIVACY_EPOCH_CHANGED',
  'UNAUTHENTICATED',
  'UNIVERSE_UNAVAILABLE',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
]);

/** Problems a retry cannot fix: the batch was malformed or too large, or nothing here can take it. */
const DROPPED_PROBLEMS: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'UNPROCESSABLE_REQUEST',
  'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND',
]);

/**
 * Delivers one batch through the scope's API and classifies the outcome (blueprint §19): a stored
 * batch is `delivered` whatever each event's final status; network failures, 5xx, 429 and lock
 * timeouts are `retry` (the same batch is sent again); a malformed or oversized batch is `drop`
 * (retrying cannot fix it); everything that means the scope is no longer this client's
 * (`ScopeEndedError`, a refused session, a changed epoch, `SCOPE_MISMATCH`) is `scope_ended`.
 */
export function deliverBatch(
  api: ApiClient,
  scope?: Partial<Pick<AccountScope, 'account' | 'recording'>>,
): (batch: RecordingObservationBatchRequest) => Promise<SendOutcome> {
  return async (batch) => {
    try {
      const response = RecordingObservationBatchResponseSchema.parse(await api.observations.submitRecording(batch));
      if (
        !scope?.account ||
        response.scope.accountId.toLowerCase() !== scope.account.accountId.toLowerCase() ||
        response.scope.privacyEpoch !== scope.account.privacyEpoch ||
        response.recordingGeneration !== batch.recordingGeneration ||
        (response.result === 'processed' &&
          (response.results.length !== batch.events.length ||
            response.results.some(
              (result, i) => result.eventId.toLowerCase() !== batch.events[i]!.eventId.toLowerCase(),
            )))
      ) {
        scope?.recording?.invalidate();
        return { kind: 'retry' };
      }
      if (response.result === 'not_recorded') void scope.recording?.refresh();
      return { kind: 'delivered' };
    } catch (error) {
      scope?.recording?.invalidate();
      if (error instanceof ScopeEndedError) return { kind: 'scope_ended' };
      const problem = apiProblem(error);
      if (problem === undefined) return { kind: 'retry' };
      if (SCOPE_ENDED_PROBLEMS.has(problem.code)) return { kind: 'scope_ended' };
      if (DROPPED_PROBLEMS.has(problem.code)) return { kind: 'drop' };
      return { kind: 'retry' }; // Unknown refusals never masquerade as a correlated terminal ACK.
    }
  };
}

/** The scope's outbox, created on first use over the scope's storage and API. */
export function scopeOutbox(
  scope: Pick<AccountScope, 'api' | 'storage' | 'active'> &
    Partial<Pick<AccountScope, 'account' | 'recording' | 'onEnd'>>,
): ObservationOutbox {
  let outbox = scopeOutboxes.get(scope);
  if (outbox === undefined) {
    outbox = createObservationOutbox({
      storage: scope.storage,
      isActive: () => scope.active,
      send: deliverBatch(scope.api, scope),
    });
    scopeOutboxes.set(scope, outbox);
    scope.onEnd?.(() => outbox?.dispose());
  }
  return outbox;
}

/**
 * The reading recorder of one Scroll exposure (blueprint §18 "Shared interaction recorder"):
 * implements the renderer's observer, tracks per-block visible intervals and active dwell (inactive
 * time, an overlay, a hidden tab never count), and emits bounded `interaction.v1` events with stable
 * event IDs and a device sequence into the scope's durable outbox. It weights nothing: the server
 * computes coverage and q.
 *
 * - **When it reports:** every `flushIntervalMs` while there is something to say, on `flush()`
 *   (article transition, backgrounding), and on `end()`. Correctness never depends on an unload
 *   callback: the periodic flush persists what was seen so far.
 * - **What an event is:** per report, one `scroll.block_coverage` (visible intervals per block),
 *   one `scroll.active_dwell` (active and visible intervals) and one `scroll.block_interaction` per
 *   new (block, kind). The first report of a session is always sent, even when nothing was seen,
 *   so "instrumented, saw nothing" is distinguishable from "no instrumentation".
 * - **Stable IDs:** every event gets its ID and sequence number once; the outbox sends the same
 *   batch unchanged until the API acknowledges it.
 * - **Scope:** the outbox is the account scope's; when the scope ends nothing is sent or written.
 */
export function createScrollRecorder(options: ScrollRecorderOptions): ScrollRecorder {
  const clock = options.clock ?? defaultClock;
  const timers = options.timers ?? defaultTimers;
  const outbox = options.outbox ?? scopeOutbox(options.scope);
  const startedAt = clock.monotonicMs();
  let tracker = new ReadingTracker({ startedAt });
  const sessionId = options.exposure.recordingSessionId ?? options.newId();
  let eligible = false;
  let revoked = false;
  let sequence = 0;
  let sentFirst = false;
  let ended = false;
  let suspended = false;
  let started = false;
  let scopeEnded = false;
  let acceptAfter = Number.NEGATIVE_INFINITY;
  let handle: unknown;

  let policyOff: (() => void) | undefined;
  const watchPolicy = () => {
    policyOff ??= options.scope.recording?.subscribe(() => {
      scopeActive();
    });
  };
  watchPolicy();

  const stopTimer = (): void => {
    if (handle !== undefined) timers.clearInterval(handle);
    handle = undefined;
  };
  const scopeActive = (): boolean => {
    if (!options.scope.active) scopeEnded = true;
    if (scopeEnded) stopTimer();
    const policy = options.scope.recording?.getState();
    if (policy?.policy && policy.policy.generation !== options.exposure.recordingGeneration) revoked = true;
    const allowed =
      !scopeEnded &&
      !revoked &&
      options.exposure.recordingGeneration !== undefined &&
      options.exposure.recordingSessionId !== undefined &&
      policy?.collecting === true &&
      policy.policy?.generation === options.exposure.recordingGeneration;
    if (allowed !== eligible) {
      eligible = allowed;
      tracker = new ReadingTracker({ startedAt });
      acceptAfter = clock.monotonicMs();
    }
    return !scopeEnded && eligible;
  };
  const accepts = (at?: number): boolean =>
    scopeActive() && !ended && !suspended && (at === undefined || at >= acceptAfter);

  const envelope = (): Omit<InteractionEvent, 'kind' | 'payload'> => {
    sequence += 1;
    return {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      eventId: options.newId(),
      sessionId,
      deviceSequence: sequence,
      exposureId: options.exposure.exposureId,
      assetId: options.exposure.assetId,
      assetRevision: options.exposure.assetRevision,
      occurredAt: clock.wallIso(),
    };
  };

  const report = (): void => {
    if (!scopeActive()) return;
    const events: InteractionEvent[] = [];
    let first = !sentFirst;
    let guard = 0;
    do {
      const report = tracker.report(clock.monotonicMs());
      const hasCoverage = report.blocks.length > 0;
      const hasDwell = report.activeIntervalsMs.length > 0;
      // The very first report is always sent, even when nothing was seen: "instrumented, saw
      // nothing" must differ from "no instrumentation".
      if (first || hasCoverage) {
        events.push({
          ...envelope(),
          kind: 'scroll.block_coverage',
          payload: {
            blocks: report.blocks.map((block) => ({
              blockId: block.blockId,
              intervalsMs: block.intervalsMs.map(([from, to]): [number, number] => [from, to]),
              peakFraction: block.peakFraction,
            })),
          },
        });
      }
      if (first || hasDwell) {
        events.push({
          ...envelope(),
          kind: 'scroll.active_dwell',
          payload: { activeIntervalsMs: report.activeIntervalsMs.map(([from, to]): [number, number] => [from, to]) },
        });
      }
      for (const interaction of report.interactions) {
        events.push({
          ...envelope(),
          kind: 'scroll.block_interaction',
          payload: { blockId: interaction.blockId, kind: interaction.kind, atMs: interaction.atMs },
        });
      }
      first = false;
      guard += 1;
    } while (tracker.hasMore() && guard < 50);
    if (events.length > 0) {
      sentFirst = true;
      outbox.enqueue(events, RECORDER_INSTRUMENTATION_VERSION, options.exposure.recordingGeneration);
    }
  };

  const flush = (): void => {
    if (accepts()) report();
  };
  const tick = (): void => {
    if (!accepts()) return;
    if (tracker.hasContent()) flush();
  };
  const startTimer = (): void => {
    if (started && !suspended) handle ??= timers.setInterval(tick, options.flushIntervalMs ?? 15_000);
  };

  const observer: ReadingObserver = {
    onBlockVisibility: (event) => {
      if (accepts(event.at)) tracker.visibility(event);
    },
    onBlockInteraction: (event) => {
      if (accepts(event.at)) tracker.interaction(event);
    },
    onActivity: (event) => {
      if (!accepts(event.at)) return;
      tracker.activity(event);
      // Best effort when the article stops being in front: what was seen so far is persisted.
      if (!event.active) flush();
    },
  };

  return {
    observer,
    get sessionId() {
      return sessionId;
    },
    start() {
      watchPolicy();
      if (!scopeActive()) return;
      if (ended) acceptAfter = clock.monotonicMs();
      ended = false;
      started = true;
      startTimer();
    },
    suspend() {
      if (!accepts()) return;
      tracker.suspend(clock.monotonicMs());
      suspended = true;
      stopTimer();
      report();
    },
    resume() {
      if (!scopeActive() || ended || !suspended) return;
      acceptAfter = clock.monotonicMs();
      suspended = false;
      startTimer();
    },
    flush,
    end() {
      policyOff?.();
      policyOff = undefined;
      if (!scopeActive() || ended) return;
      tracker.suspend(clock.monotonicMs());
      ended = true;
      suspended = false;
      stopTimer();
      report();
    },
  };
}
