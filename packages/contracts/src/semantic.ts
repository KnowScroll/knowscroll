/**
 * #131 — semantic substrate contract (ADR-0031). Shared, versioned wire and seed shapes for
 * sources, evidence families, concepts, claims, typed relations, conceptual bridges, proposals
 * and corrections. Nothing here is re-exported from `./index.ts`; callers import this file
 * directly, like `worlds.ts`/`inventory.ts`.
 *
 * Vocabulary is deliberately closed. A bridge is a typed, evidence-carrying proposal that a
 * deterministic validator admits or rejects; a keyword overlap, an exposure count or a model's
 * confidence is never evidence (docs/architecture/target/07 §2, 08 §3). Behavior is evidence of
 * attention only — nothing in this file can express a belief, a mastery level or an identity.
 */
import { z } from 'zod';

export const SEMANTIC_CONTRACT_VERSION = 'semantic-v1';
/** The validator policy a decision was made under. A changed rule is a new version, recorded on
 * every proposal decision, so an old admission can be re-derived under the rules it passed. */
export const BRIDGE_VALIDATOR_VERSION = 'bridge-validator-v1';

/** A stable hierarchical semantic address, e.g. `astro.gravity.orbit`. */
export const conceptCode = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,5}$/);
/** Editorial identity for a source, family or claim: stable across database rebuilds. */
export const semanticKey = z.string().regex(/^[a-z][a-z0-9_.-]{2,79}$/);

export const conceptKind = z.enum(['phenomenon', 'mechanism', 'law', 'quantity', 'object', 'process', 'idea']);
/** Substrate relations between concepts, each backed by one claim. `contradicts` is between
 * claims' concepts where the sources disagree; it is not a bridge. */
export const substrateRelationKind = z.enum([
  'narrower_than', 'part_of', 'prerequisite_for', 'explains', 'contradicts', 'analogous_in', 'applies_to',
]);
/** The only relation types a conceptual bridge may carry (target 08 §3). */
export const bridgeRelationType = z.enum(['analogous_in', 'applies_to', 'prerequisite_for', 'explains', 'compares_mechanism']);
export type BridgeRelationType = z.infer<typeof bridgeRelationType>;
/** Symmetric bridge types compare two things; the rest are directional (from → to). */
export const SYMMETRIC_BRIDGE_TYPES: readonly BridgeRelationType[] = ['analogous_in', 'compares_mechanism'];

export const claimConceptRole = z.enum(['subject', 'object', 'mechanism', 'context']);
export const supportKind = z.enum(['supports', 'qualifies', 'contradicts']);
export const assetConceptRole = z.enum(['primary', 'secondary', 'mentioned']);
export const evidenceSupports = z.enum(['from', 'to', 'mechanism', 'limitation']);
export const limitationKind = z.enum(['analogy_limit', 'scope_limit', 'evidence_limit']);
export const snapshotStatus = z.enum(['current', 'corrected', 'revoked']);

const text = (min: number, max: number) => z.string().refine(v => {
  const t = v.trim();
  return t.length >= min && t.length <= max && !v.includes('\0');
}, `must be ${min}–${max} non-blank characters`);

// ---------------------------------------------------------------------------------------------
// Bridge proposals: the one shape every proposer (editorial, rule, model, person) submits.
// ---------------------------------------------------------------------------------------------

export const bridgeEvidenceRef = z.object({ claimKey: semanticKey, supports: evidenceSupports }).strict();
export type BridgeEvidenceRef = z.infer<typeof bridgeEvidenceRef>;

export const bridgeProposalPayload = z.object({
  fromConcept: conceptCode,
  toConcept: conceptCode,
  relationType: bridgeRelationType,
  /** An actual explanation of how the two connect — never the relation word alone. */
  mechanism: text(40, 600),
  prerequisites: z.array(z.object({ statement: text(8, 280), conceptCode: conceptCode.optional() }).strict()).min(1).max(5),
  limitations: z.array(z.object({ kind: limitationKind, statement: text(8, 280) }).strict()).min(1).max(5),
  evidence: z.array(bridgeEvidenceRef).min(3).max(12),
  /** Counterevidence may be empty only with an explicit search disposition over a named scope. */
  counterevidence: z.object({
    disposition: z.enum(['listed', 'searched_none_found']),
    searchedScope: text(4, 200),
    claimKeys: z.array(semanticKey).max(12),
  }).strict(),
}).strict();
export type BridgeProposalPayload = z.infer<typeof bridgeProposalPayload>;

/** Who proposed. `rule` and `editorial` are deterministic or human-curated; `model` output must
 * cite a reasoning attempt; `person` is a direct user act in their own universe. */
export const proposerKind = z.enum(['editorial', 'rule', 'model', 'person']);
export type ProposerKind = z.infer<typeof proposerKind>;

/** Rejection reasons are a closed vocabulary so a decision can be re-derived and compared. */
export const bridgeRejectionReason = z.enum([
  'concept_unknown',
  'same_concept',
  'hierarchy_not_bridge',
  'mechanism_is_label',
  'evidence_unresolved',
  'evidence_unsupported',
  'from_side_unsupported',
  'to_side_unsupported',
  'mechanism_unsupported',
  'direction_unsupported',
  'contradicted_by_substrate',
  'analogy_limit_missing',
  'counterevidence_unresolved',
  'counterevidence_ignored',
  'counterevidence_cited_as_support',
  'duplicate_admitted',
  'stale_read_set',
  'foreign_scope',
  'stale_epoch',
]);
export type BridgeRejectionReason = z.infer<typeof bridgeRejectionReason>;

export type BridgeDecision =
  | { outcome: 'admitted'; validatorVersion: string; supportingClaimKeys: string[]; notes: string[] }
  | { outcome: 'rejected'; validatorVersion: string; reasons: BridgeRejectionReason[]; notes: string[] };

// ---------------------------------------------------------------------------------------------
// Editorial substrate seed (content/substrate.json). Loaded idempotently; never overwrites.
// ---------------------------------------------------------------------------------------------

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const substrateSeed = z.object({
  version: z.string().regex(/^editorial-substrate-\d{4}-\d{2}-\d{2}(\.\d+)?$/),
  families: z.array(z.object({
    key: semanticKey, kind: z.enum(['publisher', 'author', 'dataset']), description: text(8, 400),
  }).strict()).min(1),
  sources: z.array(z.object({
    key: semanticKey,
    url: z.string().url().refine(u => u.startsWith('https://'), 'sources must be https'),
    title: text(3, 300),
    publisher: text(2, 120),
    familyKey: semanticKey,
    retrievedAt: isoDay,
    /** SHA-256 of the normalized visible text the quotes below were verified against. */
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).min(1),
  concepts: z.array(z.object({
    code: conceptCode, name: text(2, 80), description: text(8, 400), kind: conceptKind,
    parentCode: conceptCode.nullable(),
  }).strict()).min(1),
  claims: z.array(z.object({
    key: semanticKey,
    statement: text(12, 400),
    truthState: z.literal('documented'),
    concepts: z.array(z.object({ code: conceptCode, role: claimConceptRole }).strict()).min(1).max(6),
    support: z.array(z.object({
      sourceKey: semanticKey,
      /** An exact passage of the source's normalized visible text (verified mechanically). */
      quote: text(12, 400),
      supportKind,
    }).strict()).min(1).max(4),
  }).strict()).min(1),
  relations: z.array(z.object({
    from: conceptCode, to: conceptCode, kind: substrateRelationKind, claimKey: semanticKey,
  }).strict()),
  assets: z.array(z.object({
    assetId: z.string().uuid(),
    concepts: z.array(z.object({ code: conceptCode, role: assetConceptRole }).strict()).min(1).max(8),
    claims: z.array(semanticKey).max(12),
  }).strict()),
  /** Editorial bridge proposals pass through the same validator as any other proposer. */
  bridgeProposals: z.array(z.object({ key: semanticKey, payload: bridgeProposalPayload }).strict()),
}).strict();
export type SubstrateSeed = z.infer<typeof substrateSeed>;

// ---------------------------------------------------------------------------------------------
// Corrections. A source correction propagates deterministically; a person's objection to a
// connection is personal suppression plus a review request, never a factual retraction.
// ---------------------------------------------------------------------------------------------

export const sourceCorrectionInput = z.object({
  sourceKey: semanticKey,
  action: z.enum(['corrected', 'revoked']),
  reason: text(8, 400),
}).strict();
export type SourceCorrectionInput = z.infer<typeof sourceCorrectionInput>;

export const connectionObjection = z.enum(['not_useful', 'seems_wrong']);
export const connectionFeedbackInput = z.object({
  clientFeedbackId: z.string().uuid(),
  bridgeId: z.string().uuid(),
  expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
  objection: connectionObjection,
}).strict();
export type ConnectionFeedbackInput = z.infer<typeof connectionFeedbackInput>;

// ---------------------------------------------------------------------------------------------
// HTTP: live continuations for one encounter (`GET /v1/assets/:assetId/branches`) and branch
// resolution (`POST /v1/branches`). Only admitted, non-suppressed bridges appear.
// ---------------------------------------------------------------------------------------------

export type BranchEvidence = { claimKey: string; statement: string; supports: z.infer<typeof evidenceSupports>; sourceTitle: string; sourceUrl: string };

export interface EncounterBranchWire {
  branchId: string;
  bridgeId: string;
  relationType: BridgeRelationType;
  /** `forward` travels the bridge as validated (from → to); `reverse` walks it back (e.g. from
   * an explained phenomenon to what explains it). Symmetric types are always `forward` from the
   * reader's side. `fromConcept`/`toConcept` are always in the reader's travel order. */
  direction: 'forward' | 'reverse';
  /** Plain-language relation in travel order, e.g. "explains" or "is explained by". */
  relationPhrase: string;
  fromConcept: { code: string; name: string };
  toConcept: { code: string; name: string };
  mechanism: string;
  limitations: { kind: z.infer<typeof limitationKind>; statement: string }[];
  prerequisites: string[];
  evidence: BranchEvidence[];
  target: { assetId: string; revision: number; kind: 'Scroll' | 'Reel'; title: string; summary: string; sourceTitle: string };
  /** True when the target has already been exposed to this reader (a revisit, not new). */
  seen: boolean;
}

export interface EncounterBranchesResponse {
  assetId: string;
  revision: number;
  privacyEpoch: number;
  branches: EncounterBranchWire[];
  /** Honest reason the list is empty: no concepts annotated yet, or no admitted bridge reaches
   * an eligible encounter. Never filled with an unrelated feed item. */
  emptyReason: 'no_semantic_annotation' | 'no_admitted_bridge' | 'no_eligible_target' | null;
}

export const branchOpenInput = z.object({
  clientBranchId: z.string().uuid(),
  fromExposureId: z.string().uuid(),
  bridgeId: z.string().uuid(),
  targetAssetId: z.string().uuid(),
  expectedPrivacyEpoch: z.number().int().min(0).max(2147483647),
}).strict();
export type BranchOpenInput = z.infer<typeof branchOpenInput>;

/** `POST /v1/branches`: the same shape as a feed decision, plus what was (or was not) recorded. */
export interface BranchOpenResponse {
  /** Null while recording is paused: the target is served for reading only and nothing is stored. */
  decisionId: string | null;
  universeId: string;
  accountRevision: number;
  privacyEpoch: number;
  items: unknown[];
  branch: {
    branchOpenId: string | null;
    /** False while recording is paused: the continuation is served, nothing personal is kept. */
    recorded: boolean;
    bridgeId: string;
    relationType: BridgeRelationType;
    direction: 'forward' | 'reverse';
  };
}

export interface ConnectionFeedbackReceipt { feedbackId: string; bridgeId: string; objection: z.infer<typeof connectionObjection>; suppressed: true }
