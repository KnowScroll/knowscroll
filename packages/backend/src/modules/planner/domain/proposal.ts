import { z } from 'zod';

export const PLANNER_POLICY = 'personal-planner.v0' as const;
export const PLANNER_LIMITS = {
  opportunities: 3,
  candidates: 6,
  topics: 100,
  inventory: 100,
  evidence: 20,
  memory: 3,
  expiryDays: 7,
} as const;
const Ref = z.string().min(1).max(160);
export const IntentSchema = z.strictObject({
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
  topicIds: z
    .array(Ref)
    .max(16)
    .refine((xs) => new Set(xs).size === xs.length),
});
export type PlannerIntent = z.infer<typeof IntentSchema>;
export const OpportunitySchema = z.strictObject({
  move: z.enum(['example', 'mechanism', 'limitation', 'consequence', 'perspective', 'connection']),
  title: z.string().min(1).max(160),
  purpose: z.string().min(1).max(400),
  topicIds: z.array(Ref).min(1).max(8),
  explanationUnitId: Ref,
  evidenceRefs: z.array(z.string().min(1).max(128)).min(1).max(8),
  eligibility: z
    .array(z.enum(['vertical', 'related']))
    .min(1)
    .max(2),
  formats: z
    .array(z.enum(['reel', 'scroll']))
    .min(1)
    .max(2),
  expiresAt: z.iso.datetime(),
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('existing'),
      assetId: z.uuid(),
      assetRevision: z.number().int().positive(),
      catalogWatermark: Ref,
    }),
    z.strictObject({ kind: z.literal('missing_supply'), brief: z.string().min(1).max(800) }),
  ]),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
export const ProposalSchema = z.strictObject({
  version: z.literal('planner-proposal.v0'),
  opportunities: z.array(OpportunitySchema).max(PLANNER_LIMITS.candidates),
});
export type PlannerProposal = z.infer<typeof ProposalSchema>;
export interface ValidationFacts {
  readonly evaluatedAt: string;
  readonly topics: readonly string[];
  readonly evidence: readonly {
    readonly ref: string;
    readonly explanationUnitId: string;
    readonly topicIds: readonly string[];
  }[];
  readonly inventory: readonly {
    readonly assetId: string;
    readonly assetRevision: number;
    readonly catalogWatermark: string;
    readonly explanationUnitId: string;
    readonly kind: 'reel' | 'scroll';
    readonly topicIds: readonly string[];
  }[];
  readonly hiddenAssetIds: readonly string[];
}
export type PlannerIssue =
  'unknown_topic' | 'evidence_authority' | 'target_authority' | 'expiry' | 'duplicate_reference';
/** Pure authority checks. Semantic usefulness is evaluated separately from structural acceptance. */
export function opportunityIssue(x: Opportunity, f: ValidationFacts): PlannerIssue | undefined {
  if ([x.topicIds, x.evidenceRefs, x.eligibility, x.formats].some((a) => new Set(a).size !== a.length))
    return 'duplicate_reference';
  if (x.topicIds.some((t) => !f.topics.includes(t))) return 'unknown_topic';
  const evidence = x.evidenceRefs.map((ref) => f.evidence.find((e) => e.ref === ref));
  if (evidence.some((e) => !e) || x.topicIds.some((t) => !evidence.some((e) => e?.topicIds.includes(t))))
    return 'evidence_authority';
  const delta = Date.parse(x.expiresAt) - Date.parse(f.evaluatedAt);
  if (!(delta > 0 && delta <= PLANNER_LIMITS.expiryDays * 86400000)) return 'expiry';
  if (x.target.kind === 'existing') {
    const target = x.target;
    const a = f.inventory.find(
      (a) =>
        a.assetId === target.assetId &&
        a.assetRevision === target.assetRevision &&
        a.catalogWatermark === target.catalogWatermark,
    );
    if (
      !a ||
      a.explanationUnitId !== x.explanationUnitId ||
      !x.formats.includes(a.kind) ||
      f.hiddenAssetIds.includes(a.assetId) ||
      x.topicIds.some((t) => !a.topicIds.includes(t))
    )
      return 'target_authority';
  }
  if (
    x.target.kind === 'missing_supply' &&
    x.topicIds.some(
      (topicId) =>
        ![...f.evidence, ...f.inventory].some(
          (r) => r.explanationUnitId === x.explanationUnitId && r.topicIds.includes(topicId),
        ),
    )
  )
    return 'target_authority';
  return undefined;
}
/** One per explanation identity and at most two per move/topic; stable proposal order is priority. */
export function diversify(xs: readonly Opportunity[]): readonly Opportunity[] {
  const kept: Opportunity[] = [];
  for (const x of xs) {
    if (kept.some((p) => p.explanationUnitId === x.explanationUnitId)) continue;
    if (kept.filter((p) => p.move === x.move).length >= 2) continue;
    if (x.topicIds.some((t) => kept.filter((p) => p.topicIds.includes(t)).length >= 2)) continue;
    kept.push(x);
    if (kept.length === PLANNER_LIMITS.opportunities) break;
  }
  return kept;
}
