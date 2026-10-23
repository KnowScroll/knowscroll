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
export interface ReelRecorderOptions {
  readonly exposure: RecordedExposure;
  readonly durationMs: number;
  readonly scope: Pick<AccountScope, 'api' | 'storage' | 'active'> &
    Partial<Pick<AccountScope, 'account' | 'recording' | 'onEnd'>>;
  readonly newId: () => string;
  readonly clock?: RecorderClock;
  readonly outbox?: ObservationOutbox;
}

export interface ReelRecorder {
  readonly sessionId: string;
  sample(next: PlaybackSample): void;
  discontinuity(): void;
  flush(): void;
  /** Flush actual playback and discard its baseline; parked callbacks are ignored. */
  suspend(): void;
  /** Admit fresh player samples on this same handle; the first only establishes a baseline. */
  resume(): void;
  /** Final disposal. Neither resume nor late player callbacks can restart this recorder. */
  end(): void;
}
/** Records only continuous 1× playback. A seek/loop, stale tick, stall or hidden sample resets the
 * baseline; it never bridges the gap. Union/qualification belongs to the server, not this recorder. */
export function createReelRecorder(options: ReelRecorderOptions): ReelRecorder {
  const outbox = options.outbox ?? scopeOutbox(options.scope);
  const clock = options.clock ?? { monotonicMs: () => performance.now(), wallIso: () => new Date().toISOString() };
  const started = clock.monotonicMs();
  const sessionId = options.exposure.recordingSessionId ?? options.newId();
  let eligible = false;
  let revoked = false;
  let previous: PlaybackSample | undefined;
  let sequence = 0;
  let ended = false;
  let suspended = false;
  let scopeEnded = false;
  let acceptAfter = Number.NEGATIVE_INFINITY;
  let samples: { activeMs: [number, number]; mediaMs: [number, number] }[] = [];
  const scopeActive = (): boolean => {
    if (!options.scope.active) scopeEnded = true;
    if (scopeEnded) {
      previous = undefined;
      samples = [];
    }
    const policy = options.scope.recording?.getState();
    if (policy?.policy && policy.policy.generation !== options.exposure.recordingGeneration) revoked = true;
    const allowed =
      !scopeEnded &&
      !revoked &&
      options.exposure.recordingGeneration !== undefined &&
      options.exposure.recordingSessionId !== undefined &&
      policy?.collecting === true &&
      policy.policy?.generation === options.exposure.recordingGeneration;
    if (allowed !== eligible) {
      eligible = allowed;
      previous = undefined;
      samples = [];
      acceptAfter = clock.monotonicMs();
    }
    return !scopeEnded && eligible;
  };
  const policyOff = options.scope.recording?.subscribe(() => {
    scopeActive();
  });
  const report = () => {
    if (!scopeActive() || samples.length === 0) return;
    sequence += 1;
    const event: InteractionEvent = {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      eventId: options.newId(),
      sessionId,
      deviceSequence: sequence,
      exposureId: options.exposure.exposureId,
      assetId: options.exposure.assetId,
      assetRevision: options.exposure.assetRevision,
      occurredAt: clock.wallIso(),
      kind: 'reel.playback',
      payload: { samples },
    };
    samples = [];
    outbox.enqueue([event], 1, options.exposure.recordingGeneration);
  };
  const accepts = (): boolean => scopeActive() && !ended && !suspended;
  const flush = () => {
    if (accepts()) report();
  };
  return {
    get sessionId() {
      return sessionId;
    },
    sample(next: PlaybackSample) {
      if (!accepts() || next.monotonicMs < acceptAfter) return;
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
      if (!accepts()) return;
      previous = undefined;
      flush();
    },
    flush,
    suspend() {
      const authorized = scopeActive();
      if (ended || suspended) return;
      previous = undefined;
      suspended = true;
      if (authorized) report();
      else samples = [];
    },
    resume() {
      scopeActive();
      if (ended || !suspended || scopeEnded) return;
      acceptAfter = clock.monotonicMs();
      suspended = false;
    },
    end() {
      const authorized = scopeActive();
      policyOff?.();
      if (ended) return;
      ended = true;
      previous = undefined;
      if (authorized) report();
      samples = [];
    },
  };
}
