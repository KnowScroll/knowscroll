import { ORPCError } from '@orpc/client';
import {
  problemDetails,
  type InteractionEvent,
  type RecordingObservationBatchRequest,
  type ProblemCode,
} from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import { ScopeEndedError, createAccountScope, memoryStore, type AccountScope } from '../account-scope';
import type { ApiClient } from '../api-client';
import { createObservationOutbox, OUTBOX_STORAGE_KEY, type ObservationOutbox } from './outbox';
import { RECORDER_INSTRUMENTATION_VERSION, createScrollRecorder, deliverBatch } from './scroll-recorder';

const exposure = {
  exposureId: '0199f0a0-0000-7000-8000-000000000e01',
  assetId: '0199f0a0-0000-7000-8000-000000000a01',
  assetRevision: 3,
  recordingGeneration: 1,
  recordingSessionId: '0199f0a0-0000-7000-8000-000000000d01',
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

function build(options: { active?: () => boolean; recording?: AccountScope['recording'] } = {}) {
  const clock = fakeClock();
  const timers = fakeTimers();
  const sink = collectingOutbox();
  const recorder = createScrollRecorder({
    exposure,
    scope: {
      api: {} as ApiClient,
      recording:
        options.recording ??
        ({
          getState: () => ({ collecting: true, policy: { on: true, generation: 1 } }),
          subscribe: () => () => undefined,
        } as never),
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

  it('retains one exposure timeline across parking without counting the gap or parked callbacks', () => {
    const { recorder, clock, timers, sink } = build();
    recorder.start();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(2_000);
    recorder.suspend();
    const first = sink.events();
    expect(timers.running()).toBe(0);
    for (let i = 0; i < 100; i += 1) {
      clock.advance(1_000);
      recorder.observer.onActivity({ active: true, at: clock.now() });
      recorder.observer.onBlockVisibility({ blockId: 'parked', visibleFraction: 1, at: clock.now() });
      recorder.observer.onBlockInteraction({ blockId: 'parked', kind: 'expanded', at: clock.now() });
      recorder.flush();
      recorder.start(); // A repeated effect cannot unpark the encounter.
    }
    expect(sink.events()).toEqual(first);
    expect(timers.running()).toBe(0);
    recorder.resume();
    recorder.resume();
    expect(timers.running()).toBe(1);
    // Delayed observer reports from before resume are ignored even after return.
    recorder.observer.onActivity({ active: true, at: clock.now() - 1 });
    recorder.observer.onBlockVisibility({ blockId: 'stale', visibleFraction: 1, at: clock.now() - 1 });
    clock.advance(1_000);
    timers.tick();
    expect(sink.events()).toEqual(first);
    // Neither activity nor visibility is inferred: both must come from the renderer.
    recorder.observer.onActivity({ active: true, at: clock.now() });
    clock.advance(1_000);
    recorder.flush();
    expect(sink.events()).toEqual(first);
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(3_000);
    recorder.end();
    const events = sink.events();
    expect(events.map((event) => event.deviceSequence)).toEqual([1, 2, 3, 4]);
    expect(events.slice(0, 2)).toEqual(first); // Already queued IDs/envelopes stay unchanged.
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set([recorder.sessionId]));
    expect(events.filter((event) => event.kind === 'scroll.active_dwell').map((event) => event.payload)).toEqual([
      { activeIntervalsMs: [[0, 2_000]] },
      { activeIntervalsMs: [[104_000, 107_000]] },
    ]);
    expect(events.filter((event) => event.kind === 'scroll.block_coverage').map((event) => event.payload)).toEqual([
      { blocks: [{ blockId: 'a', intervalsMs: [[0, 2_000]], peakFraction: 1 }] },
      { blocks: [{ blockId: 'a', intervalsMs: [[104_000, 107_000]], peakFraction: 1 }] },
    ]);
  });

  it('waits for actual activity after resume, including a backgrounded return', () => {
    const { recorder, clock, sink } = build();
    recorder.start();
    recorder.suspend();
    clock.advance(60_000);
    recorder.resume();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    recorder.observer.onActivity({ active: false, at: clock.now() });
    clock.advance(10_000);
    recorder.flush();
    expect(sink.events()).toHaveLength(2); // Only the first empty instrumentation report.
    recorder.observer.onActivity({ active: true, at: clock.now() });
    clock.advance(1_000);
    recorder.end();
    expect(sink.events().at(-1)?.payload).toEqual({ activeIntervalsMs: [[70_000, 71_000]] });
  });

  it('keeps pre-start reports and idempotent lifecycles, while end fences late observers', () => {
    const { recorder, clock, timers, sink } = build();
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    clock.advance(500);
    recorder.end(); // A renderer may report before the parent effect starts.
    expect(sink.events().at(-1)?.payload).toEqual({ activeIntervalsMs: [[0, 500]] });
    recorder.observer.onBlockVisibility({ blockId: 'late', visibleFraction: 1, at: clock.now() });
    recorder.observer.onBlockInteraction({ blockId: 'late', kind: 'expanded', at: clock.now() });
    recorder.resume();
    clock.advance(2_000);
    recorder.flush();
    recorder.end();
    expect(sink.events()).toHaveLength(2);
    recorder.start(); // React development cleanup/setup retains the same recorder.
    recorder.start();
    expect(timers.running()).toBe(1);
    recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
    recorder.observer.onActivity({ active: true, at: clock.now() });
    clock.advance(500);
    recorder.suspend();
    recorder.suspend();
    expect(timers.running()).toBe(0);
    expect(sink.events().at(-1)?.payload).toEqual({ activeIntervalsMs: [[2_500, 3_000]] });
    recorder.resume();
    recorder.resume();
    expect(timers.running()).toBe(1);
    recorder.end();
    expect(timers.running()).toBe(0);
    expect(sink.events()).toHaveLength(4);
  });

  it.each(['callback', 'tick', 'resume', 'start', 'flush', 'suspend', 'end'] as const)(
    'terminally fences a scope and releases its timer on the next %s',
    (next) => {
      let active = true;
      const { recorder, clock, timers, sink } = build({ active: () => active });
      recorder.start();
      recorder.observer.onBlockVisibility({ blockId: 'a', visibleFraction: 1, at: clock.now() });
      clock.advance(1_000);
      active = false;
      if (next === 'callback') recorder.observer.onActivity({ active: true, at: clock.now() });
      else if (next === 'tick') timers.tick();
      else recorder[next]();
      expect(timers.running()).toBe(0);
      active = true; // An ended scope can never revive this handle, even with a faulty adapter.
      recorder.start();
      recorder.resume();
      recorder.observer.onBlockVisibility({ blockId: 'late', visibleFraction: 1, at: clock.now() });
      recorder.observer.onBlockInteraction({ blockId: 'late', kind: 'expanded', at: clock.now() });
      clock.advance(1_000);
      recorder.flush();
      recorder.end();
      expect(timers.running()).toBe(0);
      expect(sink.events()).toEqual([]);
    },
  );

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
  const event: InteractionEvent = {
    schemaVersion: 'interaction.v1',
    eventId: exposure.exposureId,
    sessionId: exposure.recordingSessionId,
    exposureId: exposure.exposureId,
    assetId: exposure.assetId,
    assetRevision: exposure.assetRevision,
    deviceSequence: 1,
    occurredAt: '2026-10-23T00:00:00.000Z',
    kind: 'scroll.active_dwell',
    payload: { activeIntervalsMs: [[0, 1000]] },
  };
  const batch: RecordingObservationBatchRequest = {
    version: 'observation-batch.v2',
    recordingGeneration: 1,
    instrumentationVersion: 1,
    events: [event],
  };
  const account = { accountId: exposure.assetId, privacyEpoch: 1 } as never;

  function apiFailing(error: Error): ApiClient {
    return { observations: { submitRecording: () => Promise.reject(error) } } as unknown as ApiClient;
  }
  const problem = (code: ProblemCode) =>
    new ORPCError(code, { status: problemDetails(code).status, data: problemDetails(code) });

  it('treats a stored batch as delivered, and a network failure, 5xx and 429 as retry', async () => {
    const ok = {
      observations: {
        submitRecording: () =>
          Promise.resolve({
            version: 'observation-batch.v2',
            result: 'processed',
            recordingGeneration: 1,
            currentGeneration: 1,
            scope: { accountId: exposure.assetId, privacyEpoch: 1 },
            accepted: 1,
            duplicates: 0,
            rejected: 0,
            results: [{ eventId: event.eventId, status: 'accepted' }],
            revision: 0,
          }),
      },
    } as unknown as ApiClient;
    expect(await deliverBatch(ok, { account })(batch)).toEqual({ kind: 'delivered' });
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

  async function scopeWith(answer: (batch: RecordingObservationBatchRequest) => Response) {
    const requests: { url: string; scope: string | null; body: unknown }[] = [];
    const store = memoryStore();
    const scope = createAccountScope({
      account,
      baseUrl: 'https://app.recorder.test',
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/v1/privacy/recording/read') {
          const input = (await request.clone().json()) as { readId: string; target: unknown };
          return new Response(
            JSON.stringify({
              version: 'recording-policy.v1',
              ...input,
              scope: { accountId: account.accountId, privacyEpoch: 1 },
              revision: 0,
              policy: { on: true, generation: 1 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        requests.push({
          url: request.url,
          scope: request.headers.get('x-ks-scope'),
          body: await request.clone().json(),
        });
        return answer((await request.clone().json()) as RecordingObservationBatchRequest);
      },
      authorization: () => undefined,
      store,
    });
    await scope.recording?.refresh();
    return { scope, store, requests };
  }

  const stored = (batch: RecordingObservationBatchRequest) =>
    new Response(
      JSON.stringify({
        version: 'observation-batch.v2',
        result: 'processed',
        recordingGeneration: batch.recordingGeneration,
        currentGeneration: 1,
        scope: { accountId: account.accountId, privacyEpoch: 1 },
        accepted: batch.events.length,
        duplicates: 0,
        rejected: 0,
        results: batch.events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
        revision: 0,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("posts the batch with the scope's claim, and removes it from storage once stored", async () => {
    const { scope, store, requests } = await scopeWith(stored);
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
    expect(requests[0]?.url).toBe('https://app.recorder.test/v1/observations/recording-batch');
    expect(requests[0]?.scope).toBe(`${account.accountId}:1`);
    expect((requests[0]?.body as RecordingObservationBatchRequest).events).toHaveLength(2);
    expect(store.keys()).toEqual([]);
  });

  it('purges its unsent batches when the scope ends and never writes again, even for a late flush', async () => {
    const { scope, store, requests } = await scopeWith(() => new Response('unavailable', { status: 503 }));
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

  it('retries the same event IDs through the real outbox after a failed send and parking', async () => {
    let calls = 0;
    const { scope, requests } = await scopeWith((batch) =>
      calls++ === 0 ? new Response('no', { status: 503 }) : stored(batch),
    );
    const clock = fakeClock();
    const retryTimers = { fire: undefined as undefined | (() => void) };
    const outbox = createObservationOutbox({
      storage: scope.storage,
      isActive: () => scope.active,
      send: deliverBatch(scope.api, scope),
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
    recorder.suspend();
    clock.advance(120_000);
    recorder.resume();
    retryTimers.fire?.();
    await settle();
    expect(requests).toHaveLength(2);
    const ids = (index: number) =>
      (requests[index]?.body as RecordingObservationBatchRequest).events.map((event) => event.eventId);
    expect(ids(1)).toEqual(ids(0));
  });
});

describe('strict v2 acknowledgement correlation (CI fixtures)', () => {
  const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const account = { accountId: id(1), privacyEpoch: 2 } as never;
  const events = [1, 2].map((n) => ({
    schemaVersion: 'interaction.v1' as const,
    eventId: id(n + 10),
    sessionId: id(4),
    deviceSequence: n,
    exposureId: id(5),
    assetId: id(6),
    assetRevision: 1,
    occurredAt: '2026-10-23T00:00:00.000Z',
    kind: 'scroll.active_dwell' as const,
    payload: { activeIntervalsMs: [[n * 1000, n * 1000 + 900] as [number, number]] },
  }));
  const batch = { version: 'observation-batch.v2' as const, recordingGeneration: 3, instrumentationVersion: 1, events };
  const base = {
    version: 'observation-batch.v2',
    result: 'processed',
    recordingGeneration: 3,
    currentGeneration: 3,
    scope: { accountId: id(1), privacyEpoch: 2 },
    revision: 1,
    accepted: 2,
    duplicates: 0,
    rejected: 0,
    results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
  };
  const api = (response: unknown) =>
    ({ observations: { submitRecording: () => Promise.resolve(response) } }) as unknown as ApiClient;
  it.each([
    { ...base, scope: { accountId: id(99), privacyEpoch: 2 } },
    { ...base, scope: { accountId: id(1), privacyEpoch: 1 } },
    { ...base, recordingGeneration: 1 },
    { ...base, results: [...base.results].reverse() },
    { ...base, accepted: 1, results: base.results.slice(0, 1) },
    { ...base, accepted: 0 },
    { ...base, unexpected: true },
  ])('retains a malformed, wrong-scope, wrong-generation, wrong-order or wrong-count success %#', async (response) => {
    expect(await deliverBatch(api(response), { account })(batch)).toEqual({ kind: 'retry' });
  });
  it('only correlated intake is terminal; paused/stale is discarded and asks for current policy independently', async () => {
    expect(await deliverBatch(api(base), { account })(batch)).toEqual({ kind: 'delivered' });
    let checks = 0;
    const recording = {
      refresh: () => {
        checks++;
        return Promise.resolve(true);
      },
    } as never;
    for (const [currentGeneration, reason] of [
      [4, 'recording_paused'],
      [5, 'recording_generation_stale'],
    ] as const) {
      const response = {
        version: 'observation-batch.v2',
        result: 'not_recorded',
        recordingGeneration: 3,
        currentGeneration,
        scope: base.scope,
        revision: 9,
        reason,
      };
      expect(await deliverBatch(api(response), { account, recording })(batch)).toEqual({ kind: 'delivered' });
    }
    expect(checks).toBe(2);
  });
});

it('Scroll discards unreported/unknown intervals and never revives old activation after a generation change (CI fixture)', () => {
  let current = { collecting: true, policy: { on: true, generation: 1 } };
  const listeners = new Set<() => void>();
  const recording = {
    getState: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as NonNullable<AccountScope['recording']>;
  const f = build({ recording });
  f.recorder.start();
  f.recorder.observer.onBlockVisibility({ blockId: 'before', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(500);
  current = { ...current, collecting: false };
  listeners.forEach((listener) => listener());
  f.clock.advance(5000);
  f.recorder.observer.onBlockVisibility({ blockId: 'paused', visibleFraction: 1, at: f.clock.now() });
  current = { ...current, collecting: true };
  listeners.forEach((listener) => listener());
  f.recorder.observer.onBlockVisibility({ blockId: 'fresh', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(500);
  f.recorder.flush();
  const coverage = f.sink.events().filter((event) => event.kind === 'scroll.block_coverage');
  expect(coverage.map((event) => event.payload)).toEqual([
    { blocks: [{ blockId: 'fresh', peakFraction: 1, intervalsMs: [[5500, 6000]] }] },
  ]);
  expect(new Set(f.sink.events().map((event) => event.sessionId))).toEqual(new Set([exposure.recordingSessionId]));
  const count = f.sink.events().length;
  current = { collecting: false, policy: { on: false, generation: 2 } };
  listeners.forEach((listener) => listener());
  current = { collecting: true, policy: { on: true, generation: 3 } };
  listeners.forEach((listener) => listener());
  f.recorder.resume();
  f.recorder.start();
  f.recorder.observer.onBlockVisibility({ blockId: 'cannot-relabel', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(1000);
  f.recorder.flush();
  expect(f.sink.events()).toHaveLength(count);
  f.recorder.end();
});

function mutableReadingPolicy(collecting: boolean) {
  let state = { collecting, policy: { on: true, generation: 1 } };
  const listeners = new Set<() => void>();
  return {
    policy: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as NonNullable<AccountScope['recording']>,
    current(value: boolean) {
      state = { ...state, collecting: value };
      listeners.forEach((listener) => listener());
    },
  };
}
it('Scroll end while checking stops timers and fences late callbacks after the same-generation read; explicit start remains separate (CI fixture)', () => {
  const policy = mutableReadingPolicy(true);
  const f = build({ recording: policy.policy });
  f.recorder.start();
  expect(f.timers.running()).toBe(1);
  f.recorder.observer.onBlockVisibility({ blockId: 'unreported', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(500);
  policy.current(false);
  f.recorder.end();
  expect(f.timers.running()).toBe(0);
  const before = f.sink.events().length;
  policy.current(true);
  f.clock.advance(500);
  f.recorder.resume();
  f.recorder.flush();
  f.recorder.observer.onActivity({ active: true, at: f.clock.now() });
  f.recorder.observer.onBlockVisibility({ blockId: 'late', visibleFraction: 1, at: f.clock.now() });
  f.recorder.observer.onBlockInteraction({ blockId: 'late', kind: 'expanded', at: f.clock.now() });
  f.clock.advance(1000);
  f.timers.tick();
  f.recorder.flush();
  expect(f.sink.events()).toHaveLength(before);
  expect(f.timers.running()).toBe(0);
  // Only the explicitly documented remount/start path reopens a Scroll handle.
  f.recorder.start();
  f.recorder.start();
  expect(f.timers.running()).toBe(1);
  f.recorder.observer.onActivity({ active: true, at: f.clock.now() });
  f.recorder.observer.onBlockVisibility({ blockId: 'new-mount', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(1000);
  f.timers.tick();
  expect(
    f.sink
      .events()
      .some(
        (event) =>
          event.kind === 'scroll.block_coverage' && event.payload.blocks.some((block) => block.blockId === 'new-mount'),
      ),
  ).toBe(true);
  f.recorder.end();
  expect(f.timers.running()).toBe(0);
});
it('Scroll start while checking retains periodic flush intent and arms exactly one timer on current authority (CI fixture)', () => {
  const policy = mutableReadingPolicy(false);
  const f = build({ recording: policy.policy });
  f.recorder.start();
  f.recorder.start();
  f.recorder.observer.onBlockVisibility({ blockId: 'ignored', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(15000);
  f.timers.tick();
  expect(f.sink.events()).toEqual([]);
  expect(f.timers.running()).toBe(0);
  policy.current(true);
  // No new start() after release: this must be the saved start intent's subscription auto-arm.
  expect(f.timers.running()).toBe(1);
  f.recorder.observer.onActivity({ active: true, at: f.clock.now() });
  f.recorder.observer.onBlockVisibility({ blockId: 'actual', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(1000);
  f.timers.tick();
  expect(
    f.sink
      .events()
      .filter((event) => event.kind === 'scroll.block_coverage')
      .map((event) => event.payload),
  ).toEqual([{ blocks: [{ blockId: 'actual', intervalsMs: [[15000, 16000]], peakFraction: 1 }] }]);
  // Only AFTER the actual periodic flush do repeated starts/current notifications test idempotence.
  f.recorder.start();
  f.recorder.start();
  policy.current(true);
  expect(f.timers.running()).toBe(1);
  const before = f.sink.events().length;
  policy.current(false);
  expect(f.timers.running()).toBe(0);
  f.recorder.suspend();
  policy.current(true);
  f.recorder.observer.onBlockVisibility({ blockId: 'parked', visibleFraction: 1, at: f.clock.now() });
  f.clock.advance(1000);
  f.timers.tick();
  f.recorder.flush();
  expect(f.sink.events()).toHaveLength(before);
  expect(f.timers.running()).toBe(0);
  policy.current(false);
  f.recorder.resume();
  policy.current(true);
  expect(f.timers.running()).toBe(1);
  f.recorder.end();
  expect(f.timers.running()).toBe(0);
});

it.each(['resume', 'suspend'] as const)(
  'Scroll %s observes actual dead scope before running/parked/ended intent guards (CI matrix)',
  (operation) => {
    for (const state of ['running', 'parked', 'ended'] as const) {
      let active = true;
      const f = build({ active: () => active });
      f.recorder.start();
      f.recorder.observer.onBlockVisibility({ blockId: 'before', visibleFraction: 1, at: f.clock.now() });
      f.clock.advance(500);
      if (state === 'parked') f.recorder.suspend();
      if (state === 'ended') f.recorder.end();
      const before = [...f.sink.events()];
      active = false;
      f.recorder[operation]();
      expect(f.timers.running()).toBe(0);
      active = true; // Faulty adapter resurrection must not undo an already observed scope death.
      f.recorder.start();
      f.recorder.resume();
      f.recorder.observer.onActivity({ active: true, at: f.clock.now() });
      f.recorder.observer.onBlockVisibility({ blockId: 'late', visibleFraction: 1, at: f.clock.now() });
      f.recorder.observer.onBlockInteraction({ blockId: 'late', kind: 'expanded', at: f.clock.now() });
      f.clock.advance(1000);
      f.timers.tick();
      f.recorder.flush();
      f.recorder.end();
      expect(f.timers.running()).toBe(0);
      expect(f.sink.events()).toEqual(before);
    }
  },
);
