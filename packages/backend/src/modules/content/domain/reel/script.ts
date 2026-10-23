import { z } from 'zod';

/**
 * A Reel script is what Cutroom is asked to film: narration sentences bound to claims, what each
 * claim must look like, and what must never appear. It is authored in Git, approved there and
 * shipped with the release (`approved/reel-scripts/`). It names the library recipe whose Scroll is
 * its twin: every claim's source is that Scroll at a fixed revision.
 */
const reference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

const claimRole = z.enum(['main', 'supporting']);
const criterionType = z.enum(['presence', 'event']);

const criterion = z.strictObject({
  id: reference,
  text: z.string().min(1).max(300),
  type: criterionType,
  claimId: reference.optional(),
});

export const ReelBriefSchema = z.strictObject({
  version: z.literal(1),
  /** Cutroom's own label for the world the request belongs to; it never leaves Cutroom. */
  worldId: reference,
  narration: z.array(z.strictObject({ text: z.string().min(1).max(400), claimIds: z.array(reference).max(8) })).max(12),
  claims: z.array(z.strictObject({ id: reference, role: claimRole })).max(16),
  claimSources: z
    .array(
      z.strictObject({
        claimId: reference,
        assetId: z.uuid(),
        assetRevision: z.number().int().positive(),
      }),
    )
    .max(16),
  criteria: z.strictObject({
    mustShow: z.array(criterion).max(16),
    mustNotShow: z.array(criterion).max(16),
    depictionPolicyVersion: reference,
  }),
  style: z.strictObject({
    id: reference,
    version: z.number().int().min(0).max(10000),
    text: z.string().min(1).max(400),
  }),
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(2000),
});

export const ReelScriptSchema = z.strictObject({
  /** The Reel asset's own identity; the same in every world. */
  id: z.uuid(),
  authoredBy: z.string().min(1).max(200),
  approval: z.strictObject({
    ref: z.string().min(1).max(300),
    /** Who approved it. A delegated approval says so (D-030). */
    approvedBy: z.string().min(1).max(200),
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  /** The library recipe key whose Scroll is this Reel's twin. */
  recipe: z.string().min(1).max(80),
  brief: ReelBriefSchema,
});

export type ReelBrief = z.infer<typeof ReelBriefSchema>;
export type ReelScript = z.infer<typeof ReelScriptSchema>;
export type ReelUntil = 'plan' | 'video';

/** Cutroom's own cap for one Reel, in cents (CF-62). No order may ask for more. */
export const REEL_CEILING_CAP_CENTS = 75;

/** The approval text the shared pool records with a claim, bounded to the pool's own column. */
export function approvalReference(script: ReelScript): string {
  const { ref, approvedBy, approvedAt } = script.approval;
  return `${ref} (${approvedBy}, ${approvedAt})`.slice(0, 500);
}
