import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { InteractionEvent } from '@knowscroll/contracts';
import type { OpenedFixture } from './observations.js';

/**
 * The app's own recorder, loaded from the client-core source. It is imported at run time and described here by the part of
 * its interface the trace uses: client-core is a bundler-resolved package, which this project's compiler cannot follow
 * (it reads the source as CommonJS), and the tests must run the real `createReelRecorder`, not a copy of it.
 */
interface ReelRecorderHandle {
  sample(next: {
    readonly positionMs: number;
    readonly monotonicMs: number;
    readonly playing: boolean;
    readonly visible: boolean;
    readonly buffering: boolean;
  }): void;
  discontinuity(): void;
  end(): void;
}
interface RecorderModule {
  readonly createReelRecorder: (options: {
    readonly exposure: OpenedFixture & { readonly recordingGeneration: number; readonly recordingSessionId: string };
    readonly durationMs: number;
    readonly scope: unknown;
    readonly outbox: {
      enqueue(batch: readonly unknown[]): void;
      drain(): Promise<void>;
      status(): unknown;
      dispose(): void;
    };
    readonly newId: () => string;
    readonly clock: { readonly monotonicMs: () => number; readonly wallIso: () => string };
  }) => ReelRecorderHandle;
}
const recorderSource = fileURLToPath(
  new URL('../../../packages/client-core/src/recorder/reel-recorder.ts', import.meta.url),
);

/**
 * What a viewer's Reel player and the app's own recorder report, for tests (#674, slice 5.1). The events are made by the
 * real `createReelRecorder` from a trace of jittered `timeupdate` ticks, so they have the shape the intake receives from a
 * client and none of the cleanliness of hand-written samples: ticks about 250 ms apart, a player position that is a few
 * milliseconds off the true one, playback that starts a few hundred milliseconds in and ends before the media does, and
 * seeks between continuous plays. Nothing here is product data.
 */
export interface PlaybackRandom {
  /** A number in `[min, max)`. */
  between(min: number, max: number): number;
}

/** A small seeded source, so a trace that exposes a defect can be replayed. */
export function playbackRandom(seed: number): PlaybackRandom {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return { between: (min, max) => min + next() * (max - min) };
}

export interface PlaybackOptions {
  readonly durationMs: number;
  /**
   * Continuous plays, `[from, to]` in media milliseconds, in the order they happen, with a seek between one and the next.
   * A play from 0 starts a little after it (the first tick is only a baseline); a play to the duration ends a little
   * before it (the last tick comes before the media ends).
   */
  readonly spans: readonly (readonly [number, number])[];
  readonly random: PlaybackRandom;
  readonly sessionId?: string;
  /** How far into the media playback starts at the most, and how short of its end the last report falls at the most. */
  readonly maxFirstOffsetMs?: number;
  readonly maxLastOffsetMs?: number;
}

export interface Playback {
  readonly events: InteractionEvent[];
  /** Wall time the viewer spent, so the intake's bound on claims against activation holds. */
  readonly elapsedMs: number;
}

export async function recordPlayback(exposure: OpenedFixture, options: PlaybackOptions): Promise<Playback> {
  const { createReelRecorder } = (await import(/* @vite-ignore */ recorderSource)) as RecorderModule;
  const { random, durationMs } = options;
  let now = 50_000;
  const startedAt = now;
  const events: InteractionEvent[] = [];
  const recorder = createReelRecorder({
    exposure: {
      ...exposure,
      recordingGeneration: 1,
      recordingSessionId: options.sessionId ?? randomUUID(),
    },
    durationMs,
    scope: {
      recording: {
        getState: () => ({ collecting: true, policy: { on: true, generation: 1 } }),
        subscribe: () => () => undefined,
      },
      active: true,
    },
    outbox: {
      enqueue: (batch) => void events.push(...(batch as readonly InteractionEvent[])),
      drain: () => Promise.resolve(),
      status: () => ({ pendingBatches: 0, pendingEvents: 0, dropped: 0, stopped: false }),
      dispose: () => undefined,
    },
    newId: randomUUID,
    clock: { monotonicMs: () => now, wallIso: () => new Date().toISOString() },
  });
  /** The player's reported position: the true one and a few milliseconds of error, either way. */
  const tick = (trueMs: number) => {
    const error = random.between(0.3, 15) * (random.between(0, 1) < 0.5 ? -1 : 1);
    recorder.sample({
      positionMs: Math.max(0, trueMs + error),
      monotonicMs: now,
      playing: true,
      visible: true,
      buffering: false,
    });
  };
  options.spans.forEach(([from, to], index) => {
    if (index > 0) {
      recorder.discontinuity();
      now += random.between(300, 1500);
    }
    let media = from === 0 ? random.between(0, options.maxFirstOffsetMs ?? 300) : from;
    const end = to >= durationMs ? durationMs - random.between(0, options.maxLastOffsetMs ?? 400) : to;
    tick(media);
    while (media < end) {
      const step = Math.min(random.between(235, 265), end - media);
      now += step;
      media += step;
      tick(media);
    }
  });
  recorder.end();
  return { events, elapsedMs: now - startedAt };
}
