/**
 * ADR-0024 section 2 — the seven publication gates, as pure(ish) functions over
 * already-fetched data. `evaluate.ts` owns every database read/write; this file owns only what a
 * gate actually decides and the evidence it records. `media_conformance` is the one function here
 * that touches the filesystem (re-hashing and re-probing the stored file); it still makes no
 * database call.
 *
 * Under `publication-v1`, `witness_alignment` always returns `unavailable`: there is no Visual
 * Witness model, so this gate can never be computed. It must never be changed to return `pass` as a
 * stub — see ADR-0024 section 2 and section 5 ("what this ADR does not do").
 *
 * Under `publication-v2` (#199, the owner's decision of 2026-10-05, chosen knowingly over Claude's
 * objection), the gate is computed from Cutroom's own checks of every shot it used, and its verdict is
 * never better than `pass_with_label`: the evidence says "engine-attested, not independent". An
 * independent witness can replace this later through a new policy version, without remaking a Reel.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { GenerationBrief } from '@knowscroll/contracts/generation';
import type {
  PublicationGateName,
  PublicationGateVerdict,
} from '@knowscroll/contracts/publication';
import { ffprobeJson, MEDIA_PROFILE } from '../generation/media-profile.ts';
import {
  checkRegularFile,
  readMp4BoxOrder,
} from '../generation/media-store.ts';

export interface GateOutcome {
  gate: PublicationGateName;
  verdict: PublicationGateVerdict;
  /** Why, in KnowScroll's own words: what was compared and what was observed (migration 0014's own
   * CHECK requires an object here, and a `reason` key specifically for `unavailable`). */
  evidence: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// -------------------------------------------------------------------------------------------
// lineage_complete
// -------------------------------------------------------------------------------------------

export interface LineageCompleteInput {
  /** `generated_reel.lineage` as stored (already an object once node-pg parses the jsonb column). */
  lineage: unknown;
  /** `generation_brief.brief_sha256` for this reel's own brief row. */
  storedBriefSha256: string;
  /** `cutroom_attempt.contract_revision` / `run_id` for this reel's own attempt row. */
  attemptContractRevision: string;
  attemptRunId: string | null;
  /** The parsed brief, to re-verify every listed claim has a source. */
  brief: GenerationBrief;
}

export function evaluateLineageComplete(
  input: LineageCompleteInput,
): GateOutcome {
  const lineage = asRecord(input.lineage);
  const briefShaObserved = lineage?.briefSha256;
  const contractRevisionObserved = lineage?.contractRevision;
  const runIdObserved = lineage?.runId;
  const recordSummary = lineage?.recordSummary;

  const briefShaMatches = briefShaObserved === input.storedBriefSha256;
  const contractRevisionMatches =
    contractRevisionObserved === input.attemptContractRevision;
  const runIdMatches =
    input.attemptRunId !== null && runIdObserved === input.attemptRunId;
  const recordSummaryPresent =
    recordSummary !== undefined && recordSummary !== null;

  const listedClaimIds = input.brief.claims.map((claim) => claim.id);
  const sourcedClaimIds = new Set(
    input.brief.claimSources.map((source) => source.claimId),
  );
  const unsourcedClaims = listedClaimIds.filter(
    (id) => !sourcedClaimIds.has(id),
  );

  const evidence = {
    briefShaMatches,
    briefShaExpected: input.storedBriefSha256,
    briefShaObserved: briefShaObserved ?? null,
    contractRevisionMatches,
    contractRevisionExpected: input.attemptContractRevision,
    contractRevisionObserved: contractRevisionObserved ?? null,
    runIdMatches,
    runIdExpected: input.attemptRunId,
    runIdObserved: runIdObserved ?? null,
    recordSummaryPresent,
    unsourcedClaims,
  };
  const pass =
    briefShaMatches &&
    contractRevisionMatches &&
    runIdMatches &&
    recordSummaryPresent &&
    unsourcedClaims.length === 0;
  return {
    gate: 'lineage_complete',
    verdict: pass ? 'pass' : 'fail',
    evidence,
  };
}

// -------------------------------------------------------------------------------------------
// source_support
// -------------------------------------------------------------------------------------------

export interface AssetSourceCheck {
  assetId: string;
  expectedRevision: number;
  claimIds: string[];
  assetExists: boolean;
  currentRevision: number | null;
  unchanged: boolean;
}

export interface SourceSupportInput {
  brief: GenerationBrief;
  /** One entry per distinct (assetId, assetRevision) the brief's claimSources name — the
   * brief schema requires exactly one, but the gate does not assume that structurally. */
  sourceChecks: AssetSourceCheck[];
}

export function evaluateSourceSupport(input: SourceSupportInput): GateOutcome {
  const sentencesWithoutClaim = input.brief.narration
    .map((sentence, index) => ({
      index,
      sourced: sentence.claimIds.length > 0,
    }))
    .filter((entry) => !entry.sourced)
    .map((entry) => entry.index);
  const allSourcesUnchanged = input.sourceChecks.every(
    (check) => check.assetExists && check.unchanged,
  );
  const evidence = {
    sentenceCount: input.brief.narration.length,
    sentencesWithoutClaim,
    sourceChecks: input.sourceChecks,
  };
  const pass = sentencesWithoutClaim.length === 0 && allSourcesUnchanged;
  return { gate: 'source_support', verdict: pass ? 'pass' : 'fail', evidence };
}

// -------------------------------------------------------------------------------------------
// engine_record
// -------------------------------------------------------------------------------------------

interface RunRecordTakeLike {
  takeId?: unknown;
  shotId?: unknown;
  used?: unknown;
  checks?: unknown;
}
interface RunRecordLike {
  takes?: unknown;
  degradations?: unknown;
}

export interface EngineRecordInput {
  /** `cutroom_attempt.record_summary` as stored (Cutroom's own `RunRecord`, or null/absent when
   * the record fetch never succeeded — ADR-0023 section 3 allows a finished run to import without
   * one, so this gate must be able to fail closed on that case rather than assume it exists). */
  recordSummary: unknown;
}

export function evaluateEngineRecord(input: EngineRecordInput): GateOutcome {
  const record = asRecord(input.recordSummary) as RunRecordLike | null;
  if (!record || !Array.isArray(record.takes)) {
    return {
      gate: 'engine_record',
      verdict: 'fail',
      evidence: { recordSummaryPresent: false },
    };
  }
  const takes = record.takes as RunRecordTakeLike[];
  const usedTakes = takes.filter((take) => take.used === true);
  const failingUsedTakes = usedTakes
    .filter(
      (take) =>
        Array.isArray(take.checks) &&
        (take.checks as Array<{ outcome?: unknown }>).some(
          (check) => check.outcome === 'fail',
        ),
    )
    .map((take) => ({
      takeId: take.takeId,
      shotId: take.shotId,
      failingChecks: (
        take.checks as Array<{ gate?: unknown; outcome?: unknown }>
      ).filter((check) => check.outcome === 'fail'),
    }));
  const degradations = Array.isArray(record.degradations)
    ? record.degradations
    : [];
  const evidence = {
    recordSummaryPresent: true,
    usedTakeCount: usedTakes.length,
    failingUsedTakes,
    degradationCount: degradations.length,
    degradations,
  };
  if (failingUsedTakes.length > 0)
    return { gate: 'engine_record', verdict: 'fail', evidence };
  if (degradations.length > 0)
    return { gate: 'engine_record', verdict: 'pass_with_label', evidence };
  return { gate: 'engine_record', verdict: 'pass', evidence };
}

// -------------------------------------------------------------------------------------------
// media_conformance
// -------------------------------------------------------------------------------------------

// Re-checks the profile import enforced, using import's own constants (`media-profile.ts`), so a
// profile change moves this gate with it. Reason codes and checks below are this gate's own.
const ASPECT_TARGET = MEDIA_PROFILE.aspectTarget;
const ASPECT_TOLERANCE_RATIO = MEDIA_PROFILE.aspectToleranceRatio;
const MIN_DURATION_SECONDS = MEDIA_PROFILE.minDurationSeconds;
const MAX_DURATION_SECONDS = MEDIA_PROFILE.maxDurationSeconds;

function withinAspectTolerance(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const ratio = width / height;
  return (
    Math.abs(ratio - ASPECT_TARGET) <= ASPECT_TARGET * ASPECT_TOLERANCE_RATIO
  );
}

interface ReprobeResult {
  ok: boolean;
  reason?: string;
  details: Record<string, unknown>;
}

async function reprobeAgainstRequiredProfile(
  path: string,
): Promise<ReprobeResult> {
  const data = await ffprobeJson(path);
  if (!data || !data.format)
    return { ok: false, reason: 'probe_failed', details: {} };
  const formatName = data.format.format_name ?? '';
  const majorBrand = data.format.tags?.major_brand?.trim() ?? null;
  const looksLikeMp4 =
    formatName.split(',').includes('mp4') && majorBrand !== 'qt';
  if (!looksLikeMp4)
    return {
      ok: false,
      reason: 'not_mp4',
      details: { formatName, majorBrand },
    };

  const streams = data.streams ?? [];
  const video = streams.find((entry) => entry.codec_type === 'video');
  if (!video) return { ok: false, reason: 'missing_video_stream', details: {} };
  if (video.codec_name !== 'h264')
    return {
      ok: false,
      reason: 'video_codec_not_h264',
      details: { videoCodec: video.codec_name },
    };
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (!withinAspectTolerance(width, height))
    return {
      ok: false,
      reason: 'aspect_ratio_not_9_16',
      details: { width, height },
    };

  const audio = streams.find((entry) => entry.codec_type === 'audio');
  if (audio && audio.codec_name !== 'aac')
    return {
      ok: false,
      reason: 'audio_codec_not_aac',
      details: { audioCodec: audio.codec_name },
    };

  const durationSeconds =
    data.format.duration !== undefined ? Number(data.format.duration) : NaN;
  if (!Number.isFinite(durationSeconds))
    return { ok: false, reason: 'duration_unreadable', details: {} };
  if (
    durationSeconds < MIN_DURATION_SECONDS ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    return {
      ok: false,
      reason: 'duration_out_of_range',
      details: { durationSeconds },
    };
  }

  const boxOrder = await readMp4BoxOrder(path);
  const progressive =
    boxOrder.moovOffset !== null &&
    (boxOrder.mdatOffset === null || boxOrder.moovOffset < boxOrder.mdatOffset);
  if (!progressive)
    return { ok: false, reason: 'not_progressive', details: { boxOrder } };

  return {
    ok: true,
    details: {
      formatName,
      majorBrand,
      width,
      height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      durationSeconds,
      progressive,
    },
  };
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) =>
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

export interface MediaConformanceInput {
  mediaRoot: string;
  media: { sha256: string; byteSize: number; storageKey: string };
}

export async function evaluateMediaConformance(
  input: MediaConformanceInput,
): Promise<GateOutcome> {
  const absolutePath = join(input.mediaRoot, input.media.storageKey);
  const kind = await checkRegularFile(absolutePath);
  if (!kind.ok) {
    return {
      gate: 'media_conformance',
      verdict: 'fail',
      evidence: {
        fileExists: false,
        storageKey: input.media.storageKey,
        reason: kind.reason,
      },
    };
  }
  let observedHash: string;
  try {
    observedHash = await hashFile(absolutePath);
  } catch (error) {
    return {
      gate: 'media_conformance',
      verdict: 'fail',
      evidence: {
        fileExists: true,
        hashError: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const hashMatches = observedHash === input.media.sha256;
  const sizeMatches = kind.sizeBytes === input.media.byteSize;
  const probe = await reprobeAgainstRequiredProfile(absolutePath);
  const evidence = {
    fileExists: true,
    hashMatches,
    sizeMatches,
    observedSize: kind.sizeBytes,
    expectedSize: input.media.byteSize,
    observedHash,
    expectedHash: input.media.sha256,
    probeOk: probe.ok,
    probeReason: probe.reason ?? null,
    probeDetails: probe.details,
  };
  const pass = hashMatches && sizeMatches && probe.ok;
  return {
    gate: 'media_conformance',
    verdict: pass ? 'pass' : 'fail',
    evidence,
  };
}

// -------------------------------------------------------------------------------------------
// truth_label
// -------------------------------------------------------------------------------------------

export function evaluateTruthLabel(input: {
  truthState: string;
  generatedLabel: boolean;
}): GateOutcome {
  const pass =
    input.truthState === 'synthesis' && input.generatedLabel === true;
  return {
    gate: 'truth_label',
    verdict: pass ? 'pass' : 'fail',
    evidence: {
      truthState: input.truthState,
      generatedLabel: input.generatedLabel,
    },
  };
}

// -------------------------------------------------------------------------------------------
// repetition — fingerprints and the corpus check
// -------------------------------------------------------------------------------------------

/** Deterministic canonical JSON (sorted object keys), so the same structure always fingerprints
 * the same way regardless of key insertion order. Mirrors `storage.ts`'s own `canonical()`. */
function canonicalJson(value: unknown): string {
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
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The "coat": shape independent of subject matter — how many claims each narration beat carries,
 * what roles the claims play, what kinds of criteria are used, and which style contract. Two
 * briefs about entirely different topics that share this shape are flagged as the same template
 * (14-QUALITY-ANTI-SLOP.md's "repetitive structure and pacing across uploads").
 */
export function computeTemplateFingerprint(brief: GenerationBrief): string {
  const shape = {
    narrationClaimCounts: brief.narration.map(
      (sentence) => sentence.claimIds.length,
    ),
    claimRoles: [...brief.claims.map((claim) => claim.role)].sort(),
    mustShowTypes: [
      ...brief.criteria.mustShow.map((criterion) => criterion.type),
    ].sort(),
    mustNotShowTypes: [
      ...brief.criteria.mustNotShow.map((criterion) => criterion.type),
    ].sort(),
    depictionPolicyVersion: brief.criteria.depictionPolicyVersion,
    styleId: brief.style.id,
    styleVersion: brief.style.version,
    planVaryOn: brief.planVaryOn ?? null,
  };
  return createHash('sha256').update(canonicalJson(shape)).digest('hex');
}

/**
 * The "argument": what is actually being claimed — which source material and (as exact,
 * normalized text; this deterministic slice has no semantic/paraphrase model) which narration.
 * Two briefs in a different structural coat that share this are flagged as the same argument.
 */
export function computeArgumentFingerprint(brief: GenerationBrief): string {
  const shape = {
    worldId: brief.worldId,
    sources: [
      ...new Set(
        brief.claimSources.map(
          (source) => `${source.assetId}@${source.assetRevision}`,
        ),
      ),
    ].sort(),
    narrationText: brief.narration
      .map((sentence) => normalizeText(sentence.text))
      .sort(),
  };
  return createHash('sha256').update(canonicalJson(shape)).digest('hex');
}

interface RepetitionCorpusEntry {
  generatedReelId: string;
  templateFingerprint: string | null;
  argumentFingerprint: string | null;
}

export interface RepetitionInput {
  templateFingerprint: string;
  argumentFingerprint: string;
  /** Every other already-fingerprinted generated Reel (this reel's own row excluded). An empty
   * corpus passes trivially, exactly as ADR-0024 section 2 requires. */
  corpus: RepetitionCorpusEntry[];
}

export function evaluateRepetition(input: RepetitionInput): GateOutcome {
  const templateMatches = input.corpus
    .filter((entry) => entry.templateFingerprint === input.templateFingerprint)
    .map((entry) => entry.generatedReelId);
  const argumentMatches = input.corpus
    .filter((entry) => entry.argumentFingerprint === input.argumentFingerprint)
    .map((entry) => entry.generatedReelId);
  const evidence = {
    templateFingerprint: input.templateFingerprint,
    argumentFingerprint: input.argumentFingerprint,
    corpusSize: input.corpus.length,
    templateMatches,
    argumentMatches,
  };
  const pass = templateMatches.length === 0 && argumentMatches.length === 0;
  return { gate: 'repetition', verdict: pass ? 'pass' : 'fail', evidence };
}

// -------------------------------------------------------------------------------------------
// witness_alignment
// -------------------------------------------------------------------------------------------

export function evaluateWitnessAlignment(): GateOutcome {
  return {
    gate: 'witness_alignment',
    verdict: 'unavailable',
    evidence: {
      reason:
        'No Visual Witness model exists in this deployment; ADR-0024 section 2 keeps this gate unavailable, and therefore eligibility structurally blocked, until one is implemented and authorized.',
    },
  };
}

// -------------------------------------------------------------------------------------------
// witness_alignment under publication-v2: engine-attested
// -------------------------------------------------------------------------------------------

/** The policy version whose witness is Cutroom's own per-shot checks (#199). */
export const ENGINE_ATTESTED_POLICY = 'publication-v2';

type CheckLike = { gate?: unknown; step?: unknown; outcome?: unknown };
type PictureLike = {
  pictureId?: unknown;
  shotId?: unknown;
  chosen?: unknown;
  observationId?: unknown;
  checks?: unknown;
};

const ACCEPTED = new Set(['accept', 'accept_with_label']);

function checksOf(value: unknown): CheckLike[] {
  return Array.isArray(value) ? (value as CheckLike[]) : [];
}
function passedGates(checks: CheckLike[]): string[] {
  return [
    ...new Set(
      checks
        .filter((check) => ACCEPTED.has(String(check.outcome)))
        .map((check) => String(check.gate)),
    ),
  ];
}

/**
 * Every picture Cutroom chose must have passed its Gate 1 (the picture shows every `mustShow` and
 * no `mustNotShow` criterion), and every take it used must have passed Gate 4 (the witness: the take
 * shows what its picture was meant to show) and Gate 5 (the take matches the narration and the
 * criteria). None of them may carry a failed check, and the Reel must use at least one take. Gate 7
 * (the cut) is implied: a run that fails it stops and is never imported. What the witness *saw* is
 * not on the wire, so the evidence names the checks and their observation ids, not the sight.
 */
export function evaluateEngineAttestedWitness(input: {
  recordSummary: unknown;
}): GateOutcome {
  const record = asRecord(input.recordSummary);
  const pictures = (
    record && Array.isArray(record.pictures) ? record.pictures : []
  ) as PictureLike[];
  const takes = (
    record && Array.isArray(record.takes) ? record.takes : []
  ) as RunRecordTakeLike[];
  const chosen = pictures.filter((picture) => picture.chosen === true);
  const used = takes.filter((take) => take.used === true);
  const problems: Record<string, unknown>[] = [];
  const shots = [
    ...chosen.map((picture) => {
      const checks = checksOf(picture.checks);
      const gates = passedGates(checks);
      if (!gates.includes('1'))
        problems.push({ pictureId: picture.pictureId, missing: 'gate 1' });
      if (checks.some((check) => check.outcome === 'fail'))
        problems.push({ pictureId: picture.pictureId, failed: true });
      return {
        kind: 'picture',
        id: picture.pictureId,
        shotId: picture.shotId,
        gates,
        observationId: picture.observationId ?? null,
      };
    }),
    ...used.map((take) => {
      const checks = checksOf(take.checks);
      const gates = passedGates(checks);
      for (const gate of ['4', '5'])
        if (!gates.includes(gate))
          problems.push({ takeId: take.takeId, missing: `gate ${gate}` });
      if (checks.some((check) => check.outcome === 'fail'))
        problems.push({ takeId: take.takeId, failed: true });
      return {
        kind: 'take',
        id: take.takeId,
        shotId: take.shotId,
        gates,
        observationId:
          (take as { observationId?: unknown }).observationId ?? null,
      };
    }),
  ];
  if (!record) problems.push({ recordSummaryPresent: false });
  else if (used.length === 0) problems.push({ usedTakeCount: 0 });
  const evidence = {
    attestation: 'engine-attested, not independent',
    policy: ENGINE_ATTESTED_POLICY,
    checkedBy: 'Cutroom (the engine that made this Reel)',
    shots,
    problems,
  };
  return {
    gate: 'witness_alignment',
    verdict: problems.length === 0 ? 'pass_with_label' : 'fail',
    evidence,
  };
}
