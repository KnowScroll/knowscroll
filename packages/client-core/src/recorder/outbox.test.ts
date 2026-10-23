import {
  OBSERVATION_LIMITS,
  type InteractionEvent,
  type RecordingObservationBatchRequest,
} from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_STORAGE_KEY,
  createObservationOutbox,
  outboxRetryDelay,
  type OutboxStorage,
  type SendOutcome,
} from './outbox';

let counter = 0;
function dwellEvent(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  counter += 1;
  return {
    schemaVersion: 'interaction.v1',
    eventId: `0199f0a0-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    sessionId: '0199f0a0-0000-7000-8000-00000000aaaa',
    deviceSequence: counter,
    exposureId: '0199f0a0-0000-7000-8000-00000000bbbb',
    assetId: '0199f0a0-0000-7000-8000-00000000cccc',
    assetRevision: 1,
    kind: 'scroll.active_dwell',
    occurredAt: '2026-10-20T10:00:00.000Z',
    payload: { activeIntervalsMs: [[0, 1_000]] },
    ...overrides,
  } as InteractionEvent;
}

function memory(): OutboxStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

/** A manual timer: `fire()` runs the scheduled retry. */
function manualTimers() {
  const scheduled: { callback: () => void; ms: number }[] = [];
  return {
    scheduled,
    timers: {
      setTimeout: (callback: () => void, ms: number) => scheduled.push({ callback, ms }),
      clearTimeout: () => undefined,
    },
    fire: () => scheduled.shift()?.callback(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(answers: SendOutcome[], options: { maxBatches?: number; maxBytes?: number } = {}) {
  const storage = memory();
  const sent: RecordingObservationBatchRequest[] = [];
  const timer = manualTimers();
  let active = true;
  const outbox = createObservationOutbox({
    storage,
    isActive: () => active,
    send: (batch) => {
      sent.push(batch);
      return Promise.resolve(answers.shift() ?? { kind: 'delivered' });
    },
    timers: timer.timers,
    random: () => 0,
    ...options,
  });
  return { storage, sent, timer, outbox, end: () => (active = false) };
}

describe('the durable observation outbox', () => {
  it('delivers from memory when storage writes fail from quota exhaustion', async () => {
    const sent: RecordingObservationBatchRequest[] = [];
    const outbox = createObservationOutbox({
      storage: {
        get: () => undefined,
        set: () => {
          throw new Error('quota');
        },
        remove: () => {
          throw new Error('quota');
        },
      },
      isActive: () => true,
      send: (batch) => {
        sent.push(batch);
        return Promise.resolve({ kind: 'delivered' });
      },
    });
    const original = dwellEvent();
    expect(() => outbox.enqueue([original], 1, 1)).not.toThrow();
    await settle();
    expect(sent).toEqual([
      { version: 'observation-batch.v2', recordingGeneration: 1, instrumentationVersion: 1, events: [original] },
    ]);
    expect(outbox.status().pendingEvents).toBe(0);
  });

  it('persists a batch, sends it, and forgets it once the API stored it', async () => {
    const { storage, sent, outbox } = setup([]);
    const events = [dwellEvent(), dwellEvent()];
    outbox.enqueue(events, 1, 1);
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(true);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
    expect(sent[0]?.instrumentationVersion).toBe(1);
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(false);
    expect(outbox.status()).toMatchObject({ pendingBatches: 0, pendingEvents: 0, dropped: 0 });
  });

  it("forms bounded batches: at most the contract's event count, in order", async () => {
    const { sent, outbox } = setup([]);
    const events = Array.from({ length: OBSERVATION_LIMITS.maxEventsPerBatch * 2 + 5 }, () => dwellEvent());
    outbox.enqueue(events, 1, 1);
    await settle();
    await settle();
    expect(sent.map((batch) => batch.events.length)).toEqual([
      OBSERVATION_LIMITS.maxEventsPerBatch,
      OBSERVATION_LIMITS.maxEventsPerBatch,
      5,
    ]);
    expect(sent.flatMap((batch) => batch.events.map((event) => event.eventId))).toEqual(
      events.map((event) => event.eventId),
    );
  });

  it('forms bounded batches by bytes too: no batch is larger than the contract allows', async () => {
    const { sent, outbox } = setup([]);
    const heavy = (): InteractionEvent =>
      dwellEvent({
        kind: 'scroll.block_coverage',
        payload: {
          blocks: Array.from({ length: 24 }, (_, index) => ({
            blockId: `block-${String(index)}`,
            intervalsMs: Array.from({ length: 8 }, (_, step): [number, number] => [
              step * 2_000_000,
              step * 2_000_000 + 1_999_999,
            ]),
            peakFraction: 0.5,
          })),
        },
      });
    outbox.enqueue(Array.from({ length: 12 }, heavy), 1, 1);
    for (let index = 0; index < 6; index += 1) await settle();
    expect(sent.length).toBeGreaterThan(1);
    for (const batch of sent)
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(
        OBSERVATION_LIMITS.maxBatchBytes,
      );
    expect(sent.reduce((total, batch) => total + batch.events.length, 0)).toBe(12);
  });

  it('retries the SAME batch (same event IDs) with backoff after a failure, and only then forgets it', async () => {
    const { storage, sent, timer, outbox } = setup([{ kind: 'retry' }, { kind: 'retry' }]);
    const events = [dwellEvent(), dwellEvent()];
    outbox.enqueue(events, 1, 1);
    await settle();
    expect(sent).toHaveLength(1);
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]?.ms).toBe(outboxRetryDelay(0, () => 0));
    // New events do not hurry a delivery that must wait.
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(sent).toHaveLength(1);
    timer.fire();
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.events.map((event) => event.eventId)).toEqual(sent[0]?.events.map((event) => event.eventId));
    expect(timer.scheduled[0]?.ms).toBe(outboxRetryDelay(1, () => 0));
    timer.fire();
    await settle();
    await settle();
    expect(sent[2]?.events.map((event) => event.eventId)).toEqual(sent[0]?.events.map((event) => event.eventId));
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(false);
  });

  it('backs off 1 s, 2 s, 4 s ... up to a minute', () => {
    expect([0, 1, 2, 3, 10, 20].map((attempt) => outboxRetryDelay(attempt, () => 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000,
    ]);
    expect(outboxRetryDelay(0, () => 0.999)).toBeLessThanOrEqual(1_250);
  });

  it('drops a batch the API refused as malformed or too large, and goes on with the next', async () => {
    const { sent, outbox } = setup([{ kind: 'drop' }]);
    const first = [dwellEvent()];
    outbox.enqueue(first, 1, 1);
    await settle();
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(sent).toHaveLength(2);
    expect(outbox.status().dropped).toBe(1);
    expect(outbox.status().pendingBatches).toBe(0);
  });

  it('survives a reload: the next outbox of the same scope sends what the last one left, with the same IDs', async () => {
    const storage = memory();
    const events = [dwellEvent(), dwellEvent()];
    const first = createObservationOutbox({
      storage,
      isActive: () => true,
      send: () => Promise.resolve({ kind: 'retry' }),
      timers: manualTimers().timers,
    });
    first.enqueue(events, 1, 1);
    await settle();
    first.dispose();
    const sent: RecordingObservationBatchRequest[] = [];
    createObservationOutbox({
      storage,
      isActive: () => true,
      send: (batch) => {
        sent.push(batch);
        return Promise.resolve({ kind: 'delivered' });
      },
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(false);
  });

  it('writes nothing and sends nothing once its scope has ended (sign-out, account switch, privacy reset)', async () => {
    const { storage, sent, outbox, end } = setup([{ kind: 'retry' }]);
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(true);
    // The scope ends: its storage is purged by the scope itself, and the outbox must not refill it.
    end();
    storage.values.clear();
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(storage.values.size).toBe(0);
    expect(sent).toHaveLength(1);
    outbox.dispose();
    expect(outbox.status()).toMatchObject({ stopped: true, pendingBatches: 0 });
  });

  it("stops for good when the API says the scope is no longer this client's", async () => {
    const { sent, outbox, timer } = setup([{ kind: 'scope_ended' }]);
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(sent).toHaveLength(1);
    expect(timer.scheduled).toHaveLength(0);
    expect(outbox.status().stopped).toBe(true);
  });

  it('keeps the queue bounded, dropping the oldest batches first and counting them as lost', async () => {
    const { outbox } = setup(
      Array.from({ length: 10 }, (): SendOutcome => ({ kind: 'retry' })),
      { maxBatches: 2 },
    );
    for (let index = 0; index < 4; index += 1) outbox.enqueue([dwellEvent()], 1, 1);
    await settle();
    expect(outbox.status().pendingBatches).toBe(2);
    expect(outbox.status().dropped).toBe(2);
  });

  it('discards a stored queue it cannot read instead of failing', async () => {
    const storage = memory();
    storage.set(OUTBOX_STORAGE_KEY, '{ this is not json');
    const sent: RecordingObservationBatchRequest[] = [];
    const outbox = createObservationOutbox({
      storage,
      isActive: () => true,
      send: (batch) => {
        sent.push(batch);
        return Promise.resolve({ kind: 'delivered' });
      },
    });
    await settle();
    expect(sent).toEqual([]);
    expect(storage.values.has(OUTBOX_STORAGE_KEY)).toBe(false);
    expect(outbox.status().pendingBatches).toBe(0);
    storage.set(
      OUTBOX_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        dropped: 0,
        batches: [
          {
            version: 'observation-batch.v2',
            recordingGeneration: 1,
            instrumentationVersion: 1,
            events: [{ nonsense: true }],
          },
        ],
      }),
    );
    const again = createObservationOutbox({
      storage,
      isActive: () => true,
      send: () => Promise.resolve({ kind: 'delivered' }),
    });
    expect(again.status()).toMatchObject({ pendingBatches: 0, dropped: 1 });
  });
});

describe('immutable generation-bearing v2 persistence (CI fixtures)', () => {
  it('never mixes or relabels original generations across transport retry and reload', async () => {
    const f = setup([{ kind: 'retry' }]);
    const old = dwellEvent();
    f.outbox.enqueue([old], 1, 1);
    await settle();
    f.outbox.enqueue([dwellEvent()], 1, 3);
    expect(Object.isFrozen(f.sent[0])).toBe(true);
    expect(Object.isFrozen(f.sent[0]?.events[0]?.payload)).toBe(true);
    const original = JSON.stringify(f.sent[0]);
    f.timer.fire();
    await settle();
    expect(JSON.stringify(f.sent[1])).toBe(original);
    expect(f.sent.map((batch) => batch.recordingGeneration)).toEqual([1, 1, 3]);
    expect(old).not.toBe(f.sent[0]?.events[0]);
  });
  it('drops and counts legacy v1 without inventing a generation and keeps an existing v2 queue', async () => {
    const storage = memory();
    storage.set(
      'recorder.outbox.v1',
      JSON.stringify({ v: 1, dropped: 2, batches: [{ instrumentationVersion: 1, events: [dwellEvent()] }] }),
    );
    const current = {
      version: 'observation-batch.v2' as const,
      recordingGeneration: 3,
      instrumentationVersion: 1,
      events: [dwellEvent()],
    };
    storage.set(OUTBOX_STORAGE_KEY, JSON.stringify({ v: 2, dropped: 0, batches: [current] }));
    const sent: RecordingObservationBatchRequest[] = [];
    const first = createObservationOutbox({
      storage,
      isActive: () => true,
      send: (batch) => {
        sent.push(batch);
        return Promise.resolve({ kind: 'retry' });
      },
      timers: manualTimers().timers,
    });
    await settle();
    expect(sent).toEqual([current]);
    expect(first.status().dropped).toBe(3);
    expect(storage.get('recorder.outbox.v1')).toBeUndefined();
    first.dispose();
    const second = createObservationOutbox({
      storage,
      isActive: () => true,
      send: () => Promise.resolve({ kind: 'delivered' }),
    });
    await settle();
    expect(second.status().dropped).toBe(3);
  });
  it('missing original generation is counted, never sent through legacy intake', () => {
    const f = setup([]);
    f.outbox.enqueue([dwellEvent()], 1);
    expect(f.outbox.status().dropped).toBe(1);
    expect(f.sent).toEqual([]);
  });
});
