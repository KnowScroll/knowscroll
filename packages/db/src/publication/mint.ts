/**
 * Inventory Reel-asset mint and withdrawal SQL (ADR-0025 section 1). The typed refusals live in the
 * worker; migration 0015's triggers (`asset_reel_provenance_guard`, `asset_identity_guard`) are the
 * real guards, so statement order here must not change.
 */
import type pg from 'pg';
import { lockSubstrateShared } from '../semantic/read-set.ts';
import { annotateReelsOver } from '../semantic/seed.ts';

export interface MintReelRow {
  id: string;
  brief_id: string;
  availability: string;
  media_sha256: string;
  provider_mode: string;
  truth_state: string;
}

export async function selectMintReel(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<MintReelRow | undefined> {
  return (
    await pool.query<MintReelRow>(
      `
        SELECT
          id,
          brief_id,
          availability,
          media_sha256,
          provider_mode,
          truth_state
        FROM
          generated_reel
        WHERE
          id = $1
      `,
      [generatedReelId],
    )
  ).rows[0];
}

export async function selectAssetIdForReel(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<{ id: string } | undefined> {
  return (
    await pool.query<{ id: string }>(
      'SELECT id FROM asset WHERE generated_reel_id=$1',
      [generatedReelId],
    )
  ).rows[0];
}

export async function selectMintBrief(
  pool: pg.Pool,
  briefId: string,
): Promise<{ brief: unknown; source_asset_id: string } | undefined> {
  return (
    await pool.query<{ brief: unknown; source_asset_id: string }>(
      'SELECT brief, source_asset_id FROM generation_brief WHERE id=$1',
      [briefId],
    )
  ).rows[0];
}

/** Read-back after losing the insert race to a concurrent minter. */
export async function selectWinningAssetForReel(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<{ id: string } | undefined> {
  return (
    await pool.query<{ id: string }>(
      'SELECT id FROM asset WHERE generated_reel_id=$1',
      [generatedReelId],
    )
  ).rows[0];
}

export async function selectSourceAsset(
  pool: pg.Pool,
  sourceAssetId: string,
): Promise<{ title: string; url: string } | undefined> {
  return (
    await pool.query<{ title: string; url: string }>(
      'SELECT source_title AS title, source_url AS url FROM asset WHERE id=$1',
      [sourceAssetId],
    )
  ).rows[0];
}

/**
 * Owns its transaction (checks out its own client). Takes the shared substrate lock first (ADR-0043),
 * so a seed load that annotates the Scroll meanwhile either commits first (and is copied here) or
 * waits for this Reel (and copies to it). Returns `refused` with the raw error message for any
 * failure after the client was checked out; a failed checkout throws.
 */
export async function insertReelAsset(
  pool: pg.Pool,
  row: {
    assetId: string;
    title: string;
    summary: string;
    sourceTitle: string;
    sourceUrl: string;
    truthState: string;
    mediaSha256: string;
    generatedReelId: string;
    simulated: boolean;
    sourceAssetId: string;
  },
): Promise<
  | { kind: 'done'; rowCount: number | null }
  | { kind: 'refused'; message: string }
> {
  const client = await pool.connect();
  let inserted;
  try {
    await client.query('BEGIN');
    await lockSubstrateShared(client);
    inserted = await client.query<{ id: string }>(
      `
        INSERT INTO
          asset (
            id,
            revision,
            kind,
            title,
            summary,
            body,
            source_title,
            source_url,
            truth_state,
            editorial_order,
            media_sha256,
            generated_reel_id,
            simulated
          )
        VALUES
          (
            $1,
            1,
            'Reel',
            $2,
            $3,
            '',
            $4,
            $5,
            $6,
            NULL,
            $7,
            $8,
            $9
          )
        ON CONFLICT (generated_reel_id) DO NOTHING
        RETURNING
          id
      `,
      [
        row.assetId,
        row.title,
        row.summary,
        row.sourceTitle,
        row.sourceUrl,
        row.truthState,
        row.mediaSha256,
        row.generatedReelId,
        row.simulated,
      ],
    );
    // ADR-0043: a Reel is about what its one source Scroll is about, so it carries that Scroll's
    // concepts with the same roles, in the transaction that mints it.
    if (inserted.rowCount === 1)
      await annotateReelsOver(client, row.sourceAssetId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return {
      kind: 'refused',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
  return { kind: 'done', rowCount: inserted.rowCount };
}

/**
 * Owns its transaction. Locks the generated Reel row `FOR UPDATE`. Stamps the asset's `withdrawn_at`
 * BEFORE moving the Reel to `withdrawn`: `asset_reel_provenance_guard` re-checks the source Reel's
 * availability on every update to a Reel asset row, so the reverse order would be refused.
 */
export async function withdrawReelAndAsset(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<{ kind: 'unknown_reel' } | { kind: 'done'; withdrawn: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reel = (
      await client.query<{ availability: string }>(
        'SELECT availability FROM generated_reel WHERE id=$1 FOR UPDATE',
        [generatedReelId],
      )
    ).rows[0];
    if (!reel) {
      await client.query('ROLLBACK').catch(() => {});
      return { kind: 'unknown_reel' };
    }
    if (
      reel.availability !== 'eligible' &&
      reel.availability !== 'test_eligible'
    ) {
      await client.query('ROLLBACK');
      return { kind: 'done', withdrawn: false };
    }
    await client.query(
      `UPDATE asset SET withdrawn_at=clock_timestamp() WHERE generated_reel_id=$1 AND withdrawn_at IS NULL`,
      [generatedReelId],
    );
    await client.query(
      `UPDATE generated_reel SET availability='withdrawn' WHERE id=$1`,
      [generatedReelId],
    );
    await client.query('COMMIT');
    return { kind: 'done', withdrawn: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
