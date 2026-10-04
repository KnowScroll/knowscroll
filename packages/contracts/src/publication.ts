/** Publication-gate and media-serving types (ADR-0024). Nothing here is re-exported from
 * `./index.ts`, like `generation.ts`: callers import this file directly. */
import { z } from 'zod';

/** Migration 0014's own pattern for a content-addressed media id / `media_object.sha256`. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof sha256Hex>;

/** Every gate ADR-0024 section 2 defines, in the order it lists them. */
export const publicationGateName = z.enum([
  'lineage_complete',
  'source_support',
  'engine_record',
  'media_conformance',
  'truth_label',
  'repetition',
  'witness_alignment',
]);
export type PublicationGateName = z.infer<typeof publicationGateName>;

/** Migration 0014's `publication_gate_result.verdict` CHECK. */
export const publicationGateVerdict = z.enum([
  'pass',
  'pass_with_label',
  'fail',
  'unavailable',
]);
export type PublicationGateVerdict = z.infer<typeof publicationGateVerdict>;

/** Migration 0014's replaced `generated_reel.availability` CHECK. */
export const generatedReelAvailability = z.enum([
  'imported',
  'eligible',
  'test_eligible',
  'rejected',
  'withdrawn',
]);
export type GeneratedReelAvailability = z.infer<
  typeof generatedReelAvailability
>;

/** Migration 0014's `publication_policy.version` CHECK. */
export const publicationPolicyVersion = z.string().regex(/^[a-z0-9.-]{1,64}$/);
export type PublicationPolicyVersion = z.infer<typeof publicationPolicyVersion>;
