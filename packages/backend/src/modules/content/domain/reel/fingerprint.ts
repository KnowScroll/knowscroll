import type { ReelBrief } from './script.js';

/** SHA-256 of UTF-8 text as lowercase hex. Injected: the domain does no I/O and imports no Node. */
export type Sha256 = (text: string) => string;

/** Keys sorted, scalars as JSON: one text for one value, whatever order it was built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const normalizeNarration = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** What a script looks like when its words and sources are ignored. */
export interface ReelStructure {
  readonly narrationClaimCounts: readonly number[];
  readonly claimRoles: readonly string[];
  readonly mustShowTypes: readonly string[];
  readonly mustNotShowTypes: readonly string[];
  readonly depictionPolicyVersion: string;
  readonly styleId: string;
  readonly styleVersion: number;
}

export function reelStructure(brief: ReelBrief): ReelStructure {
  return {
    narrationClaimCounts: brief.narration.map((sentence) => sentence.claimIds.length),
    claimRoles: brief.claims.map((claim) => claim.role).sort(),
    mustShowTypes: brief.criteria.mustShow.map((criterion) => criterion.type).sort(),
    mustNotShowTypes: brief.criteria.mustNotShow.map((criterion) => criterion.type).sort(),
    depictionPolicyVersion: brief.criteria.depictionPolicyVersion,
    styleId: brief.style.id,
    styleVersion: brief.style.version,
  };
}

/**
 * The three repetition fingerprints (CF-63, ADR-0024). A new Reel may not share any of them with a
 * Reel that already exists, whatever became of that Reel. The rule over-rejects on purpose and
 * never claims that two scripts differ in meaning.
 */
export interface ReelFingerprints {
  /** The structure above. */
  readonly templateSha256: string;
  /** The world label, the sources and the sentences, sorted. */
  readonly argumentSha256: string;
  /** The sentences alone, sorted: a rewording of structure cannot hide reused narration. */
  readonly bridgeSha256: string;
}

export function reelFingerprints(brief: ReelBrief, sha256: Sha256): ReelFingerprints {
  const narrationText = brief.narration.map((sentence) => normalizeNarration(sentence.text)).sort();
  const sources = [...new Set(brief.claimSources.map((source) => `${source.assetId}@${source.assetRevision}`))].sort();
  return {
    templateSha256: sha256(canonicalJson({ ...reelStructure(brief), planVaryOn: null })),
    argumentSha256: sha256(canonicalJson({ worldId: brief.worldId, sources, narrationText })),
    bridgeSha256: sha256(canonicalJson({ narrationText })),
  };
}

export interface ReelOnRecord extends ReelFingerprints {
  /** Names the Reel in a refusal: a script name or an asset id. */
  readonly label: string;
}

export interface Repetition {
  readonly label: string;
  readonly shared: 'template' | 'argument' | 'bridge';
}

/** The first existing Reel that shares a fingerprint with the candidate, or `undefined`. */
export function findRepetition(candidate: ReelFingerprints, existing: readonly ReelOnRecord[]): Repetition | undefined {
  for (const other of existing) {
    if (other.templateSha256 === candidate.templateSha256) return { label: other.label, shared: 'template' };
    if (other.argumentSha256 === candidate.argumentSha256) return { label: other.label, shared: 'argument' };
    if (other.bridgeSha256 === candidate.bridgeSha256) return { label: other.label, shared: 'bridge' };
  }
  return undefined;
}
