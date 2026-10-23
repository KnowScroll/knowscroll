/**
 * Parameters of Scroll evidence qualification as one versioned policy record (blueprint §8: "keep
 * equations in pure functions and parameters in versioned policy records"). The values are
 * **proposed v0 policy, bench values for testing**, not empirical claims: the blueprint calls them
 * placeholders, and very short or atypical interactive articles need separate calibration. A change
 * to any value is a new `version`, which the evidence revision records, so every stored result says
 * which policy produced it and a new policy can be applied to the same input as a new revision.
 */
export interface ScrollQualificationPolicy {
  readonly version: string;
  /** Weight of weighted block coverage in q (blueprint §8: 0.5). */
  readonly coverageWeight: number;
  /** Weight of active dwell against the reading estimate in q (blueprint §8: 0.5). */
  readonly dwellWeight: number;
  /** `q` a qualified reading needs (blueprint §8: 0.6). */
  readonly minQ: number;
  /** Weighted coverage a qualified Scroll reading needs (blueprint §8: 0.5). */
  readonly minCoverage: number;
  /**
   * Unique visible time while the article was active before a block counts as seen: passing a block
   * in a flick does not (blueprint §8: scrolling past a heading is not understanding).
   */
  readonly minBlockVisibleMs: number;
  /** The least peak visible fraction a block must have reached to count. */
  readonly minPeakFraction: number;
  /** The recorder build that reports enough to qualify a reading (lower builds leave it unknown). */
  readonly minInstrumentationVersion: number;
}

export const SCROLL_QUALIFICATION_POLICY_V0: ScrollQualificationPolicy = Object.freeze({
  version: 'scroll-qualification.v0',
  coverageWeight: 0.5,
  dwellWeight: 0.5,
  minQ: 0.6,
  minCoverage: 0.5,
  minBlockVisibleMs: 500,
  minPeakFraction: 0.5,
  minInstrumentationVersion: 1,
});

/**
 * Bounds the intake applies to client claims (`observation-bounds.v1`): a client's time is never
 * authority (blueprint §6), so claims are bounded against the server's own clock and the
 * exposure's activation, not rejected wholesale.
 */
export interface ObservationBounds {
  readonly version: string;
  /** Slack on the elapsed wall time since activation a claimed offset may reach (clock and network jitter). */
  readonly elapsedToleranceMs: number;
  /** `occurredAt` further than this into the future is clamped to the receive time. */
  readonly maxFutureSkewMs: number;
  /** An event older than this at receipt is refused: a recorder buffer cannot be replayed forever. */
  readonly maxEventAgeMs: number;
}

export const OBSERVATION_BOUNDS_V1: ObservationBounds = Object.freeze({
  version: 'observation-bounds.v1',
  elapsedToleranceMs: 2_000,
  maxFutureSkewMs: 300_000,
  maxEventAgeMs: 7 * 24 * 60 * 60 * 1000,
});

/** Same thresholds, explicitly new session-domain summary semantics. */
export const SCROLL_RECORDING_QUALIFICATION_POLICY: ScrollQualificationPolicy = Object.freeze({
  ...SCROLL_QUALIFICATION_POLICY_V0,
  version: 'scroll-qualification.recording.v1',
});
