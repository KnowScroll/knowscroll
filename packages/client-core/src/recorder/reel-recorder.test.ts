import { describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { createReelRecorder } from './reel-recorder';
import type { AccountScope } from '../account-scope';
import type { ObservationOutbox } from './outbox';

function retainedReel() {
  let now = 5_000;
  let active = true;
  let id = 0;
  const events: InteractionEvent[] = [];
  const outbox: ObservationOutbox = {
    enqueue: (batch) => void events.push(...batch),
    drain: () => Promise.resolve(),
    status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
    dispose: () => undefined,
  };
  const recorder = createReelRecorder({
    exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1, recordingGeneration: 1, recordingSessionId: '1' },
    durationMs: 30_000,
    scope: {
      recording: {
        getState: () => ({ collecting: true, policy: { on: true, generation: 1 } }),
        subscribe: () => () => undefined,
      },
      get active() {
        return active;
      },
    } as unknown as AccountScope,
    outbox,
    newId: () => String(++id),
    clock: { monotonicMs: () => now, wallIso: () => '2026-10-20T00:00:00.000Z' },
  });
  return {
    recorder,
    events,
    advance: (ms: number) => (now += ms),
    setActive: (value: boolean) => (active = value),
    tick: (positionMs: number, state: { playing?: boolean; visible?: boolean; buffering?: boolean } = {}, at = now) =>
      recorder.sample({ positionMs, monotonicMs: at, playing: true, visible: true, buffering: false, ...state }),
  };
}

describe('continuous visible Reel recording', () => {
  it('retains the timeline, session and sequence across a long detour without inventing playback', () => {
    const { recorder, events, advance, tick } = retainedReel();
    tick(0);
    advance(500);
    tick(500);
    recorder.suspend();
    const first = [...events];
    recorder.suspend();
    for (let i = 0; i < 100; i += 1) {
      advance(1_000);
      tick(500 + i * 250);
      recorder.flush();
      recorder.discontinuity();
    }
    expect(events).toEqual(first);
    recorder.resume();
    recorder.resume();
    tick(500, {}, 5_500); // A queued pre-return sample cannot establish the resumed baseline.
    advance(250);
    tick(500, { playing: false }); // Restored paused at the actual playhead.
    advance(250);
    tick(500);
    recorder.flush();
    expect(events).toEqual(first); // A single real playing sample is only a baseline.
    advance(250);
    tick(750);
    recorder.end();
    expect(events.map((event) => event.deviceSequence)).toEqual([1, 2]);
    expect(events[0]).toEqual(first[0]);
    expect(events.map((event) => event.eventId)).toEqual(['1', '2']);
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set([recorder.sessionId]));
    expect(events.flatMap((event) => (event.kind === 'reel.playback' ? event.payload.samples : []))).toEqual([
      { activeMs: [0, 500], mediaMs: [0, 500] },
      { activeMs: [101_000, 101_250], mediaMs: [500, 750] },
    ]);
  });

  it('keeps seek, buffering and background discontinuities excluded after return', () => {
    const { recorder, events, advance, tick } = retainedReel();
    tick(0);
    recorder.suspend();
    advance(60_000);
    recorder.resume();
    tick(0, { visible: false });
    advance(250);
    tick(0, { buffering: true });
    advance(250);
    tick(0);
    advance(250);
    tick(10_000); // Seek jump, not consumed media.
    recorder.discontinuity();
    advance(250);
    tick(10_000);
    advance(250);
    tick(10_250);
    recorder.end();
    expect(events.flatMap((event) => (event.kind === 'reel.playback' ? event.payload.samples : []))).toEqual([
      { activeMs: [61_000, 61_250], mediaMs: [10_000, 10_250] },
    ]);
  });

  it.each(['sample', 'flush', 'suspend', 'resume', 'discontinuity', 'end'] as const)(
    'terminally fences an ended scope on %s, discarding unflushed playback',
    (next) => {
      const { recorder, events, advance, tick, setActive } = retainedReel();
      tick(0);
      advance(250);
      tick(250);
      setActive(false);
      if (next === 'sample') tick(500);
      else recorder[next]();
      setActive(true);
      recorder.resume();
      tick(500);
      advance(250);
      tick(750);
      recorder.flush();
      recorder.end();
      expect(events).toEqual([]);
    },
  );

  it('end is final even when already suspended and late callbacks keep arriving', () => {
    const { recorder, events, advance, tick } = retainedReel();
    tick(0);
    advance(250);
    tick(250);
    recorder.suspend();
    recorder.end();
    const final = [...events];
    recorder.resume();
    for (let i = 0; i < 10; i += 1) {
      advance(250);
      tick(500 + i * 250);
      recorder.discontinuity();
      recorder.flush();
      recorder.end();
    }
    expect(events).toEqual(final);
  });

  it('emits nothing for open/load/hidden/never-playing discontinuities and teardown', () => {
    const events: InteractionEvent[] = [];
    const outbox: ObservationOutbox = {
      enqueue: (batch) => {
        events.push(...batch);
      },
      drain: () => Promise.resolve(),
      status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
      dispose: () => undefined,
    };
    const recorder = createReelRecorder({
      exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1, recordingGeneration: 1, recordingSessionId: '1' },
      durationMs: 30000,
      scope: {
        active: true,
        recording: {
          getState: () => ({ collecting: true, policy: { on: true, generation: 1 } }),
          subscribe: () => () => undefined,
        },
      } as unknown as AccountScope,
      outbox,
      newId: () => 'fixture',
      clock: { monotonicMs: () => 0, wallIso: () => '2026-10-20T00:00:00.000Z' },
    });
    recorder.discontinuity();
    recorder.flush();
    recorder.sample({ monotonicMs: 0, positionMs: 0, playing: false, visible: true, buffering: false });
    recorder.sample({ monotonicMs: 250, positionMs: 0, playing: false, visible: false, buffering: true });
    recorder.discontinuity();
    recorder.end();
    expect(events).toEqual([]);
  });

  it('excludes seek jumps, loop jumps, buffering, background and fenced scopes', () => {
    const events: InteractionEvent[] = [];
    let active = true;
    let id = 0;
    const scope = {
      recording: {
        getState: () => ({ collecting: true, policy: { on: true, generation: 1 } }),
        subscribe: () => () => undefined,
      },
      get active() {
        return active;
      },
    } as unknown as AccountScope;
    const outbox: ObservationOutbox = {
      enqueue: (batch) => {
        events.push(...batch);
      },
      drain: () => Promise.resolve(),
      status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
      dispose: () => undefined,
    };
    const recorder = createReelRecorder({
      exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1, recordingGeneration: 1, recordingSessionId: '1' },
      durationMs: 30000,
      scope,
      outbox,
      newId: () => String(++id),
      clock: { monotonicMs: () => 0, wallIso: () => '2026-10-20T00:00:00.000Z' },
    });
    const tick = (time: number, position: number, visible = true, buffering = false) =>
      recorder.sample({ monotonicMs: time, positionMs: position, playing: true, visible, buffering });
    tick(0, 0);
    tick(250, 250);
    tick(500, 500);
    tick(750, 10000);
    recorder.discontinuity(); // Seek contributes nothing.
    tick(1000, 10000);
    tick(1250, 10250);
    tick(1500, 10500, true, true); // Stall.
    tick(1750, 10500);
    tick(2000, 10750, false); // Background.
    tick(2250, 0);
    tick(2500, 250);
    recorder.end();
    const samples = events.flatMap((event) => (event.kind === 'reel.playback' ? event.payload.samples : []));
    expect(samples.map((sample) => sample.mediaMs)).toEqual([
      [0, 250],
      [250, 500],
      [10000, 10250],
      [0, 250],
    ]);
    const count = events.length;
    active = false;
    recorder.flush();
    expect(events).toHaveLength(count);
  });
});

it('unknown and paused intervals never bridge, and Resume cannot revive the old eligible activation (CI fixture)', () => {
  let now = 0;
  let policy = { collecting: true, policy: { on: true, generation: 3 } };
  const listeners = new Set<() => void>();
  const events: InteractionEvent[] = [];
  let id = 0;
  const options = {
    exposure: {
      exposureId: 'e',
      assetId: 'a',
      assetRevision: 1,
      recordingGeneration: 3,
      recordingSessionId: 'activation3',
    },
    durationMs: 20000,
    newId: () => String(++id),
    clock: { monotonicMs: () => now, wallIso: () => '2026-10-23T00:00:00.000Z' },
    scope: {
      active: true,
      recording: {
        getState: () => policy,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    } as unknown as AccountScope,
    outbox: {
      enqueue: (batch: readonly InteractionEvent[]) => {
        events.push(...batch);
      },
      drain: () => Promise.resolve(),
      status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
      dispose: () => undefined,
    },
  };
  const old = createReelRecorder(options);
  const tick = (recorder: ReturnType<typeof createReelRecorder>, positionMs: number) =>
    recorder.sample({ positionMs, monotonicMs: now, playing: true, visible: true, buffering: false });
  tick(old, 0);
  now = 500;
  tick(old, 500);
  policy = { ...policy, collecting: false };
  listeners.forEach((listener) => listener());
  now = 5000;
  tick(old, 5000);
  policy = { ...policy, collecting: true };
  listeners.forEach((listener) => listener());
  tick(old, 5000);
  now = 5500;
  tick(old, 5500);
  old.flush();
  expect(events).toHaveLength(1);
  expect(events[0]?.sessionId).toBe('activation3');
  expect(events[0]?.payload).toEqual({ samples: [{ activeMs: [5000, 5500], mediaMs: [5000, 5500] }] });
  policy = { collecting: false, policy: { on: false, generation: 4 } };
  listeners.forEach((listener) => listener());
  policy = { collecting: true, policy: { on: true, generation: 5 } };
  listeners.forEach((listener) => listener());
  now = 6000;
  tick(old, 6000);
  now = 6500;
  tick(old, 6500);
  old.end();
  expect(events).toHaveLength(1);
  // A fresh recorder with an old offer/activation generation is also ineligible.
  const relabel = createReelRecorder({
    ...options,
    exposure: { ...options.exposure, recordingSessionId: 'old-activation' },
  });
  tick(relabel, 0);
  now += 500;
  tick(relabel, 500);
  relabel.end();
  expect(events).toHaveLength(1);
  const fresh = createReelRecorder({
    ...options,
    exposure: { ...options.exposure, recordingGeneration: 5, recordingSessionId: 'new-eligible-activation5' },
  });
  tick(fresh, 0);
  now += 500;
  tick(fresh, 500);
  fresh.end();
  expect(events.at(-1)?.sessionId).toBe('new-eligible-activation5');
  expect(events).toHaveLength(2);
});

it('Reel end and suspension remain locally fenced when checking ends with the same-generation current policy (CI fixture)', () => {
  let now = 0;
  let collecting = true;
  const listeners = new Set<() => void>();
  const events: InteractionEvent[] = [];
  let id = 0;
  const policy = {
    getState: () => ({ collecting, policy: { on: true, generation: 1 } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const build = () =>
    createReelRecorder({
      exposure: {
        exposureId: 'e',
        assetId: 'a',
        assetRevision: 1,
        recordingGeneration: 1,
        recordingSessionId: 'actual-activation',
      },
      durationMs: 30000,
      scope: { active: true, recording: policy } as unknown as AccountScope,
      newId: () => String(++id),
      clock: { monotonicMs: () => now, wallIso: () => '2026-10-23T00:00:00.000Z' },
      outbox: {
        enqueue: (batch) => {
          events.push(...batch);
        },
        drain: () => Promise.resolve(),
        status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
        dispose: () => undefined,
      },
    });
  const current = (value: boolean) => {
    collecting = value;
    listeners.forEach((listener) => listener());
  };
  const tick = (recorder: ReturnType<typeof createReelRecorder>, position: number) =>
    recorder.sample({ monotonicMs: now, positionMs: position, playing: true, visible: true, buffering: false });
  const ended = build();
  tick(ended, 0);
  now += 500;
  tick(ended, 500);
  current(false);
  ended.end();
  current(true);
  ended.resume();
  tick(ended, 500);
  now += 500;
  tick(ended, 1000);
  ended.discontinuity();
  ended.flush();
  ended.end();
  expect(events).toEqual([]);
  const parked = build();
  tick(parked, 0);
  now += 500;
  tick(parked, 500);
  current(false);
  parked.suspend();
  current(true);
  tick(parked, 500);
  now += 500;
  tick(parked, 1000);
  parked.flush();
  expect(events).toEqual([]);
  current(false);
  parked.resume();
  current(true);
  tick(parked, 1000);
  now += 500;
  tick(parked, 1500);
  parked.end();
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toEqual({ samples: [{ activeMs: [1000, 1500], mediaMs: [1000, 1500] }] });
});
