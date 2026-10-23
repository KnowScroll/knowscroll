import type { StorageDurability } from '../account-scope';
import {
  OBSERVATION_LIMITS,
  RecordingObservationBatchRequestSchema,
  type InteractionEvent,
  type RecordingObservationBatchRequest,
} from '@knowscroll/contracts';

/** The storage the outbox persists to: the account scope's own (`AccountScope.storage`). */
export interface OutboxStorage {
  readonly durability?: StorageDurability;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * What delivering one batch achieved:
 * - `delivered`: a strictly correlated v2 processed or not_recorded answer is terminal for this
 *   exact batch. Intake is not qualification; a refused old generation is never relabelled;
 * - `retry`: nothing is known to be stored (network, 5xx, 429, a lock timeout): keep the batch and
 *   send the **same** batch (same event IDs) later;
 * - `drop`: the API refused the batch as malformed or too large; retrying cannot fix it;
 * - `scope_ended`: the account scope ended or the API says the scope is no longer this client's
 *   (sign-out, account switch, privacy reset): stop, and never write again.
 */
export type SendOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'scope_ended' };

export interface OutboxTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ObservationOutboxOptions {
  readonly storage: OutboxStorage;
  /** Whether the owning scope is still active; the outbox neither sends nor writes once it is not. */
  readonly isActive: () => boolean;
  readonly send: (batch: RecordingObservationBatchRequest) => Promise<SendOutcome>;
  readonly timers?: OutboxTimers;
  /** A number in [0, 1) for retry jitter. */
  readonly random?: () => number;
  /** Persisted batches kept at most; the oldest are dropped first and counted (a gap the server sees). */
  readonly maxBatches?: number;
  /** Persisted bytes kept at most (canonical JSON of the stored batches). */
  readonly maxBytes?: number;
}

/** What a person-facing or diagnostic view may know about the outbox. */
export interface OutboxStatus {
  readonly pendingBatches: number;
  readonly pendingEvents: number;
  /** Batches dropped for size, malformedness or storage limits since this outbox started. */
  readonly dropped: number;
  readonly stopped: boolean;
  readonly purgeUnconfirmed?: true;
}

export interface ObservationOutbox {
  /**
   * Forms bounded batches (count and bytes) from `events`, persists them and starts delivering. A
   * batch is immutable once formed, so every retry sends the same event IDs.
   */
  enqueue(events: readonly InteractionEvent[], instrumentationVersion: number, recordingGeneration?: number): void;
  /** Delivers queued batches in order until the queue is empty or a delivery must wait. */
  drain(): Promise<void>;
  status(): OutboxStatus;
  /** Stops timers and sending, and writes nothing more. Idempotent. Called when the scope ends. */
  dispose(): void;
}

/** The storage key of the persisted outbox, under the account scope's own prefix. */
export const OUTBOX_STORAGE_KEY = 'recorder.outbox.v2';
const LEGACY_STORAGE_KEY = 'recorder.outbox.v1';

interface StoredOutbox {
  readonly v: 2;
  readonly legacyDiscarded: boolean;
  readonly dropped: number;
  readonly batches: readonly RecordingObservationBatchRequest[];
}

/** Retry delay in milliseconds: 1 s doubling to 60 s, with up to 25% jitter. */
export function outboxRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (1 + 0.25 * random()));
}

const defaultTimers: OutboxTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function freezeBatch(batch: RecordingObservationBatchRequest): RecordingObservationBatchRequest {
  const copy = JSON.parse(JSON.stringify(batch)) as RecordingObservationBatchRequest;
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The scope's durable observation outbox (blueprint §18, §19): batches the recorder produced and the
 * API has not acknowledged, persisted under the account scope so a reload keeps them and a scope
 * end (sign-out, account switch, privacy reset) removes them with the rest of the scope's storage.
 *
 * - **Bounded:** a batch holds at most `maxEventsPerBatch` events and `maxBatchBytes` bytes; the
 *   persisted queue holds at most `maxBatches` and `maxBytes`, dropping the **oldest** first. A drop
 *   is a gap in the recorder's device sequence, which the server reads as lost events (an unknown
 *   qualification), never as reading.
 * - **Same IDs on retry:** a batch is stored exactly as formed; delivery repeats it unchanged.
 * - **No blind eviction of commands:** this queue holds observations only; commands (Save, send)
 *   have their own receipts and retry state.
 * - **Fenced:** once `isActive()` is false nothing is sent or written (a late callback of an ended
 *   scope must not repopulate its purged storage); a `scope_ended` outcome from the API does the same.
 * - **Lossy on the web by nature:** a crash before a flush loses the unflushed tail; absence is
 *   unknown, never inferred reading.
 */
export function createObservationOutbox(options: ObservationOutboxOptions): ObservationOutbox {
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  const maxBatches = options.maxBatches ?? 40;
  const maxBytes = options.maxBytes ?? 262_144;
  let queue: RecordingObservationBatchRequest[] = [];
  let dropped = 0;
  let legacyDiscarded = false;
  let stopped = false;
  let draining = false;
  let attempt = 0;
  let retryTimer: unknown;
  let purgeUnconfirmed = false;
  const durable = options.storage.durability;
  const storedValue = () =>
    queue.length === 0 && dropped === 0 && !legacyDiscarded
      ? undefined
      : JSON.stringify({ v: 2, dropped, batches: queue, legacyDiscarded });
  const committed = () => (durable ? durable.flush({ [OUTBOX_STORAGE_KEY]: storedValue() }) : Promise.resolve(true));

  const persist = (): void => {
    if (stopped || !options.isActive()) return;
    try {
      if (queue.length === 0 && dropped === 0 && !legacyDiscarded) {
        options.storage.remove(OUTBOX_STORAGE_KEY);
        return;
      }
      const stored: StoredOutbox = { v: 2, dropped, batches: queue, legacyDiscarded };
      options.storage.set(OUTBOX_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Web storage failure retains lossy memory delivery. Native still requires the commit barrier.
    }
  };

  const load = (): void => {
    let raw: string | undefined;
    try {
      raw = options.storage.get(OUTBOX_STORAGE_KEY);
    } catch {
      return;
    }
    if (raw !== undefined)
      try {
        const parsed = JSON.parse(raw) as {
          v?: unknown;
          dropped?: unknown;
          batches?: unknown;
          legacyDiscarded?: unknown;
        };
        if (parsed.v !== 2 || !Array.isArray(parsed.batches)) {
          options.storage.remove(OUTBOX_STORAGE_KEY);
        } else {
          legacyDiscarded = parsed.legacyDiscarded === true;
          for (const candidate of parsed.batches as unknown[]) {
            const batch = RecordingObservationBatchRequestSchema.safeParse(candidate);
            if (batch.success) queue.push(freezeBatch(batch.data));
            else dropped += 1;
          }
          dropped += Number.isSafeInteger(parsed.dropped) && Number(parsed.dropped) >= 0 ? Number(parsed.dropped) : 0;
        }
      } catch {
        options.storage.remove(OUTBOX_STORAGE_KEY);
      }
    // v1 has no provable original generation. Count/disclose it once; never stamp current policy.
    try {
      const legacy = options.storage.get(LEGACY_STORAGE_KEY);
      if (legacy !== undefined) {
        if (!legacyDiscarded) {
          try {
            const value = JSON.parse(legacy) as { batches?: unknown; dropped?: unknown };
            dropped += Array.isArray(value.batches) ? value.batches.length : 1;
            if (Number.isSafeInteger(value.dropped) && Number(value.dropped) >= 0) dropped += Number(value.dropped);
          } catch {
            dropped += 1;
          }
        }
        // Write merged current queue+disclosure before cleanup; failed cleanup cannot double-count.
        legacyDiscarded = true;
        options.storage.set(OUTBOX_STORAGE_KEY, JSON.stringify({ v: 2, dropped, batches: queue, legacyDiscarded }));
        options.storage.remove(LEGACY_STORAGE_KEY);
      }
    } catch {
      /* Storage failure loses crash durability, never invents legacy provenance. */
    }
  };

  const enforceLimits = (): void => {
    while (
      queue.length > maxBatches ||
      (queue.length > 0 && byteLength({ v: 2, dropped, batches: queue, legacyDiscarded }) > maxBytes)
    ) {
      queue.shift();
      dropped += 1;
    }
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== undefined) return;
    const delay = outboxRetryDelay(attempt, random);
    attempt += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, delay);
  };

  const stop = (): void => {
    stopped = true;
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
    queue = [];
  };

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        if (!options.isActive()) {
          stop();
          return;
        }
        if (durable && purgeUnconfirmed) {
          if (!durable.healthy()) return;
          purgeUnconfirmed = !(await committed());
          if (purgeUnconfirmed) {
            if (durable.healthy()) scheduleRetry();
            return;
          }
          if (stopped || !options.isActive()) {
            stop();
            return;
          }
        }
        const batch = queue[0];
        if (batch === undefined) {
          attempt = 0;
          return;
        }
        if (durable) {
          if (!durable.healthy()) return;
          if (!(await committed())) {
            if (durable.healthy()) scheduleRetry();
            return;
          }
          if (stopped || !options.isActive()) {
            stop();
            return;
          }
          if (queue[0] !== batch) continue;
        }
        const outcome = await options.send(batch).catch((): SendOutcome => ({ kind: 'retry' }));
        if (stopped) return;
        if (!options.isActive() || outcome.kind === 'scope_ended') {
          stop();
          return;
        }
        if (outcome.kind === 'retry') {
          scheduleRetry();
          return;
        }
        // Delivered, or refused for good: that very batch leaves the queue (the limits may have
        // dropped older batches while it was in flight, so it is not necessarily the head any more).
        if (outcome.kind === 'drop') dropped += 1;
        const index = queue.indexOf(batch);
        if (index >= 0) queue.splice(index, 1);
        attempt = 0;
        persist();
        if (durable) {
          purgeUnconfirmed = !(await committed());
          if (purgeUnconfirmed) {
            if (durable.healthy()) scheduleRetry();
            return;
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  if (options.isActive()) load();
  else stop();
  enforceLimits();
  persist();
  if (queue.length > 0) void drain();

  return {
    enqueue(events, instrumentationVersion, recordingGeneration) {
      if (stopped || !options.isActive() || events.length === 0) return;
      if (recordingGeneration === undefined) {
        dropped += 1;
        persist();
        return;
      }
      const envelope = (events: InteractionEvent[]) => ({
        version: 'observation-batch.v2' as const,
        recordingGeneration,
        instrumentationVersion,
        events,
      });
      let current: InteractionEvent[] = [];
      const flushCurrent = (): void => {
        if (current.length === 0) return;
        const parsed = RecordingObservationBatchRequestSchema.safeParse(envelope(current));
        if (parsed.success) queue.push(freezeBatch(parsed.data));
        else dropped += 1;
        current = [];
      };
      for (const event of events) {
        const candidate = [...current, event];
        const tooMany = candidate.length > OBSERVATION_LIMITS.maxEventsPerBatch;
        const tooBig = candidate.length > 1 && byteLength(envelope(candidate)) > OBSERVATION_LIMITS.maxBatchBytes;
        if (tooMany || tooBig) flushCurrent();
        current.push(event);
      }
      flushCurrent();
      enforceLimits();
      persist();
      // A delivery that must wait (backoff) is not hurried by new events.
      if (retryTimer === undefined) void drain();
    },
    drain,
    status: () => ({
      pendingBatches: queue.length,
      pendingEvents: queue.reduce((total, batch) => total + batch.events.length, 0),
      dropped,
      stopped,
      ...(purgeUnconfirmed ? { purgeUnconfirmed: true as const } : {}),
    }),
    dispose() {
      stop();
    },
  };
}
