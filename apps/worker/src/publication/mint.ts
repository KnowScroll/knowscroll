/**
 * ADR-0025 section 1 — minting an inventory `asset` of kind `Reel` from a `generated_reel` whose
 * gates have already decided `eligible` or `test_eligible`, and withdrawing it in step with the
 * Reel's own withdrawal.
 *
 * This is a deliberately separate, explicitly-invoked step — not an automatic side effect wired
 * into `evaluate.ts`'s `decideAvailability` — for a concrete reason: `evaluatePublicationGates` is
 * exercised by `tests/publication-gates.test.ts` and `tests/publication-http.test.ts` against briefs
 * that predate the optional `title`/`summary` fields (see `generation.ts`), reaching
 * `test_eligible` there today. Hooking minting into that shared decision path would either silently
 * skip minting for those pre-existing fixtures or throw a defect neither test expects — a
 * regression. Minting is instead its own named step: run it (via the CLI
 * below, or a caller such as `scripts/run-inventory-journey.ts`) once availability has already been
 * decided elsewhere.
 *
 * Every guard that actually matters — a Reel asset needs a gated source Reel, must carry that
 * Reel's own media/truth-state/simulated provenance, is immutable once minted, and is never deleted
 * — is enforced by migration 0015's own triggers (`asset_reel_provenance_guard`,
 * `asset_identity_guard`). This module's own checks are a defensive, typed-error convenience layer
 * in front of those triggers; they mirror the same conditions and can never substitute for them.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { generationBrief } from '@knowscroll/contracts/generation';
import {
  insertReelAsset,
  selectAssetIdForReel,
  selectMintBrief,
  selectMintReel,
  selectSourceAsset,
  withdrawReelAndAsset,
} from '@knowscroll/db/publication/mint';

export class MintError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MintError';
  }
}

export interface MintOutcome {
  assetId: string;
  /** False when an asset for this generated Reel already existed (idempotent replay). */
  created: boolean;
}

/**
 * Idempotent per generated Reel: a second call finds the existing asset and returns it unchanged,
 * inserting nothing. Refuses (typed) a Reel that has not cleared its gates, or whose brief carries
 * no `title`/`summary` to display — never invents either from the engine's own record.
 */
export async function mintReelAsset(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<MintOutcome> {
  const reel = await selectMintReel(pool, generatedReelId);
  if (!reel)
    throw new MintError(
      'unknown_reel',
      `No generated Reel with id ${generatedReelId}`,
    );

  const existing = await selectAssetIdForReel(pool, generatedReelId);
  if (existing) return { assetId: existing.id, created: false };

  if (
    reel.availability !== 'eligible' &&
    reel.availability !== 'test_eligible'
  ) {
    throw new MintError(
      'not_gated',
      `Generated Reel ${generatedReelId} is "${reel.availability}", not eligible or test_eligible`,
    );
  }

  const briefRow = await selectMintBrief(pool, reel.brief_id);
  if (!briefRow)
    throw new MintError(
      'defect',
      'generated_reel references a missing generation_brief',
    );
  const brief = generationBrief.parse(briefRow.brief);
  if (brief.title === undefined || brief.summary === undefined) {
    throw new MintError(
      'brief_missing_display_text',
      'This brief carries no title/summary to mint an inventory asset from',
    );
  }

  const source = await selectSourceAsset(pool, briefRow.source_asset_id);
  if (!source)
    throw new MintError(
      'defect',
      'generation_brief references a missing source asset',
    );

  const assetId = randomUUID();
  const simulated = reel.provider_mode === 'standin';
  const inserted = await insertReelAsset(pool, {
    assetId,
    title: brief.title,
    summary: brief.summary,
    sourceTitle: source.title,
    sourceUrl: source.url,
    truthState: reel.truth_state,
    mediaSha256: reel.media_sha256,
    generatedReelId,
    simulated,
    sourceAssetId: briefRow.source_asset_id,
  });
  if (inserted.kind === 'refused')
    throw new MintError('mint_refused', inserted.message);
  if (inserted.rowCount === 1) return { assetId, created: true };
  // Lost a race to a concurrent minter for the same generated Reel: return the row that won.
  const winner = (await selectAssetIdForReel(pool, generatedReelId))!;
  return { assetId: winner.id, created: false };
}

/**
 * Withdraws a generated Reel and, in the same transaction, its minted asset (if any exists). A
 * Reel not currently `eligible`/`test_eligible` is left alone (`withdrawn: false`) rather than
 * silently re-stamping an already-withdrawn/rejected row — migration 0014's own guard refuses that
 * reversal anyway. Never deletes the asset (migration 0015 forbids it structurally); only sets
 * `withdrawn_at` once.
 */
export async function withdrawGeneratedReel(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<{ withdrawn: boolean }> {
  const outcome = await withdrawReelAndAsset(pool, generatedReelId);
  if (outcome.kind === 'unknown_reel')
    throw new MintError(
      'unknown_reel',
      `No generated Reel with id ${generatedReelId}`,
    );
  return { withdrawn: outcome.withdrawn };
}
