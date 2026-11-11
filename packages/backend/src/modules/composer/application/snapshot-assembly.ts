import type { ContinuityLink, EncounterRef, EncounterSnapshot } from '../../content/public.js';
import { systemTopicIdsOf } from '../domain/encountered.js';
import type { ComposerSnapshot, PreparedEvidenceInput, SemanticAssessments } from '../domain/types.js';
import { sourceSeriesId } from '../domain/vertical-rules.js';
import { OTHER_FORMAT_RESERVE } from './vertical-candidates.js';
import type { InterestRollups, ReadPreparedEvidenceInput } from './ports.js';

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
  /** The catalogue system of a topic, `undefined` for an id the catalogue does not hold (one release, `CatalogueSnapshot.systemOf`). */
  readonly systemOf: (topicId: string) => string | undefined;
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
  /**
   * Policy v3 (D-420): the person's overall level and the roll-ups of the systems of the candidates' topics, which the interest
   * and format features shrink toward. Merged into the snapshot's evidence beside the catalogue system of each candidate topic,
   * which is frozen here so a later catalogue never changes a stored decision. Absent under v0 to v2, which leave the snapshot as it was.
   */
  readonly interest?: InterestRollups;
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
  const currentSeriesId = source ? sourceSeriesId(source, candidates) : undefined;
  const systemTopicIds = input.mode === 'vertical' && source ? systemTopicsOf(source, candidates, input.systemOf) : [];
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
      ...(input.mode === 'vertical' && input.excludeSourceSeries && currentSeriesId ? { currentSeriesId } : {}),
      ...(input.mode === 'vertical' && input.relatedAssetIds?.length
        ? { relatedAssetIds: [...input.relatedAssetIds] }
        : {}),
      ...(systemTopicIds.length ? { systemTopicIds } : {}),
    },
    ...(source ? { source: refOf(source) } : {}),
    candidates: candidates.map((encounter) => candidateRow(input, encounter)),
    explorationPool: input.mode === 'vertical' ? explorationPoolOf(candidates) : [],
    ...(input.evidence ? { evidence: withInterest(input.evidence, input.interest, candidates, input.systemOf) } : {}),
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

/**
 * The candidates exploration may draw from: the `explore` lane when retrieval named lanes (a sample stratified by system), else
 * every candidate. A snapshot without lanes is therefore pooled exactly as before.
 */
function explorationPoolOf(candidates: readonly EncounterSnapshot[]): readonly EncounterRef[] {
  const explored = candidates.filter((candidate) => candidate.lane === 'explore');
  return (explored.length > 0 ? explored : candidates).map(refOf);
}

/** The catalogue system of each of the candidates' topics that the catalogue holds, sorted, bounded: policy v3's frozen hierarchy. */
function topicSystemsOf(
  candidates: readonly Pick<EncounterSnapshot, 'topics'>[],
  systemOf: (topicId: string) => string | undefined,
): NonNullable<PreparedEvidenceInput['topicSystems']> {
  const topics = [...new Set(candidates.flatMap((candidate) => candidate.topics.map((t) => t.topicId)))].sort();
  return topics
    .flatMap((topicId) => {
      const systemId = systemOf(topicId);
      return systemId === undefined ? [] : [{ topicId, systemId }];
    })
    .slice(0, 400);
}

/** Evidence with policy v3's roll-ups and topic systems added; unchanged when none were read. */
function withInterest(
  evidence: PreparedEvidenceInput,
  interest: InterestRollups | undefined,
  candidates: readonly Pick<EncounterSnapshot, 'topics'>[],
  systemOf: (topicId: string) => string | undefined,
): PreparedEvidenceInput {
  if (interest === undefined) return evidence;
  return {
    ...evidence,
    ...(interest.person ? { person: interest.person } : {}),
    ...(interest.systems.length > 0 ? { systems: interest.systems } : {}),
    topicSystems: topicSystemsOf(candidates, systemOf),
  };
}

/** The topics of the candidates that share a catalogue system with the source's topics (the `same_system` place Composer records for analytics). */
function systemTopicsOf(
  source: EncounterSnapshot,
  candidates: readonly EncounterSnapshot[],
  systemOf: (topicId: string) => string | undefined,
): readonly string[] {
  const aboutTopics = (encounter: EncounterSnapshot) =>
    encounter.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId);
  return systemTopicIdsOf(aboutTopics(source), candidates.flatMap(aboutTopics), systemOf);
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
 * Drops trailing candidates until the snapshot fits, keeping the other-format reserve (see {@link protectedKeys}) for last. Each pass removes as many candidates as the
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

/**
 * The candidates of the format the person is not in that truncation keeps whatever else it drops: the other-format reserve
 * (`OTHER_FORMAT_RESERVE`, the first of that format in retrieval order). Policy v2 gives format stickiness way to an unseen
 * candidate of the other format, so dropping them first would leave it nothing to give way to.
 */
function protectedKeys(snapshot: ComposerSnapshot): readonly string[] {
  const { stickyFormat } = snapshot.intent;
  if (snapshot.mode !== 'vertical' || stickyFormat === undefined) return [];
  return snapshot.candidates
    .filter((c) => c.encounter.kind !== stickyFormat)
    .slice(0, OTHER_FORMAT_RESERVE)
    .map((c) => keyOf(c.encounter));
}

/**
 * The snapshot restricted to `count` candidates, with evidence that only they need: the protected other-format reserve first,
 * then the rest in retrieval order.
 */
function keepFirst(
  snapshot: ComposerSnapshot,
  count: number,
  hashCatalogWatermarks: SnapshotInput['hashCatalogWatermarks'],
): ComposerSnapshot {
  const reserve = protectedKeys(snapshot);
  const reserved = new Set(reserve.slice(0, count));
  const room = count - reserved.size;
  let taken = 0;
  const kept = snapshot.candidates.filter((c) => {
    const key = keyOf(c.encounter);
    if (reserved.has(key)) return true;
    if (reserve.includes(key) || taken >= room) return false;
    taken += 1;
    return true;
  });
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
    explorationPool: snapshot.mode === 'vertical' ? explorationPoolOf(kept.map((c) => c.encounter)) : [],
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
  const topicSystems = evidence.topicSystems?.filter((t) => needed.topicIds.has(t.topicId));
  const systemIds = new Set(topicSystems?.map((t) => t.systemId));
  return {
    ...evidence,
    ...(topicSystems ? { topicSystems } : {}),
    ...(evidence.systems ? { systems: evidence.systems.filter((system) => systemIds.has(system.systemId)) } : {}),
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
