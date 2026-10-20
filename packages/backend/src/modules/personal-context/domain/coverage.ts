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
export type TrustedCoverageRead<Certificate = unknown> = {
  readonly version: 'trusted-coverage-read.v1';
  readonly completeness: 'not_asserted';
  readonly supportedFormats: readonly ['scroll'];
} & (
  | {
      readonly availability: 'unavailable';
      readonly reason: 'limit' | 'authority_changed' | 'not_observed';
      readonly witnesses: readonly [];
      readonly certificates: readonly [];
    }
  | {
      readonly availability: 'available';
      readonly reason: 'current';
      readonly witnesses: readonly (CoverageSupport & {
        readonly exposureId: string;
        readonly certificateSha256: string;
      })[];
      readonly certificates: readonly { readonly certificateSha256: string; readonly certificate: Certificate }[];
    }
);
