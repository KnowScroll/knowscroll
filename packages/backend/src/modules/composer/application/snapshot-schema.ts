import { z } from 'zod';
import type { ComposerSnapshot } from '../domain/types.js';
const Id = z.string().min(1).max(160);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Format = z.enum(['reel', 'scroll']);
const Ref = z.strictObject({ assetId: Id, assetRevision: Revision });
const Position = z.strictObject({ seriesId: Id, seriesRevision: Revision, part: z.number().int().min(1).max(99) });
const Facets = z.array(Id).max(16);
const Encounter = Ref.extend({
  kind: Format,
  explanationUnitId: Id,
  metadata: z.strictObject({
    kind: Format,
    title: z.string().min(1).max(240),
    summary: z.string().max(2000),
    language: z.string().min(1).max(35),
  }),
  topics: z
    .array(
      z.strictObject({
        topicId: Id,
        role: z.enum(['primary', 'supporting', 'incidental']),
        weight: z.number().gt(0).max(1),
      }),
    )
    .max(16),
  facets: Facets,
  siblings: z.array(Ref.extend({ kind: Format })).max(2),
  series: Position.optional(),
  catalogWatermark: z.string().min(1).max(240),
  attributionVersion: Id,
});
/** Strict backend snapshot: extra raw observations, prompts or provider output are not accepted. */
export const ComposerSnapshotSchema: z.ZodType<ComposerSnapshot> = z.strictObject({
  universeId: Id,
  privacyEpoch: Revision,
  evaluatedAt: z.iso.datetime(),
  seed: Id,
  mode: z.enum(['vertical', 'horizontal', 'return', 'variant']),
  intent: z.strictObject({
    language: z.string().min(1).max(35),
    format: Format.optional(),
    topicIds: z.array(Id).max(16),
    requiredTopicIds: z.array(Id).max(16).optional(),
    continuityLinkId: Id.optional(),
    text: z.string().max(2000),
    exactTarget: Ref.optional(),
    explanationUnitId: Id.optional(),
  }),
  source: Ref.optional(),
  candidates: z
    .array(
      z.strictObject({
        encounter: Encounter,
        admitted: z.boolean(),
        accessible: z.boolean(),
        renderable: z.boolean(),
        continuity: z
          .strictObject({
            linkId: Id,
            source: Ref,
            target: Ref,
            direction: z.enum(['previous', 'next', 'related']),
            strength: z.number().min(0).max(1),
          })
          .optional(),
      }),
    )
    .max(100),
  explorationPool: z.array(Ref).max(100),
  evidence: z
    .strictObject({
      universeId: Id,
      privacyEpoch: Revision,
      evaluatedAt: z.iso.datetime(),
      watermark: z.string().min(1).max(240),
      policyVersion: Id,
      topics: z
        .array(
          z.strictObject({
            topicId: Id,
            activity: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
            formats: z
              .array(
                z.strictObject({
                  kind: Format,
                  measured: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                  qualified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                }),
              )
              .max(2),
          }),
        )
        .max(100),
      recent: z
        .array(z.strictObject({ exposureId: Id, activatedAt: z.iso.datetime(), explanationUnitId: Id, facets: Facets }))
        .max(20),
      established: z
        .strictObject({
          policyVersion: Id,
          watermark: z.string().min(1).max(240),
          units: z
            .array(
              z.strictObject({
                explanationUnitId: Id,
                encountered: z.boolean(),
                facets: z.array(z.strictObject({ facetId: Id, encountered: z.boolean() })).max(16),
              }),
            )
            .max(100),
        })
        .optional(),
      hiddenAssetIds: z.array(Id).max(1000),
    })
    .optional(),
  semanticAssessments: z
    .strictObject({
      roleVersion: Id,
      model: Id,
      assessedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      entries: z
        .array(
          Ref.extend({
            relevance: z.number().min(0).max(1),
            appropriateness: z.number().min(0).max(1),
            redundancy: z.number().min(0).max(1),
          }),
        )
        .max(25),
    })
    .optional(),
  watermarks: z.strictObject({
    catalog: z.string().min(1).max(240),
    continuity: z.string().min(1).max(240),
    taxonomy: z.string().min(1).max(240),
    context: z.string().min(1).max(240),
  }),
});
