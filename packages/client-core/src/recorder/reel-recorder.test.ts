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
    exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1 },
    durationMs: 30_000,
    scope: {
      get active() {
        return active;
      },
    } as AccountScope,
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
    expect(events.map((event) => event.eventId)).toEqual(['2', '3']);
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
      exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1 },
      durationMs: 30000,
      scope: { active: true } as AccountScope,
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
      get active() {
        return active;
      },
    } as AccountScope;
    const outbox: ObservationOutbox = {
      enqueue: (batch) => {
        events.push(...batch);
      },
      drain: () => Promise.resolve(),
      status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
      dispose: () => undefined,
    };
    const recorder = createReelRecorder({
      exposure: { exposureId: 'e', assetId: 'a', assetRevision: 1 },
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
