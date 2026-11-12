import { z } from 'zod';
import { ACTIVITY_POLICY } from './activity.js';

/**
 * What a roll-up row counted of one topic, and what a roll-up row is, as pure arithmetic (migration 0117, D-420).
 *
 * A system or person roll-up is the sum of the topic rows beneath it. It is changed by the difference between what a topic was
 * counted as and what it is now, never by what the writer believes the topic was: each topic row carries `rollup_counted`, the
 * state it was last counted as, so a roll-up never subtracts what it did not add. A topic a writer changed without counting it
 * (an older binary in the deploy window) is corrected by the next write of the new binary, which subtracts the stale counted
 * state and adds the current one. A roll-up that would go negative has lost something and is rebuilt from the topic rows.
 */
export const CHANNEL_KEYS = ['q', 'L', 'B', 'S', 'H', 'R'] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];
export type ChannelValues = Readonly<Record<ChannelKey, number>>;

const Channels = z.strictObject({
  q: z.number().nonnegative(),
  L: z.number().nonnegative(),
  B: z.number().nonnegative(),
  S: z.number().nonnegative(),
  H: z.number().nonnegative(),
  R: z.number().nonnegative(),
});
const Count = z.number().int().nonnegative();

/** One topic row as a roll-up counted it: its activity and channels at a time, and its measured and qualified encounters. */
export const CountedStateSchema = z.strictObject({
  /** Activity at `t`. */
  a: z.number().nonnegative(),
  /** The time `a` and `ch` are as of, in epoch milliseconds. */
  t: z.number(),
  ch: Channels,
  rm: Count,
  rq: Count,
  sm: Count,
  sq: Count,
});
export type CountedState = z.infer<typeof CountedStateSchema>;

/** The stored `rollup_counted`, or `undefined` when there is none or it is not a counted state (never trusted as one). */
export function parseCounted(value: unknown): CountedState | undefined {
  const parsed = CountedStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A roll-up row's value: activity and channels as of `t`, and counts. */
export interface RollupValue {
  readonly a: number;
  readonly t: number;
  readonly ch: ChannelValues;
  readonly rm: number;
  readonly rq: number;
  readonly sm: number;
  readonly sq: number;
}

export const EMPTY_CHANNELS: ChannelValues = { q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 };
/** Float noise below this is not a loss: a sum of exactly cancelling terms may land a hair under zero. */
const TOLERANCE = 1e-9;

const decayFactor = (fromMs: number, toMs: number): number =>
  Math.pow(2, -Math.max(0, toMs - fromMs) / ACTIVITY_POLICY.halfLifeMs);

const scaled = (channels: ChannelValues, factor: number): Record<(typeof CHANNEL_KEYS)[number], number> => ({
  q: channels.q * factor,
  L: channels.L * factor,
  B: channels.B * factor,
  S: channels.S * factor,
  H: channels.H * factor,
  R: channels.R * factor,
});

/**
 * The roll-up after topics change from what they were counted as to what they are now, as of the later of `atMs` and the roll-up's
 * own time. `consistent` is false when the result shows the roll-up did not hold what it was asked to take away (a negative
 * activity, channel or count beyond float noise, or a topic counted before while the roll-up row is absent): the caller rebuilds the
 * roll-up from the topic rows instead of storing this. The returned value is clamped (never negative, qualified never above
 * measured) so it is always storable.
 */
export function applyCountedChanges(
  rollup: RollupValue | undefined,
  changes: readonly { readonly previous: CountedState | undefined; readonly next: CountedState }[],
  atMs: number,
): { readonly value: RollupValue; readonly consistent: boolean } {
  const t = Math.max(atMs, rollup?.t ?? atMs);
  const base = rollup ?? { a: 0, t, ch: EMPTY_CHANNELS, rm: 0, rq: 0, sm: 0, sq: 0 };
  const factor = decayFactor(base.t, t);
  let a = base.a * factor;
  const ch = scaled(base.ch, factor);
  let rm = base.rm;
  let rq = base.rq;
  let sm = base.sm;
  let sq = base.sq;
  let consistent = true;
  for (const { previous, next } of changes) {
    const add = decayFactor(next.t, t);
    a += next.a * add;
    for (const key of CHANNEL_KEYS) ch[key] += next.ch[key] * add;
    rm += next.rm;
    rq += next.rq;
    sm += next.sm;
    sq += next.sq;
    if (previous === undefined) continue;
    const remove = decayFactor(previous.t, t);
    a -= previous.a * remove;
    for (const key of CHANNEL_KEYS) ch[key] -= previous.ch[key] * remove;
    rm -= previous.rm;
    rq -= previous.rq;
    sm -= previous.sm;
    sq -= previous.sq;
    if (rollup === undefined && previous.a > TOLERANCE) consistent = false;
  }
  if (a < -TOLERANCE || CHANNEL_KEYS.some((key) => ch[key] < -TOLERANCE) || [rm, rq, sm, sq].some((n) => n < 0))
    consistent = false;
  const clampedCh = scaled(ch, 1);
  for (const key of CHANNEL_KEYS) clampedCh[key] = Math.max(0, clampedCh[key]);
  const reelMeasured = Math.max(0, rm);
  const scrollMeasured = Math.max(0, sm);
  return {
    consistent,
    value: {
      a: Math.max(0, a),
      t,
      ch: clampedCh,
      rm: reelMeasured,
      rq: Math.min(reelMeasured, Math.max(0, rq)),
      sm: scrollMeasured,
      sq: Math.min(scrollMeasured, Math.max(0, sq)),
    },
  };
}

/**
 * A running sum of topic rows for a rebuild: rows arrive in any order, each with its own time, and the sum is kept as of the
 * latest time seen (older rows are decayed forward, a newer row advances the sum), so a person's rows can be streamed in pages
 * without holding them all.
 */
export class RollupAccumulator {
  private value: RollupValue | undefined;

  add(row: CountedState): void {
    this.value = applyCountedChanges(this.value, [{ previous: undefined, next: row }], row.t).value;
  }

  get result(): RollupValue | undefined {
    return this.value;
  }
}
