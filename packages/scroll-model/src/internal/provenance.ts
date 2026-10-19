import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { LocalId, OpaqueId, ParamKey, Revision, Sha256Hex } from '../primitives.js';

/**
 * `scroll-provenance.v1`: what a published Scroll rests on — claims with verbatim quotes, their
 * sources, the bindings of claims to passages, constants and blocks, the checks that ran and how
 * the revision was produced. Backend-only: stored beside the revision, never served to readers,
 * and never imported by client packages (dependency-cruiser `clients-never-import-scroll-internals`).
 */
export const SCROLL_PROVENANCE_SCHEMA_VERSION = 'scroll-provenance.v1';

/** The truth-state vocabulary carried forward from v1's ledger. */
export const TRUTH_STATES = [
  'documented',
  'synthesis',
  'interpretation',
  'disputed',
  'modelled',
  'counterfactual',
  'fictional',
] as const;

export const Claim = z.strictObject({
  claimId: OpaqueId,
  statement: z.string().min(1).max(600),
  /** Verbatim passage of the source snapshot the claim rests on (checked by the research stage). */
  quote: z.string().min(1).max(1_200),
  sourceId: OpaqueId,
  truthState: z.enum(TRUTH_STATES),
});
export type Claim = z.infer<typeof Claim>;

export const Source = z.strictObject({
  sourceId: OpaqueId,
  title: z.string().min(1).max(300),
  url: z
    .string()
    .max(2_048)
    .regex(/^https:\/\/\S+$/u),
  snapshotSha256: Sha256Hex,
  retrievedAt: z.iso.datetime(),
});
export type Source = z.infer<typeof Source>;

/**
 * Where a claim is relied on: a passage range of a text block (UTF-16, `text-projection.v1`), a
 * simulation constant, or a whole block (diagram, chart, table, simulation).
 */
export const ProvenanceBinding = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('passage'),
    claimId: OpaqueId,
    blockId: LocalId,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  }),
  z.strictObject({ kind: z.literal('constant'), claimId: OpaqueId, blockId: LocalId, constantKey: ParamKey }),
  z.strictObject({ kind: z.literal('block'), claimId: OpaqueId, blockId: LocalId }),
]);
export type ProvenanceBinding = z.infer<typeof ProvenanceBinding>;

/** One check stage that ran on the revision, e.g. `evidence` of `scroll-checks.v1`. */
export const CheckRecord = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/u),
  version: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/u),
  verdict: z.enum(['pass', 'fail', 'not-applicable']),
  reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u)).max(64),
});
export type CheckRecord = z.infer<typeof CheckRecord>;

/**
 * How the revision came to be. `model`: a writer run through the harness (one attempt, or one
 * attempt and one repair). `authored-editorial`: written by the editorial team (D-005).
 * `fixture`: test and CI data only, never product content.
 */
export const ProductionRecord = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('model'),
    runId: OpaqueId,
    attemptIds: z.array(OpaqueId).min(1).max(2),
    model: z.string().min(1).max(80),
    promptVersion: z.string().min(1).max(60),
  }),
  z.strictObject({ kind: z.literal('authored-editorial'), reference: OpaqueId }),
  z.strictObject({ kind: z.literal('fixture'), label: z.string().min(1).max(200) }),
]);
export type ProductionRecord = z.infer<typeof ProductionRecord>;

export const ScrollProvenance = z.strictObject({
  schemaVersion: z.literal(SCROLL_PROVENANCE_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  /** `integrity.sha256` of the document revision this provenance belongs to. */
  documentSha256: Sha256Hex,
  claims: z.array(Claim).max(48),
  sources: z.array(Source).max(24),
  bindings: z.array(ProvenanceBinding).max(LIMITS.blocks * 3),
  checks: z.array(CheckRecord).max(32),
  production: ProductionRecord,
});
export type ScrollProvenance = z.infer<typeof ScrollProvenance>;
