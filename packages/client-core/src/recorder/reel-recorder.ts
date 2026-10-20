import { INTERACTION_SCHEMA_VERSION, type InteractionEvent } from '@knowscroll/contracts';
import { scopeOutbox, type RecordedExposure, type RecorderClock } from './scroll-recorder';
import type { AccountScope } from '../account-scope';
import type { ObservationOutbox } from './outbox';

export interface PlaybackSample {
  readonly positionMs: number;
  readonly monotonicMs: number;
  readonly playing: boolean;
  readonly visible: boolean;
  readonly buffering: boolean;
}
/** Records only continuous 1× playback. A seek/loop, stale tick, stall or hidden sample resets the
 * baseline; it never bridges the gap. Union/qualification belongs to the server, not this recorder. */
export function createReelRecorder(options: {
  exposure: RecordedExposure;
  durationMs: number;
  scope: Pick<AccountScope, 'api' | 'storage' | 'active'>;
  newId: () => string;
  clock?: RecorderClock;
  outbox?: ObservationOutbox;
}) {
  const outbox = options.outbox ?? scopeOutbox(options.scope);
  const clock = options.clock ?? { monotonicMs: () => performance.now(), wallIso: () => new Date().toISOString() };
  const started = clock.monotonicMs();
  const sessionId = options.newId();
  let previous: PlaybackSample | undefined;
  let sequence = 0;
  let ended = false;
  let samples: { activeMs: [number, number]; mediaMs: [number, number] }[] = [];
  const flush = () => {
    if (!options.scope.active || samples.length === 0) return;
    sequence += 1;
    const event: InteractionEvent = {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      eventId: options.newId(),
      sessionId,
      deviceSequence: sequence,
      ...options.exposure,
      occurredAt: clock.wallIso(),
      kind: 'reel.playback',
      payload: { samples },
    };
    samples = [];
    outbox.enqueue([event], 1);
  };
  return {
    sample(next: PlaybackSample) {
      if (ended || !options.scope.active) {
        previous = undefined;
        return;
      }
      const prior = previous;
      previous = next.playing && next.visible && !next.buffering ? next : undefined;
      if (!prior || !previous) {
        if (!previous) flush();
        return;
      }
      const elapsed = next.monotonicMs - prior.monotonicMs;
      const moved = next.positionMs - prior.positionMs;
      if (elapsed <= 0 || elapsed > 1500 || moved <= 0 || moved > elapsed + 100 || moved < elapsed * 0.7) return;
      const from = Math.max(0, Math.round(prior.positionMs));
      const to = Math.min(options.durationMs, Math.round(next.positionMs));
      const activeFrom = Math.max(0, Math.floor(prior.monotonicMs - started));
      const activeTo = Math.max(activeFrom + 1, Math.floor(next.monotonicMs - started));
      if (to > from) samples.push({ activeMs: [activeFrom, activeTo], mediaMs: [from, to] });
      if (samples.length >= 48) flush();
    },
    discontinuity() {
      previous = undefined;
      flush();
    },
    flush,
    end() {
      if (ended) return;
      previous = undefined;
      flush();
      ended = true;
    },
  };
}
