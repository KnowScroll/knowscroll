import { z } from 'zod';
import { activity, type ActivityChannels } from './activity.js';
const Ref = z.strictObject({
  id: z.uuid(),
  recordingGeneration: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .refine((x) => x % 2 === 1),
  revision: z.number().int().positive().max(2147483647),
});
const Channels = z.strictObject({
  q: z.number().min(0).max(1).nullable(),
  L: z.boolean(),
  B: z.boolean(),
  S: z.literal(0),
  H: z.boolean(),
  R: z.boolean(),
});
const Source = z.strictObject({
  channels: Channels,
  measured: z.boolean(),
  qualified: z.boolean(),
  qualification: Ref.nullable(),
});
export const RecordingCreditSchema = z
  .strictObject({
    version: z.literal('recording-credit.v1'),
    channels: Channels,
    measured: z.boolean(),
    qualified: z.boolean(),
    qSource: Ref.nullable(),
    qualifiedSource: Ref.nullable(),
    // Fixed clock-domain slots, never an array or a recursive generation history.
    legacy: Source.nullable(),
    segment: Source.nullable(),
  })
  .refine(
    (x) =>
      (!x.qualified || x.measured) &&
      (!x.measured || x.channels.q !== null) &&
      (!x.qSource || x.channels.q !== null) &&
      (!x.qualifiedSource || x.qualified) &&
      [x.legacy, x.segment].every(
        (s) =>
          !s || ((!s.qualified || s.measured) && (!s.measured || (s.channels.q !== null && s.qualification !== null))),
      ),
    { message: 'Inconsistent committed recording credit' },
  );
export type RecordingCredit = z.infer<typeof RecordingCreditSchema>;
export type RecordingCreditSource = z.infer<typeof Source>;
export const emptyRecordingCredit = (): RecordingCredit => ({
  version: 'recording-credit.v1',
  channels: { q: null, L: false, B: false, S: 0, H: false, R: false },
  measured: false,
  qualified: false,
  qSource: null,
  qualifiedSource: null,
  legacy: null,
  segment: null,
});
/** Reducer over already COMMITTED own baseline and the current generation's two independent
 * clock-domain sources. No raw observations, necessary flags or PC baseline enter this function. */
export function recordingCredit(input: {
  readonly base: RecordingCredit;
  readonly previous: RecordingCredit;
  readonly source: RecordingCreditSource;
  readonly domain: 'legacy' | 'session';
  readonly likedOverride: boolean | null;
  readonly savedOverride: boolean | null;
}): RecordingCredit {
  const base = RecordingCreditSchema.parse(input.base),
    previous = RecordingCreditSchema.parse(input.previous);
  const source = Source.parse(input.source);
  if (
    (source.qualified && !source.measured) ||
    (source.measured && source.channels.q === null) ||
    (source.measured && !source.qualification)
  )
    throw new Error('RECORDING_CREDIT_SOURCE_INVALID');
  const legacy = input.domain === 'legacy' ? source : previous.legacy;
  const segment = input.domain === 'session' ? source : previous.segment;
  const values = [legacy, segment].filter((x): x is RecordingCreditSource => x !== null);
  let q = base.channels.q,
    qSource = base.qSource,
    qualifiedSource = base.qualifiedSource;
  for (const value of values) {
    if (value.channels.q !== null && (q === null || value.channels.q > q)) {
      q = value.channels.q;
      qSource = value.qualification;
    }
    if (value.qualified) qualifiedSource = value.qualification;
  }
  const channels: ActivityChannels = {
    q,
    L: input.likedOverride ?? base.channels.L,
    B: input.savedOverride ?? base.channels.B,
    S: 0,
    H: base.channels.H || values.some((v) => v.channels.H),
    R: base.channels.R || values.some((v) => v.channels.R),
  };
  activity(channels); // Validate the same unchanged routing arithmetic/cap.
  return RecordingCreditSchema.parse({
    version: 'recording-credit.v1',
    channels,
    measured: base.measured || values.some((v) => v.measured),
    qualified: base.qualified || values.some((v) => v.qualified),
    qSource,
    qualifiedSource,
    legacy,
    segment,
  });
}
