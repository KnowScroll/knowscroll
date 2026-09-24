/**
 * ADR-0025 section 1 — minting an inventory `asset` of kind `Reel` from a `generated_reel` whose
 * gates have already decided `eligible` or `test_eligible`, and withdrawing it in step with the
 * Reel's own withdrawal.
 *
 * This is a deliberately separate, explicitly-invoked step — not an automatic side effect wired
 * into `evaluate.ts`'s `decideAvailability` — for a concrete reason: `evaluatePublicationGates` is
 * exercised by `tests/publication-gates.test.ts` and `tests/publication-http.test.ts` against briefs
 * that predate this slice's optional `title`/`summary` fields (see `generation.ts`), reaching
 * `test_eligible` there today. Hooking minting into that shared decision path would either silently
 * skip minting for those pre-existing fixtures or throw a defect neither test expects — a
 * regression this lane must not cause. Minting is instead its own named step: run it (via the CLI
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
import { generationBrief } from '../../../../packages/contracts/src/generation.ts';

export class MintError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MintError';
  }
}

export interface MintOutcome {
  assetId: string;
  /** False when an asset for this generated Reel already existed (idempotent replay). */
  created: boolean;
}

interface ReelRow {
  id: string;
  brief_id: string;
  availability: string;
  media_sha256: string;
  provider_mode: string;
  truth_state: string;
}

/**
 * Idempotent per generated Reel: a second call finds the existing asset and returns it unchanged,
 * inserting nothing. Refuses (typed) a Reel that has not cleared its gates, or whose brief carries
 * no `title`/`summary` to display — never invents either from the engine's own record.
 */
export async function mintReelAsset(pool: pg.Pool, generatedReelId: string): Promise<MintOutcome> {
  const reel = (await pool.query<ReelRow>(
    `SELECT id, brief_id, availability, media_sha256, provider_mode, truth_state
     FROM generated_reel WHERE id=$1`,
    [generatedReelId],
  )).rows[0];
  if (!reel) throw new MintError('unknown_reel', `No generated Reel with id ${generatedReelId}`);

  const existing = (await pool.query<{ id: string }>(
    'SELECT id FROM asset WHERE generated_reel_id=$1', [generatedReelId],
  )).rows[0];
  if (existing) return { assetId: existing.id, created: false };

  if (reel.availability !== 'eligible' && reel.availability !== 'test_eligible') {
    throw new MintError('not_gated', `Generated Reel ${generatedReelId} is "${reel.availability}", not eligible or test_eligible`);
  }

  const briefRow = (await pool.query<{ brief: unknown; source_asset_id: string }>(
    'SELECT brief, source_asset_id FROM generation_brief WHERE id=$1', [reel.brief_id],
  )).rows[0];
  if (!briefRow) throw new MintError('defect', 'generated_reel references a missing generation_brief');
  const brief = generationBrief.parse(briefRow.brief);
  if (brief.title === undefined || brief.summary === undefined) {
    throw new MintError('brief_missing_display_text', 'This brief carries no title/summary to mint an inventory asset from');
  }

  const source = (await pool.query<{ title: string; url: string }>(
    'SELECT source_title AS title, source_url AS url FROM asset WHERE id=$1', [briefRow.source_asset_id],
  )).rows[0];
  if (!source) throw new MintError('defect', 'generation_brief references a missing source asset');

  const assetId = randomUUID();
  const simulated = reel.provider_mode === 'standin';
  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');
    inserted = await client.query<{ id: string }>(
      `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order,
                          media_sha256,generated_reel_id,simulated)
       VALUES($1,1,'Reel',$2,$3,'',$4,$5,$6,NULL,$7,$8,$9)
       ON CONFLICT (generated_reel_id) DO NOTHING
       RETURNING id`,
      [assetId, brief.title, brief.summary, source.title, source.url, reel.truth_state, reel.media_sha256, generatedReelId, simulated],
    );
    // ADR-0043: a Reel is about what its one source Scroll is about, so it carries that Scroll's
    // concepts with the same roles, in the transaction that mints it. Not its claims: a Reel may
    // state only some of them.
    if (inserted.rowCount === 1) {
      await client.query(
        'INSERT INTO asset_concept(asset_id,concept_id,role) SELECT $1, concept_id, role FROM asset_concept WHERE asset_id=$2',
        [assetId, briefRow.source_asset_id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new MintError('mint_refused', error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
  }
  if (inserted.rowCount === 1) return { assetId, created: true };
  // Lost a race to a concurrent minter for the same generated Reel: return the row that won.
  const winner = (await pool.query<{ id: string }>('SELECT id FROM asset WHERE generated_reel_id=$1', [generatedReelId])).rows[0]!;
  return { assetId: winner.id, created: false };
}

/**
 * Withdraws a generated Reel and, in the same transaction, its minted asset (if any exists). A
 * Reel not currently `eligible`/`test_eligible` is left alone (`withdrawn: false`) rather than
 * silently re-stamping an already-withdrawn/rejected row — migration 0014's own guard refuses that
 * reversal anyway. Never deletes the asset (migration 0015 forbids it structurally); only sets
 * `withdrawn_at` once.
 */
export async function withdrawGeneratedReel(pool: pg.Pool, generatedReelId: string): Promise<{ withdrawn: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reel = (await client.query<{ availability: string }>(
      'SELECT availability FROM generated_reel WHERE id=$1 FOR UPDATE', [generatedReelId],
    )).rows[0];
    if (!reel) throw new MintError('unknown_reel', `No generated Reel with id ${generatedReelId}`);
    if (reel.availability !== 'eligible' && reel.availability !== 'test_eligible') {
      await client.query('ROLLBACK');
      return { withdrawn: false };
    }
    // Order matters: `asset_reel_provenance_guard` re-checks the source Reel's availability on
    // EVERY update to a Reel asset row, not only at insert. Stamping `withdrawn_at` while the
    // generated Reel is still eligible/test_eligible must happen BEFORE moving the Reel itself to
    // `withdrawn`, or that same trigger would refuse the asset update it is meant to allow.
    await client.query(
      `UPDATE asset SET withdrawn_at=clock_timestamp() WHERE generated_reel_id=$1 AND withdrawn_at IS NULL`,
      [generatedReelId],
    );
    await client.query(`UPDATE generated_reel SET availability='withdrawn' WHERE id=$1`, [generatedReelId]);
    await client.query('COMMIT');
    return { withdrawn: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
