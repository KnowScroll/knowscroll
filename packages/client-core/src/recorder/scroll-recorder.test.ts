import { ORPCError } from '@orpc/client';
import {
  problemDetails,
  type InteractionEvent,
  type ObservationBatchRequest,
  type ProblemCode,
} from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import { ScopeEndedError, createAccountScope, memoryStore } from '../account-scope';
import type { ApiClient } from '../api-client';
import { createObservationOutbox, OUTBOX_STORAGE_KEY, type ObservationOutbox } from './outbox';
import { RECORDER_INSTRUMENTATION_VERSION, createScrollRecorder, deliverBatch } from './scroll-recorder';

const exposure = {
  exposureId: '0199f0a0-0000-7000-8000-000000000e01',
  assetId: '0199f0a0-0000-7000-8000-000000000a01',
  assetRevision: 3,
};

function fakeClock(start = 5_000) {
  let now = start;
  return {
    clock: { monotonicMs: () => now, wallIso: () => new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + now).toISOString() },
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

function fakeTimers() {
  const intervals = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      setInterval: (callback: () => void) => {
        const id = next++;
        intervals.set(id, callback);
        return id;
      },
      clearInterval: (id: unknown) => void intervals.delete(id as number),
    },
    running: () => intervals.size,
    tick: () => [...intervals.values()].forEach((callback) => callback()),
  };
}

function idSource() {
  let n = 0;
  return () => `0199f0a0-0000-7000-8000-${String(++n).padStart(12, '0')}`;
}

/** An outbox double that records what the recorder hands it. */
function collectingOutbox() {
  const batches: { events: readonly InteractionEvent[]; instrumentationVersion: number }[] = [];
  const outbox: ObservationOutbox = {
    enqueue: (events, instrumentationVersion) => void batches.push({ events, instrumentationVersion }),
    drain: () => Promise.resolve(),
    status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
    dispose: () => undefined,
  };
  return { outbox, batches, events: () => batches.flatMap((batch) => [...batch.events]) };
}

function build(options: { active?: () => boolean } = {}) {
  const clock = fakeClock();
  const timers = fakeTimers();
  const sink = collectingOutbox();
  const recorder = createScrollRecorder({
    exposure,
    scope: {
      api: {} as ApiClient,
      storage: memoryStore() as never,
      get active() {
        return options.active?.() ?? true;
      },
    },
    newId: idSource(),
    clock: clock.clock,
    timers: timers.timers,
    flushIntervalMs: 15_000,
    outbox: sink.outbox,
  });
  return { recorder, clock, timers, sink };
}

describe('the scroll recorder', () => {
  it("implements the renderer's three observer events and reports intervals, dwell and interactions as bounded events", () => {
    const { recorder, clock, sink } = build();
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 1, at: clock.now() + 1_000 });
    recorder.observer.onBlockInteraction({ blockId: 'intro', kind: 'expanded', at: clock.now() + 2_000 });
    clock.advance(6_000);
    recorder.flush();
    const events = sink.events();
    expect(events.map((event) => event.kind)).toEqual([
      'scroll.block_coverage',
      'scroll.active_dwell',
      'scroll.block_interaction',
    ]);
    expect(events[0]?.payload).toEqual({
      blocks: [{ blockId: 'intro', intervalsMs: [[1_000, 6_000]], peakFraction: 1 }],
    });
    expect(events[1]?.payload).toEqual({ activeIntervalsMs: [[1_000, 6_000]] });
    expect(events[2]?.payload).toEqual({ blockId: 'intro', kind: 'expanded', atMs: 2_000 });
    expect(sink.batches[0]?.instrumentationVersion).toBe(RECORDER_INSTRUMENTATION_VERSION);
  });

  it("carries the exposure's lineage, a stable unique ID per event and a device sequence 1, 2, 3 ...", () => {
    const { recorder, clock, sink } = build();
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'intro', visibleFraction: 1, at: clock.now() });
    clock.advance(1_000);
    recorder.flush();
    clock.advance(1_000);
    recorder.flush();
    const events = sink.events();
    expect(events.map((event) => event.deviceSequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set([recorder.sessionId]));
    for (const event of events) {
      expect(event).toMatchObject({ schemaVersion: 'interaction.v1', ...exposure });
      expect(typeof event.occurredAt).toBe('string');
    }
  });

  it('sends the first report even when nothing was seen, so "instrumented" differs from "no instrumentation"', () => {
    const { recorder, sink } = build();
    recorder.start();
    recorder.flush();
    expect(sink.events().map((event) => event.kind)).toEqual(['scroll.block_coverage', 'scroll.active_dwell']);
    expect(sink.events()[0]?.payload).toEqual({ blocks: [] });
    // Later reports with nothing to say send nothing.
    recorder.flush();
    expect(sink.events()).toHaveLength(2);
  });

  it('counts no time while inactive and flushes when the article stops being in front', () => {
    const { recorder, clock, sink } = build();
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(4_000);
    recorder.observer.onActivity({ active: false, at: clock.now() });
    // Backgrounded: the flush on inactivity already persisted what was seen.
    expect(sink.events().map((event) => event.kind)).toEqual(['scroll.block_coverage', 'scroll.active_dwell']);
    clock.advance(60_000);
    recorder.observer.onActivity({ active: true, at: clock.now() });
    clock.advance(1_000);
    recorder.flush();
    const dwell = sink
      .events()
      .filter((event) => event.kind === 'scroll.active_dwell')
      .map((event) => event.payload);
    expect(dwell).toEqual([{ activeIntervalsMs: [[0, 4_000]] }, { activeIntervalsMs: [[64_000, 65_000]] }]);
  });

  it('reports on a timer only when there is something to say, and stops on end()', () => {
    const { recorder, clock, timers, sink } = build();
    recorder.start();
    timers.tick();
    expect(sink.events()).toHaveLength(0);
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(15_000);
    timers.tick();
    expect(sink.events().map((event) => event.kind)).toEqual(['scroll.block_coverage', 'scroll.active_dwell']);
    clock.advance(2_000);
    recorder.end();
    expect(timers.running()).toBe(0);
    const last = sink.events().slice(2);
    expect(last.map((event) => event.kind)).toEqual(['scroll.block_coverage', 'scroll.active_dwell']);
    // end() twice reports nothing more; start() after end() re-arms the timer (a development double mount).
    recorder.end();
    expect(sink.events()).toHaveLength(4);
    recorder.start();
    expect(timers.running()).toBe(1);
  });

  it('writes nothing once its scope has ended', () => {
    let active = true;
    const { recorder, clock, sink } = build({ active: () => active });
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    active = false;
    clock.advance(5_000);
    recorder.flush();
    recorder.end();
    expect(sink.events()).toEqual([]);
  });

  it("splits a long report into events within the contract's per-event bounds", () => {
    const { recorder, clock, sink } = build();
    recorder.start();
    for (let index = 0; index < 30; index += 1) {
      recorder.observer.onBlockVisibility({
        blockId: `block-${String(index)}`,
        visibleFraction: 1,
        at: clock.now() + 100,
      });
      recorder.observer.onBlockVisibility({
        blockId: `block-${String(index)}`,
        visibleFraction: 0,
        at: clock.now() + 900,
      });
    }
    clock.advance(2_000);
    recorder.flush();
    const coverage = sink.events().filter((event) => event.kind === 'scroll.block_coverage');
    expect(coverage.length).toBeGreaterThan(1);
    for (const event of coverage)
      if (event.kind === 'scroll.block_coverage') expect(event.payload.blocks.length).toBeLessThanOrEqual(24);
    const seen = coverage.flatMap((event) =>
      event.kind === 'scroll.block_coverage' ? event.payload.blocks.map((block) => block.blockId) : [],
    );
    expect(new Set(seen).size).toBe(30);
  });
});

describe("delivering a batch through the scope's API", () => {
  const batch: ObservationBatchRequest = { instrumentationVersion: 1, events: [] };

  function apiFailing(error: Error): ApiClient {
    return { observations: { submit: () => Promise.reject(error) } } as unknown as ApiClient;
  }
  const problem = (code: ProblemCode) =>
    new ORPCError(code, { status: problemDetails(code).status, data: problemDetails(code) });

  it('treats a stored batch as delivered, and a network failure, 5xx and 429 as retry', async () => {
    const ok = { observations: { submit: () => Promise.resolve({}) } } as unknown as ApiClient;
    expect(await deliverBatch(ok)(batch)).toEqual({ kind: 'delivered' });
    expect(await deliverBatch(apiFailing(new TypeError('fetch failed')))(batch)).toEqual({ kind: 'retry' });
    expect(await deliverBatch(apiFailing(problem('SERVICE_UNAVAILABLE')))(batch)).toEqual({ kind: 'retry' });
    expect(await deliverBatch(apiFailing(problem('INTERNAL')))(batch)).toEqual({ kind: 'retry' });
    expect(await deliverBatch(apiFailing(problem('TOO_MANY_REQUESTS')))(batch)).toEqual({ kind: 'retry' });
  });

  it('drops a batch that is malformed or too large: a retry cannot fix it', async () => {
    for (const code of ['INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNPROCESSABLE_REQUEST'] as const)
      expect(await deliverBatch(apiFailing(problem(code)))(batch)).toEqual({ kind: 'drop' });
  });

  it("stops when the scope is no longer this client's", async () => {
    for (const code of ['SCOPE_MISMATCH', 'PRIVACY_EPOCH_CHANGED', 'UNAUTHENTICATED'] as const)
      expect(await deliverBatch(apiFailing(problem(code)))(batch)).toEqual({ kind: 'scope_ended' });
    expect(await deliverBatch(apiFailing(new ScopeEndedError()))(batch)).toEqual({ kind: 'scope_ended' });
  });
});

describe('the recorder inside a real account scope', () => {
  const account = {
    accountId: '0199a000-0000-7000-8000-00000000000a',
    universeId: '0199a000-0000-7000-8000-0000000000aa',
    privacyEpoch: 1,
    email: 'a@recorder.test',
  };

  function scopeWith(answer: () => Response) {
    const requests: { url: string; scope: string | null; body: unknown }[] = [];
    const store = memoryStore();
    const scope = createAccountScope({
      account,
      baseUrl: 'https://app.recorder.test',
      fetch: async (request: Request) => {
        requests.push({
          url: request.url,
          scope: request.headers.get('x-ks-scope'),
          body: await request.clone().json(),
        });
        return answer();
      },
      authorization: () => undefined,
      store,
    });
    return { scope, store, requests };
  }

  const stored = () =>
    new Response(JSON.stringify({ accepted: 2, duplicates: 0, rejected: 0, results: [], revision: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("posts the batch with the scope's claim, and removes it from storage once stored", async () => {
    const { scope, store, requests } = scopeWith(stored);
    const clock = fakeClock();
    const recorder = createScrollRecorder({
      exposure,
      scope,
      newId: idSource(),
      clock: clock.clock,
      timers: fakeTimers().timers,
    });
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(3_000);
    recorder.flush();
    expect(store.keys().some((key) => key.endsWith(OUTBOX_STORAGE_KEY))).toBe(true);
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://app.recorder.test/v1/observations/batch');
    expect(requests[0]?.scope).toBe(`${account.accountId}:1`);
    expect((requests[0]?.body as ObservationBatchRequest).events).toHaveLength(2);
    expect(store.keys()).toEqual([]);
  });

  it('purges its unsent batches when the scope ends and never writes again, even for a late flush', async () => {
    const { scope, store, requests } = scopeWith(() => new Response('unavailable', { status: 503 }));
    const clock = fakeClock();
    const recorder = createScrollRecorder({
      exposure,
      scope,
      newId: idSource(),
      clock: clock.clock,
      timers: fakeTimers().timers,
    });
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(3_000);
    recorder.flush();
    await settle();
    expect(requests).toHaveLength(1);
    expect(store.keys().length).toBeGreaterThan(0);
    // Sign-out, an account switch or a privacy reset ends the scope: its storage is purged.
    scope.end();
    expect(store.keys()).toEqual([]);
    // What the unmounting screen does afterwards must neither write nor send.
    clock.advance(3_000);
    recorder.end();
    await settle();
    expect(store.keys()).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('retries the same event IDs through the real outbox after a failed send', async () => {
    let calls = 0;
    const { scope, requests } = scopeWith(() => (calls++ === 0 ? new Response('no', { status: 503 }) : stored()));
    const clock = fakeClock();
    const retryTimers = { fire: undefined as undefined | (() => void) };
    const outbox = createObservationOutbox({
      storage: scope.storage,
      isActive: () => scope.active,
      send: deliverBatch(scope.api),
      timers: {
        setTimeout: (callback: () => void) => void (retryTimers.fire = callback),
        clearTimeout: () => undefined,
      },
      random: () => 0,
    });
    const recorder = createScrollRecorder({
      exposure,
      scope,
      newId: idSource(),
      clock: clock.clock,
      timers: fakeTimers().timers,
      outbox,
    });
    recorder.start();
    recorder.flush();
    await settle();
    retryTimers.fire?.();
    await settle();
    expect(requests).toHaveLength(2);
    const ids = (index: number) =>
      (requests[index]?.body as ObservationBatchRequest).events.map((event) => event.eventId);
    expect(ids(1)).toEqual(ids(0));
  });
});
