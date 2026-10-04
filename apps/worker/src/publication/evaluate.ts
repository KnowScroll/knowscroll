/**
 * ADR-0024 — the small runner around gates.ts: loads a generated Reel and everything its gates
 * need, records any not-yet-decided required gate's verdict (idempotent per (reel, policy, gate)
 * via the migration's own unique constraint), and derives an availability decision. Availability
 * is never set by hand: `decide:'auto'` only ever moves a Reel to `eligible`, and only once every
 * required gate has actually passed; `decide:'test_eligible'` asks for the stand-in fence, and the
 * database — not this function — is the final authority on whether that succeeds.
 */
import { randomUUID } from 'node:crypto';
import {
  type GenerationBrief,
  generationBrief,
} from '@knowscroll/contracts/generation';
import {
  insertGateResult,
  markEligible,
  markTestEligible,
  selectAssetRevision,
  selectBriefForGates,
  selectCutroomAttempt,
  selectFingerprintCorpus,
  selectGateResults,
  selectGeneratedReel,
  selectMediaObject,
  selectPolicyRequiredGates,
  selectWinningGateResult,
  stampFingerprints,
} from '@knowscroll/db/publication/evaluate';
import type pg from 'pg';
import type { GateOutcome } from './gates.ts';
import * as gates from './gates.ts';

export class PublicationEvaluationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicationEvaluationError';
  }
}

export interface EvaluatePublicationGatesInput {
  generatedReelId: string;
  policyVersion: string;
  /** KnowScroll's own media store root (deployment configuration; see apps/api/src/media/stream.ts and
   * apps/worker/src/generation/main.ts for the same KS_MEDIA_ROOT convention). */
  mediaRoot: string;
  /** Default 'auto': only ever moves 'imported' -> 'eligible', and only when every required gate
   * already passed. 'test_eligible' additionally asks for the stand-in fence; the database refuses
   * it outside a disposable knowscroll_test_* database or for a non-'standin' provider mode, and
   * that refusal is returned typed rather than thrown. */
  decide?: 'auto' | 'test_eligible';
}

interface GateResultRow {
  gate: string;
  verdict: string;
  evidence: unknown;
  decidedAt: string;
  /** False when this call found an already-recorded verdict instead of computing a new one
   * (idempotent re-evaluation), or when it lost a race to a concurrent evaluator. */
  newlyRecorded: boolean;
}

type AvailabilityOutcome =
  | { decided: true; availability: 'eligible' | 'test_eligible' }
  | { decided: false; current: string }
  | { decided: false; refused: string; detail: string };

export interface EvaluationOutcome {
  generatedReelId: string;
  policyVersion: string;
  gates: GateResultRow[];
  availability: AvailabilityOutcome;
}

interface LoadedContext {
  reel: {
    id: string;
    briefId: string;
    attemptId: string;
    mediaSha256: string;
    providerMode: string;
    truthState: string;
    generatedLabel: boolean;
    lineage: unknown;
    availability: string;
  };
  brief: GenerationBrief;
  briefSha256: string;
  attempt: {
    contractRevision: string;
    runId: string | null;
    recordSummary: unknown;
  };
  media: { byteSize: number; storageKey: string };
}

async function loadContext(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<LoadedContext> {
  const reelRow = await selectGeneratedReel(pool, generatedReelId);
  if (!reelRow)
    throw new PublicationEvaluationError(
      'unknown_reel',
      `No generated Reel with id ${generatedReelId}`,
    );

  const briefRow = await selectBriefForGates(pool, reelRow.brief_id);
  if (!briefRow)
    throw new PublicationEvaluationError(
      'defect',
      'generated_reel references a missing generation_brief',
    );
  const brief = generationBrief.parse(briefRow.brief);

  const attemptRow = await selectCutroomAttempt(pool, reelRow.attempt_id);
  if (!attemptRow)
    throw new PublicationEvaluationError(
      'defect',
      'generated_reel references a missing cutroom_attempt',
    );

  const mediaRow = await selectMediaObject(pool, reelRow.media_sha256);
  if (!mediaRow)
    throw new PublicationEvaluationError(
      'defect',
      'generated_reel references a missing media_object',
    );

  return {
    reel: {
      id: reelRow.id,
      briefId: reelRow.brief_id,
      attemptId: reelRow.attempt_id,
      mediaSha256: reelRow.media_sha256,
      providerMode: reelRow.provider_mode,
      truthState: reelRow.truth_state,
      generatedLabel: reelRow.generated_label,
      lineage: reelRow.lineage,
      availability: reelRow.availability,
    },
    brief,
    briefSha256: briefRow.brief_sha256,
    attempt: {
      contractRevision: attemptRow.contract_revision,
      runId: attemptRow.run_id,
      recordSummary: attemptRow.record_summary,
    },
    media: {
      byteSize: Number(mediaRow.byte_size),
      storageKey: mediaRow.storage_key,
    },
  };
}

async function loadSourceChecks(
  pool: pg.Pool,
  brief: GenerationBrief,
): Promise<gates.AssetSourceCheck[]> {
  const bySource = new Map<
    string,
    { assetId: string; expectedRevision: number; claimIds: string[] }
  >();
  for (const source of brief.claimSources) {
    const key = `${source.assetId}@${source.assetRevision}`;
    const entry = bySource.get(key) ?? {
      assetId: source.assetId,
      expectedRevision: source.assetRevision,
      claimIds: [],
    };
    entry.claimIds.push(source.claimId);
    bySource.set(key, entry);
  }
  const checks: gates.AssetSourceCheck[] = [];
  for (const entry of bySource.values()) {
    const row = await selectAssetRevision(pool, entry.assetId);
    checks.push({
      assetId: entry.assetId,
      expectedRevision: entry.expectedRevision,
      claimIds: entry.claimIds,
      assetExists: row !== undefined,
      currentRevision: row ? row.revision : null,
      unchanged: row !== undefined && row.revision === entry.expectedRevision,
    });
  }
  return checks;
}

async function computeGate(
  pool: pg.Pool,
  gateName: string,
  ctx: LoadedContext,
  mediaRoot: string,
): Promise<GateOutcome> {
  switch (gateName) {
    case 'lineage_complete':
      return gates.evaluateLineageComplete({
        lineage: ctx.reel.lineage,
        storedBriefSha256: ctx.briefSha256,
        attemptContractRevision: ctx.attempt.contractRevision,
        attemptRunId: ctx.attempt.runId,
        brief: ctx.brief,
      });
    case 'source_support': {
      const sourceChecks = await loadSourceChecks(pool, ctx.brief);
      return gates.evaluateSourceSupport({ brief: ctx.brief, sourceChecks });
    }
    case 'engine_record':
      return gates.evaluateEngineRecord({
        recordSummary: ctx.attempt.recordSummary,
      });
    case 'media_conformance':
      return gates.evaluateMediaConformance({
        mediaRoot,
        media: {
          sha256: ctx.reel.mediaSha256,
          byteSize: ctx.media.byteSize,
          storageKey: ctx.media.storageKey,
        },
      });
    case 'truth_label':
      return gates.evaluateTruthLabel({
        truthState: ctx.reel.truthState,
        generatedLabel: ctx.reel.generatedLabel,
      });
    case 'repetition': {
      const templateFingerprint = gates.computeTemplateFingerprint(ctx.brief);
      const argumentFingerprint = gates.computeArgumentFingerprint(ctx.brief);
      // Written once (migration 0014's own trigger enforces this); re-issuing the identical value
      // on a re-evaluation is a no-op as far as that trigger is concerned.
      await stampFingerprints(
        pool,
        ctx.reel.id,
        templateFingerprint,
        argumentFingerprint,
      );
      const corpus = (await selectFingerprintCorpus(pool, ctx.reel.id)).map(
        (row) => ({
          generatedReelId: row.generated_reel_id,
          templateFingerprint: row.template_fingerprint,
          argumentFingerprint: row.argument_fingerprint,
        }),
      );
      return gates.evaluateRepetition({
        templateFingerprint,
        argumentFingerprint,
        corpus,
      });
    }
    case 'witness_alignment':
      return gates.evaluateWitnessAlignment();
    default:
      throw new PublicationEvaluationError(
        'unknown_gate',
        `Publication policy names an unknown gate "${gateName}"`,
      );
  }
}

export async function evaluatePublicationGates(
  pool: pg.Pool,
  input: EvaluatePublicationGatesInput,
): Promise<EvaluationOutcome> {
  const policyRow = await selectPolicyRequiredGates(pool, input.policyVersion);
  if (!policyRow)
    throw new PublicationEvaluationError(
      'unknown_policy',
      `No publication policy named "${input.policyVersion}"`,
    );

  const ctx = await loadContext(pool, input.generatedReelId);

  const existing = await selectGateResults(
    pool,
    input.generatedReelId,
    input.policyVersion,
  );
  const decided = new Map(existing.map((row) => [row.gate, row]));

  const results: GateResultRow[] = [];
  for (const gateName of policyRow.required_gates) {
    const already = decided.get(gateName);
    if (already) {
      results.push({
        gate: gateName,
        verdict: already.verdict,
        evidence: already.evidence,
        decidedAt: already.decided_at.toISOString(),
        newlyRecorded: false,
      });
      continue;
    }
    const outcome = await computeGate(pool, gateName, ctx, input.mediaRoot);
    const inserted = await insertGateResult(pool, {
      id: randomUUID(),
      generatedReelId: input.generatedReelId,
      policyVersion: input.policyVersion,
      gate: gateName,
      verdict: outcome.verdict,
      evidenceJson: JSON.stringify(outcome.evidence),
    });
    if (inserted.rowCount === 1) {
      results.push({
        gate: gateName,
        verdict: outcome.verdict,
        evidence: outcome.evidence,
        decidedAt: inserted.decidedAt!.toISOString(),
        newlyRecorded: true,
      });
    } else {
      // Lost a race to a concurrent evaluator for the same (reel, policy, gate): read back the
      // verdict that actually won rather than pretend this call's own computation was recorded.
      const winner = (await selectWinningGateResult(
        pool,
        input.generatedReelId,
        input.policyVersion,
        gateName,
      ))!;
      results.push({
        gate: gateName,
        verdict: winner.verdict,
        evidence: winner.evidence,
        decidedAt: winner.decided_at.toISOString(),
        newlyRecorded: false,
      });
    }
  }

  const availability = await decideAvailability(
    pool,
    input,
    ctx.reel.availability,
    results,
  );
  return {
    generatedReelId: input.generatedReelId,
    policyVersion: input.policyVersion,
    gates: results,
    availability,
  };
}

async function decideAvailability(
  pool: pg.Pool,
  input: EvaluatePublicationGatesInput,
  currentAvailability: string,
  results: GateResultRow[],
): Promise<AvailabilityOutcome> {
  if (currentAvailability !== 'imported')
    return { decided: false, current: currentAvailability };

  if (input.decide === 'test_eligible') {
    try {
      const updated = await markTestEligible(
        pool,
        input.generatedReelId,
        input.policyVersion,
      );
      if (updated !== 1) return { decided: false, current: 'imported' };
      return { decided: true, availability: 'test_eligible' };
    } catch (error) {
      return {
        decided: false,
        refused: 'test_eligible_refused',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const blocking = results.some(
    (row) => row.verdict === 'fail' || row.verdict === 'unavailable',
  );
  if (blocking) return { decided: false, current: 'imported' };

  const updated = await markEligible(
    pool,
    input.generatedReelId,
    input.policyVersion,
  );
  if (updated !== 1) return { decided: false, current: 'imported' };
  return { decided: true, availability: 'eligible' };
}
