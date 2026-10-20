import { z } from 'zod';

export const CONTEXT_POLICY = 'personal-context.v0' as const;
/** Blueprint §8; explicit experimental policy, never a personal identity claim. */
export const interest = (activity: number): number => activity / (1 + activity);
export const formatFit = (qualified: number, measured: number): number => (1 + qualified) / (2 + measured);
const Ref = z.string().min(1).max(160);
export const ContributionSchema = z
  .strictObject({
    version: z.literal('personal-contribution.v0'),
    exposureId: z.uuid(),
    assetId: z.uuid(),
    assetRevision: z.number().int().positive(),
    activatedAt: z.iso.datetime(),
    explanationUnitId: Ref,
    qualified: z.boolean(),
    // Only coverage-verified facets; asset tags alone are never sufficient.
    coveredFacets: z.array(Ref).max(16),
    topics: z.array(z.strictObject({ topicId: Ref, role: z.enum(['primary', 'supporting', 'incidental']) })).max(16),
    input: z.strictObject({
      qualificationRevision: z.number().int().nonnegative(),
      actionRevision: z.number().int().nonnegative(),
      navigationRevision: z.number().int().nonnegative(),
      attribution: z.string().min(1).max(160),
      activityPolicy: z.string().min(1).max(80),
      projectionPolicy: z.literal(CONTEXT_POLICY),
    }),
  })
  .superRefine((x, c) => {
    if (
      new Set(x.topics.map((t) => t.topicId)).size !== x.topics.length ||
      new Set(x.coveredFacets).size !== x.coveredFacets.length ||
      (x.qualified && x.input.qualificationRevision < 1) ||
      (!x.qualified && x.coveredFacets.length > 0)
    )
      c.addIssue({ code: 'custom', message: 'Inconsistent structural support' });
  });
export type Contribution = z.infer<typeof ContributionSchema>;
export interface Support {
  readonly topicId: string;
  readonly kind: 'unit' | 'facet';
  readonly key: string;
}
/** One support reference per exposure/key; variants and replays share reference-counted keys. */
export function supports(value: Contribution | undefined): readonly Support[] {
  if (!value?.qualified) return [];
  return value.topics
    .filter((t) => t.role !== 'incidental')
    .flatMap((t) => [
      { topicId: t.topicId, kind: 'unit' as const, key: value.explanationUnitId },
      ...value.coveredFacets.map((key) => ({ topicId: t.topicId, kind: 'facet' as const, key })),
    ]);
}
export function supportChanges(previous: Contribution | undefined, next: Contribution) {
  const key = (s: Support) => JSON.stringify([s.topicId, s.kind, s.key]);
  const old = new Map(supports(previous).map((s) => [key(s), s]));
  const current = new Map(supports(next).map((s) => [key(s), s]));
  return [
    ...[...old].filter(([k]) => !current.has(k)).map(([, s]) => ({ ...s, delta: -1 as const })),
    ...[...current].filter(([k]) => !old.has(k)).map(([, s]) => ({ ...s, delta: 1 as const })),
  ];
}

const Candidate = z.strictObject({ explanationUnitId: Ref, facets: z.array(Ref).max(16) });
export const ContextQuerySchema = z
  .strictObject({
    evaluatedAt: z.iso.datetime(),
    topicIds: z.array(Ref).max(100),
    candidates: z.array(Candidate).max(100),
    candidateAssetIds: z.array(z.uuid()).max(100).optional(),
    provisionalLimit: z.number().int().min(0).max(20).default(20),
  })
  .superRefine((q, c) => {
    if (
      new Set(q.topicIds).size !== q.topicIds.length ||
      new Set(q.candidates.map((x) => x.explanationUnitId)).size !== q.candidates.length ||
      q.candidates.some((x) => new Set(x.facets).size !== x.facets.length) ||
      new Set(q.candidateAssetIds).size !== (q.candidateAssetIds?.length ?? 0)
    )
      c.addIssue({ code: 'custom', message: 'Duplicate context query reference' });
  });
export type ContextQuery = z.input<typeof ContextQuerySchema>;
