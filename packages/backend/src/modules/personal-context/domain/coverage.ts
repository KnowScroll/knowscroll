import { z } from 'zod';
const Ref = z.string().min(1).max(160);
export const TrustedCoverageQuerySchema = z
  .strictObject({
    probes: z
      .array(z.strictObject({ topicId: Ref, facetId: Ref, explanationUnitId: Ref }))
      .min(1)
      .max(100),
  })
  .superRefine((q, c) => {
    if (new Set(q.probes.map((p) => JSON.stringify(p))).size !== q.probes.length)
      c.addIssue({ code: 'custom', message: 'Duplicate trusted coverage probe' });
  });
export type TrustedCoverageQuery = z.infer<typeof TrustedCoverageQuerySchema>;
export interface CoverageSupport {
  readonly topicId: string;
  readonly facetId: string;
  readonly meaningSha256: string;
  readonly explanationUnitId: string;
  readonly truthSha256: string;
}
interface CoverageObservationSupport {
  readonly availability: string;
  readonly explanationUnitId: string;
  readonly mapping: { readonly framingSha256: string } | null;
  readonly bindings: readonly { readonly topicId: string; readonly facetId: string; readonly meaningSha256: string }[];
}
export function coverageSupports(c: CoverageObservationSupport): readonly CoverageSupport[] {
  return c.availability === 'available' && c.mapping
    ? c.bindings.map((b) => ({
        topicId: b.topicId,
        facetId: b.facetId,
        meaningSha256: b.meaningSha256,
        explanationUnitId: c.explanationUnitId,
        truthSha256: c.mapping!.framingSha256,
      }))
    : [];
}
export const coverageSupportKey = (s: CoverageSupport) =>
  JSON.stringify([s.topicId, s.facetId, s.meaningSha256, s.explanationUnitId, s.truthSha256]);
export const RecordingWitnessPointerSchema = z.strictObject({
  topicId: Ref,
  facetId: Ref,
  meaningSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  explanationUnitId: Ref,
  truthSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceKind: z.enum(['legacy', 'segment']),
  recordingGeneration: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .refine((g) => g % 2 === 1),
  activityId: z.uuid(),
  qualificationId: z.uuid(),
  certificateSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type RecordingWitnessPointer = z.infer<typeof RecordingWitnessPointerSchema>;
/** One binding slot, with its immutable per-generation base and replaceable current proof. */
export const RecordingCoverageSlotsSchema = z
  .array(
    z.strictObject({
      base: RecordingWitnessPointerSchema.nullable(),
      current: RecordingWitnessPointerSchema.nullable(),
    }),
  )
  .max(16)
  .superRefine((slots, c) => {
    const keys = slots.map((s) => JSON.stringify([(s.current ?? s.base)?.topicId, (s.current ?? s.base)?.facetId]));
    if (
      slots.some((s) => !s.base && !s.current) ||
      new Set(keys).size !== keys.length ||
      slots.some(
        (s) => s.base && s.current && (s.base.topicId !== s.current.topicId || s.base.facetId !== s.current.facetId),
      )
    )
      c.addIssue({ code: 'custom', message: 'Inconsistent effective binding slots' });
  });
export const selectedWitnesses = (slots: z.infer<typeof RecordingCoverageSlotsSchema>) =>
  slots.map((s) => (s.current ?? s.base)!);
export type TrustedCoverageRead<Certificate = unknown> = {
  readonly version: 'trusted-coverage-read.v1';
  readonly completeness: 'not_asserted';
  readonly supportedFormats: readonly ['scroll'];
} & (
  | {
      readonly availability: 'unavailable';
      readonly reason: 'limit' | 'authority_changed' | 'not_observed';
      readonly supports: readonly [];
      readonly witnesses: readonly [];
      readonly certificates: readonly [];
    }
  | {
      readonly availability: 'available';
      readonly reason: 'current';
      /** Deduplicated semantic keys; witnesses are source provenance, never variety counts. */
      readonly supports: readonly (CoverageSupport & { readonly witnessExposureIds: readonly string[] })[];
      readonly witnesses: readonly (CoverageSupport & {
        readonly exposureId: string;
        readonly witnessKey: string;
        readonly sourceKind: 'legacy' | 'segment';
        readonly recordingGeneration: number;
        readonly activityId: string;
        readonly qualificationId: string;
        readonly certificateSha256: string;
      })[];
      readonly certificates: readonly {
        readonly witnessKey: string;
        readonly sourceKind: 'legacy' | 'segment';
        readonly recordingGeneration: number;
        readonly activityId: string;
        readonly qualificationId: string;
        readonly certificateSha256: string;
        readonly certificate: Certificate;
      }[];
    }
);
