import type { ContinuityLink, EncounterRef, EncounterSnapshot } from '../../content/public.js';
import type { ComposerSnapshot, PreparedEvidenceInput, SemanticAssessments } from '../domain/types.js';
import type { ReadPreparedEvidenceInput } from './ports.js';

/**
 * Durable bound for the complete private decision input. The SQL limit on a stored decision is
 * 262,144 bytes and evaluations are stored beside the input, so the input stays well under it.
 */
export const SNAPSHOT_BYTE_BUDGET = 180_000;

const encoder = new TextEncoder();
const refOf = (encounter: EncounterRef): EncounterRef => ({
  assetId: encounter.assetId,
  assetRevision: encounter.assetRevision,
});
const keyOf = (encounter: EncounterRef): string => `${encounter.assetId}@${String(encounter.assetRevision)}`;

type EvidenceQuery = Parameters<ReadPreparedEvidenceInput>[1];

/** The bounded Personal Context query for exactly these candidates (topics, units, facets, Hide). */
export function evidenceQueryFor(candidates: readonly EncounterSnapshot[], evaluatedAt: string): EvidenceQuery {
  const candidateAssetIds = [...new Set(candidates.map((candidate) => candidate.assetId))];
  const topicIds = [...new Set(candidates.flatMap((candidate) => candidate.topics.map((t) => t.topicId)))].slice(
    0,
    100,
  );
  const unitIds = [...new Set(candidates.map((candidate) => candidate.explanationUnitId))];
  const units = unitIds.map((explanationUnitId) => ({
    explanationUnitId,
    facets: [
      ...new Set(
        candidates
          .filter((candidate) => candidate.explanationUnitId === explanationUnitId)
          .flatMap((candidate) => candidate.facets),
      ),
    ].slice(0, 16),
  }));
  return { evaluatedAt, topicIds, candidates: units, candidateAssetIds };
}

/** Everything the ranking needs, already read under an authorised scope. */
export interface SnapshotInput {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  /** Versioned randomness for exploration and ties; recorded in the decision. */
  readonly seed: string;
  readonly mode: ComposerSnapshot['mode'];
  /** The encounter the person is on, when the move starts from one. */
  readonly source?: EncounterSnapshot;
  readonly candidates: readonly EncounterSnapshot[];
  readonly hiddenAssetIds: readonly string[];
  readonly links: readonly ContinuityLink[];
  readonly exactTarget?: EncounterRef;
  readonly variantFormat?: 'reel' | 'scroll';
  /** Vertical subject moves: stay in this format while anything of it is eligible (`format_sticky`). */
  readonly stickyFormat?: 'reel' | 'scroll';
  /** Vertical subject moves: never offer another part of the source's series (`same_series`). */
  readonly excludeSourceSeries?: boolean;
  /** Vertical subject moves: the assets reachable by the Related tab, excluded as another perspective (`related_target`). */
  readonly relatedAssetIds?: readonly string[];
  readonly evidence?: PreparedEvidenceInput;
  readonly semanticAssessments?: SemanticAssessments;
  /** Used when no prepared context exists, so the decision still names what it was ranked against. */
  readonly fallbackContextWatermark: string;
  /** Stable digest of the candidates' catalogue watermarks. */
  readonly hashCatalogWatermarks: (watermarks: readonly string[]) => string;
}

export interface AssembledSnapshot {
  readonly snapshot: ComposerSnapshot;
  /** Candidates were dropped to stay within {@link SNAPSHOT_BYTE_BUDGET}. */
  readonly truncated: boolean;
}

/**
 * Builds the immutable ranking input (blueprint §9). Pure: it reads nothing and has no effects.
 * When the serialised input exceeds the durable budget it drops trailing candidates (and the
 * evidence that only they needed) until it fits, and reports that it did so.
 */
export function assembleSnapshot(input: SnapshotInput): AssembledSnapshot {
  const { source, candidates, links } = input;
  const assessments = presentAssessments(input);
  const full: ComposerSnapshot = {
    universeId: input.universeId,
    privacyEpoch: input.privacyEpoch,
    evaluatedAt: input.evaluatedAt,
    seed: input.seed,
    mode: input.mode,
    intent: {
      language: candidates[0]?.metadata.language ?? source?.metadata.language ?? 'en',
      topicIds: source?.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) ?? [],
      text: source ? `${source.metadata.title} ${source.metadata.summary}`.slice(0, 2000) : '',
      ...(input.exactTarget ? { exactTarget: refOf(input.exactTarget) } : {}),
      // Variant: the explanation to stay on. Vertical: the explanation to move away from.
      ...(input.variantFormat && source ? { format: input.variantFormat } : {}),
      ...(source && (input.variantFormat || input.mode === 'vertical')
        ? { explanationUnitId: source.explanationUnitId }
        : {}),
      ...(links[0] ? { continuityLinkId: links[0].linkId } : {}),
      ...(input.mode === 'vertical' && input.stickyFormat ? { stickyFormat: input.stickyFormat } : {}),
      ...(input.mode === 'vertical' && input.excludeSourceSeries && source?.series
        ? { currentSeriesId: source.series.seriesId }
        : {}),
      ...(input.mode === 'vertical' && input.relatedAssetIds?.length
        ? { relatedAssetIds: [...input.relatedAssetIds] }
        : {}),
    },
    ...(source ? { source: refOf(source) } : {}),
    candidates: candidates.map((encounter) => candidateRow(input, encounter)),
    explorationPool: input.mode === 'vertical' ? candidates.map(refOf) : [],
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(assessments ? { semanticAssessments: assessments } : {}),
    watermarks: {
      catalog: input.hashCatalogWatermarks(candidates.map((c) => c.catalogWatermark)),
      continuity: links.map((l) => `${l.linkId}:${String(l.revision)}`).join(':') || 'none',
      taxonomy: 'admitted-brief-taxonomy.v0',
      context: input.evidence?.watermark ?? input.fallbackContextWatermark,
    },
  };
  return fitToBudget(full, input.hashCatalogWatermarks);
}

/** Stored assessments may name candidates that are no longer retrieved; only present ones inform ranking. */
function presentAssessments(input: SnapshotInput): SemanticAssessments | undefined {
  const retrieved = new Set(input.candidates.map(keyOf));
  const entries = input.semanticAssessments?.entries.filter((entry) => retrieved.has(keyOf(entry)));
  return input.semanticAssessments && entries?.length ? { ...input.semanticAssessments, entries } : undefined;
}

function candidateRow(input: SnapshotInput, encounter: EncounterSnapshot): ComposerSnapshot['candidates'][number] {
  const link = input.links.find((l) => keyOf(l.target) === keyOf(encounter));
  return {
    encounter,
    admitted: true,
    accessible: !input.hiddenAssetIds.includes(encounter.assetId),
    renderable: true,
    ...(link
      ? {
          continuity: {
            linkId: link.linkId,
            source: refOf(link.source),
            target: refOf(link.target),
            direction: link.direction,
            strength: link.strength,
          },
        }
      : {}),
  };
}

function sizeOf(snapshot: ComposerSnapshot): number {
  return encoder.encode(JSON.stringify(snapshot)).length;
}

/**
 * Drops trailing candidates until the snapshot fits. Each pass removes as many candidates as the
 * average candidate size says the overshoot needs (at least one), so a snapshot is serialised a
 * few times at most. Retrieval order is the policy's, so truncation is deterministic.
 */
function fitToBudget(
  snapshot: ComposerSnapshot,
  hashCatalogWatermarks: SnapshotInput['hashCatalogWatermarks'],
): AssembledSnapshot {
  let current = snapshot;
  let bytes = sizeOf(current);
  while (bytes > SNAPSHOT_BYTE_BUDGET && current.candidates.length > 0) {
    const averageCandidateBytes = Math.max(1, bytes / (current.candidates.length + 1));
    const drop = Math.max(1, Math.ceil((bytes - SNAPSHOT_BYTE_BUDGET) / averageCandidateBytes));
    current = keepFirst(current, Math.max(0, current.candidates.length - drop), hashCatalogWatermarks);
    bytes = sizeOf(current);
  }
  return { snapshot: current, truncated: current !== snapshot };
}

/** The snapshot restricted to its first `count` candidates, with evidence that only they need. */
function keepFirst(
  snapshot: ComposerSnapshot,
  count: number,
  hashCatalogWatermarks: SnapshotInput['hashCatalogWatermarks'],
): ComposerSnapshot {
  const kept = snapshot.candidates.slice(0, count);
  const needed = {
    unitIds: new Set(kept.map((c) => c.encounter.explanationUnitId)),
    topicIds: new Set(kept.flatMap((c) => c.encounter.topics.map((t) => t.topicId))),
    assetIds: new Set(kept.map((c) => c.encounter.assetId)),
  };
  const keptKeys = new Set(kept.map((c) => keyOf(c.encounter)));
  const { evidence, semanticAssessments } = snapshot;
  return {
    ...snapshot,
    candidates: kept,
    explorationPool: snapshot.mode === 'vertical' ? kept.map((c) => refOf(c.encounter)) : [],
    ...(evidence ? { evidence: restrictEvidence(evidence, kept, needed) } : {}),
    ...(semanticAssessments
      ? {
          semanticAssessments: {
            ...semanticAssessments,
            entries: semanticAssessments.entries.filter((e) => keptKeys.has(keyOf(e))),
          },
        }
      : {}),
    watermarks: {
      ...snapshot.watermarks,
      catalog: hashCatalogWatermarks(kept.map((c) => c.encounter.catalogWatermark)),
    },
  };
}

function restrictEvidence(
  evidence: PreparedEvidenceInput,
  kept: ComposerSnapshot['candidates'],
  needed: {
    readonly unitIds: ReadonlySet<string>;
    readonly topicIds: ReadonlySet<string>;
    readonly assetIds: ReadonlySet<string>;
  },
): PreparedEvidenceInput {
  const { established } = evidence;
  return {
    ...evidence,
    topics: evidence.topics.filter((t) => needed.topicIds.has(t.topicId)),
    hiddenAssetIds: evidence.hiddenAssetIds.filter((id) => needed.assetIds.has(id)),
    ...(established
      ? {
          established: {
            ...established,
            units: established.units
              .filter((u) => needed.unitIds.has(u.explanationUnitId))
              .map((u) => {
                const facets = new Set(
                  kept
                    .filter((c) => c.encounter.explanationUnitId === u.explanationUnitId)
                    .flatMap((c) => c.encounter.facets),
                );
                return { ...u, facets: u.facets.filter((f) => facets.has(f.facetId)) };
              }),
          },
        }
      : {}),
  };
}
