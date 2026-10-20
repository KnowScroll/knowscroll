import { describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { createReelRecorder } from './reel-recorder';
import type { AccountScope } from '../account-scope';
import type { ObservationOutbox } from './outbox';
describe('continuous visible Reel recording', () => {
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
