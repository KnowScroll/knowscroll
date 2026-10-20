import {
  OBSERVATION_LIMITS,
  ObservationBatchRequestSchema,
  type InteractionEvent,
  type ObservationBatchRequest,
} from '@knowscroll/contracts';

/** The storage the outbox persists to: the account scope's own (`AccountScope.storage`). */
export interface OutboxStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * What delivering one batch achieved:
 * - `delivered`: the API stored it (every per-event status is final: accepted, duplicate or
 *   rejected), so the batch leaves the outbox;
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
  readonly send: (batch: ObservationBatchRequest) => Promise<SendOutcome>;
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
}

export interface ObservationOutbox {
  /**
   * Forms bounded batches (count and bytes) from `events`, persists them and starts delivering. A
   * batch is immutable once formed, so every retry sends the same event IDs.
   */
  enqueue(events: readonly InteractionEvent[], instrumentationVersion: number): void;
  /** Delivers queued batches in order until the queue is empty or a delivery must wait. */
  drain(): Promise<void>;
  status(): OutboxStatus;
  /** Stops timers and sending, and writes nothing more. Idempotent. Called when the scope ends. */
  dispose(): void;
}

/** The storage key of the persisted outbox, under the account scope's own prefix. */
export const OUTBOX_STORAGE_KEY = 'recorder.outbox.v1';

interface StoredOutbox {
  readonly v: 1;
  readonly dropped: number;
  readonly batches: readonly ObservationBatchRequest[];
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
  let queue: ObservationBatchRequest[] = [];
  let dropped = 0;
  let stopped = false;
  let draining = false;
  let attempt = 0;
  let retryTimer: unknown;

  const persist = (): void => {
    if (stopped || !options.isActive()) return;
    if (queue.length === 0 && dropped === 0) {
      options.storage.remove(OUTBOX_STORAGE_KEY);
      return;
    }
    const stored: StoredOutbox = { v: 1, dropped, batches: queue };
    options.storage.set(OUTBOX_STORAGE_KEY, JSON.stringify(stored));
  };

  const load = (): void => {
    const raw = options.storage.get(OUTBOX_STORAGE_KEY);
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; dropped?: unknown; batches?: unknown };
      if (parsed.v !== 1 || !Array.isArray(parsed.batches)) {
        options.storage.remove(OUTBOX_STORAGE_KEY);
        return;
      }
      for (const candidate of parsed.batches as unknown[]) {
        const batch = ObservationBatchRequestSchema.safeParse(candidate);
        if (batch.success) queue.push(batch.data);
        else dropped += 1;
      }
      dropped += typeof parsed.dropped === 'number' ? parsed.dropped : 0;
    } catch {
      options.storage.remove(OUTBOX_STORAGE_KEY);
    }
  };

  const enforceLimits = (): void => {
    while (queue.length > maxBatches || (queue.length > 1 && byteLength(queue) > maxBytes)) {
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
        const batch = queue[0];
        if (batch === undefined) {
          attempt = 0;
          return;
        }
        const outcome = await options.send(batch);
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
      }
    } finally {
      draining = false;
    }
  }

  load();
  if (queue.length > 0) void drain();

  return {
    enqueue(events, instrumentationVersion) {
      if (stopped || !options.isActive() || events.length === 0) return;
      let current: InteractionEvent[] = [];
      const flushCurrent = (): void => {
        if (current.length === 0) return;
        queue.push({ instrumentationVersion, events: current });
        current = [];
      };
      for (const event of events) {
        const candidate = [...current, event];
        const tooMany = candidate.length > OBSERVATION_LIMITS.maxEventsPerBatch;
        const tooBig = candidate.length > 1 && byteLength(candidate) > OBSERVATION_LIMITS.maxBatchBytes - 64;
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
    }),
    dispose() {
      stop();
    },
  };
}
