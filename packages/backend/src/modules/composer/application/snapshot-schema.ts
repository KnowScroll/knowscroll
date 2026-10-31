import { z } from 'zod';
import type { ComposerSnapshot } from '../domain/types.js';
const Id = z.string().min(1).max(160);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Format = z.enum(['reel', 'scroll']);
const Ref = z.strictObject({ assetId: Id, assetRevision: Revision });
const Position = z.strictObject({ seriesId: Id, seriesRevision: Revision, part: z.number().int().min(1).max(99) });
const Facets = z.array(Id).max(16);
const Level = z.enum(['plain', 'stage', 'game']);
/** Public facts of the content (D-192): no field for a pick, a result, a spark or a tier can be added by accident. */
const Traits = z.strictObject({
  playLevel: Level,
  readingMinutes: z.number().min(0.1).max(240).optional(),
  misconceptionClaim: z.string().min(1).max(240).optional(),
  seriesTotal: z.number().int().min(1).max(99).optional(),
});
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
  traits: Traits.optional(),
  catalogWatermark: z.string().min(1).max(240),
  attributionVersion: Id,
});
const Plan = z.strictObject({
  revision: Revision,
  opportunities: z
    .array(
      z.strictObject({
        move: z.enum(['example', 'mechanism', 'limitation', 'consequence', 'perspective', 'connection']),
        topicIds: z.array(Id).min(1).max(8),
        explanationUnitId: Id,
        eligibility: z
          .array(z.enum(['vertical', 'related']))
          .min(1)
          .max(2),
        formats: z.array(Format).min(1).max(2),
        expiresAt: z.iso.datetime(),
        target: z.enum(['existing', 'missing_supply']),
      }),
    )
    .max(3),
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
    stickyFormat: Format.optional(),
    currentSeriesId: Id.optional(),
    relatedAssetIds: z.array(Id).max(16).optional(),
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
      plan: Plan.optional(),
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
            cells: z
              .array(
                z.strictObject({
                  kind: Format,
                  level: Level,
                  measured: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                  qualified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                }),
              )
              .max(6)
              .optional(),
          }),
        )
        .max(100),
      recent: z
        .array(
          z.strictObject({
            exposureId: Id,
            activatedAt: z.iso.datetime(),
            explanationUnitId: Id,
            facets: Facets,
            topicIds: z.array(Id).max(16).optional(),
          }),
        )
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
