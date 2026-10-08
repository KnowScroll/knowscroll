/**
 * Reads and writes behind the publication gate runner (ADR-0024). Every function takes the pool and
 * runs one autocommit statement; the runner (`apps/worker/src/publication/evaluate.ts`) owns the
 * order of reads relative to gate checks, so do not batch or reorder these.
 */
import type pg from 'pg';

export interface GeneratedReelRow {
  id: string;
  brief_id: string;
  attempt_id: string;
  media_sha256: string;
  provider_mode: string;
  truth_state: string;
  generated_label: boolean;
  lineage: unknown;
  availability: string;
}

export interface GateResultDbRow {
  gate: string;
  verdict: string;
  evidence: unknown;
  decided_at: Date;
}

export async function selectGeneratedReel(
  pool: pg.Pool,
  generatedReelId: string,
): Promise<GeneratedReelRow | undefined> {
  return (
    await pool.query<GeneratedReelRow>(
      `
        SELECT
          id,
          brief_id,
          attempt_id,
          media_sha256,
          provider_mode,
          truth_state,
          generated_label,
          lineage,
          availability
        FROM
          generated_reel
        WHERE
          id = $1
      `,
      [generatedReelId],
    )
  ).rows[0];
}

export async function selectBriefForGates(
  pool: pg.Pool,
  briefId: string,
): Promise<{ brief: unknown; brief_sha256: string } | undefined> {
  return (
    await pool.query<{ brief: unknown; brief_sha256: string }>(
      'SELECT brief, brief_sha256 FROM generation_brief WHERE id=$1',
      [briefId],
    )
  ).rows[0];
}

export async function selectCutroomAttempt(
  pool: pg.Pool,
  attemptId: string,
): Promise<
  | {
      contract_revision: string;
      run_id: string | null;
      record_summary: unknown;
    }
  | undefined
> {
  return (
    await pool.query<{
      contract_revision: string;
      run_id: string | null;
      record_summary: unknown;
    }>(
      'SELECT contract_revision, run_id, record_summary FROM cutroom_attempt WHERE id=$1',
      [attemptId],
    )
  ).rows[0];
}

export async function selectMediaObject(
  pool: pg.Pool,
  mediaSha256: string,
): Promise<{ byte_size: string; storage_key: string } | undefined> {
  return (
    await pool.query<{ byte_size: string; storage_key: string }>(
      'SELECT byte_size, storage_key FROM media_object WHERE sha256=$1',
      [mediaSha256],
    )
  ).rows[0];
}

export async function selectAssetRevision(
  pool: pg.Pool,
  assetId: string,
): Promise<{ revision: number } | undefined> {
  return (
    await pool.query<{ revision: number }>(
      'SELECT revision FROM asset WHERE id=$1',
      [assetId],
    )
  ).rows[0];
}

/** Written once per Reel (migration 0014's trigger enforces it); re-issuing the identical value is a no-op. */
export async function stampFingerprints(
  pool: pg.Pool,
  generatedReelId: string,
  templateFingerprint: string,
  argumentFingerprint: string,
): Promise<void> {
  await pool.query(
    `
      UPDATE generated_reel
      SET
        template_fingerprint = $2,
        argument_fingerprint = $3
      WHERE
        id = $1
        AND template_fingerprint IS NULL
        AND argument_fingerprint IS NULL
    `,
    [generatedReelId, templateFingerprint, argumentFingerprint],
  );
}

export async function selectFingerprintCorpus(
  pool: pg.Pool,
  excludingReelId: string,
): Promise<
  {
    generated_reel_id: string;
    template_fingerprint: string | null;
    argument_fingerprint: string | null;
  }[]
> {
  return (
    await pool.query<{
      generated_reel_id: string;
      template_fingerprint: string | null;
      argument_fingerprint: string | null;
    }>(
      `
        SELECT
          id AS generated_reel_id,
          template_fingerprint,
          argument_fingerprint
        FROM
          generated_reel
        WHERE
          id <> $1
          AND (
            template_fingerprint IS NOT NULL
            OR argument_fingerprint IS NOT NULL
          )
      `,
      [excludingReelId],
    )
  ).rows;
}

export async function selectPolicyRequiredGates(
  pool: pg.Pool,
  policyVersion: string,
): Promise<{ required_gates: string[] } | undefined> {
  return (
    await pool.query<{ required_gates: string[] }>(
      'SELECT required_gates FROM publication_policy WHERE version=$1',
      [policyVersion],
    )
  ).rows[0];
}

export async function selectGateResults(
  pool: pg.Pool,
  generatedReelId: string,
  policyVersion: string,
): Promise<GateResultDbRow[]> {
  return (
    await pool.query<GateResultDbRow>(
      `
        SELECT
          gate,
          verdict,
          evidence,
          decided_at
        FROM
          publication_gate_result
        WHERE
          generated_reel_id = $1
          AND policy_version = $2
      `,
      [generatedReelId, policyVersion],
    )
  ).rows;
}

/** `rowCount` is 1 when this call recorded the verdict, 0 when a concurrent evaluator did first. */
export async function insertGateResult(
  pool: pg.Pool,
  row: {
    id: string;
    generatedReelId: string;
    policyVersion: string;
    gate: string;
    verdict: string;
    evidenceJson: string;
  },
): Promise<{ rowCount: number | null; decidedAt: Date | undefined }> {
  const inserted = await pool.query<{ decided_at: Date }>(
    `
      INSERT INTO
        publication_gate_result (
          id,
          generated_reel_id,
          policy_version,
          gate,
          verdict,
          evidence
        )
      VALUES
        ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (generated_reel_id, policy_version, gate) DO NOTHING
      RETURNING
        decided_at
    `,
    [
      row.id,
      row.generatedReelId,
      row.policyVersion,
      row.gate,
      row.verdict,
      row.evidenceJson,
    ],
  );
  return {
    rowCount: inserted.rowCount,
    decidedAt: inserted.rows[0]?.decided_at,
  };
}

export async function selectWinningGateResult(
  pool: pg.Pool,
  generatedReelId: string,
  policyVersion: string,
  gate: string,
): Promise<
  { verdict: string; evidence: unknown; decided_at: Date } | undefined
> {
  return (
    await pool.query<{
      verdict: string;
      evidence: unknown;
      decided_at: Date;
    }>(
      `
        SELECT
          verdict,
          evidence,
          decided_at
        FROM
          publication_gate_result
        WHERE
          generated_reel_id = $1
          AND policy_version = $2
          AND gate = $3
      `,
      [generatedReelId, policyVersion, gate],
    )
  ).rows[0];
}

/**
 * Asks for the stand-in fence. The database, not this function, decides: it throws outside a
 * disposable `knowscroll_test_*` database or for a non-'standin' provider mode, and the caller
 * returns that message typed.
 */
export async function markTestEligible(
  pool: pg.Pool,
  generatedReelId: string,
  policyVersion: string,
): Promise<number | null> {
  const updated = await pool.query(
    `
      UPDATE generated_reel
      SET
        availability = 'test_eligible',
        availability_policy_version = $2,
        availability_decided_at = clock_timestamp()
      WHERE
        id = $1
        AND availability = 'imported'
    `,
    [generatedReelId, policyVersion],
  );
  return updated.rowCount;
}

export async function markEligible(
  pool: pg.Pool,
  generatedReelId: string,
  policyVersion: string,
): Promise<number | null> {
  const updated = await pool.query(
    `
      UPDATE generated_reel
      SET
        availability = 'eligible',
        availability_policy_version = $2,
        availability_decided_at = clock_timestamp()
      WHERE
        id = $1
        AND availability = 'imported'
    `,
    [generatedReelId, policyVersion],
  );
  return updated.rowCount;
}

/** #199: real (Cutroom-made) Reels the worker still has to publish under `policyVersion`: imported
 * ones not yet judged under it, and ones already decided eligible but not yet minted. A Reel judged
 * and refused stays imported and is not offered again, so a refusal is never retried in a loop. */
export async function selectReelsToPublish(
  pool: pg.Pool,
  policyVersion: string,
  limit = 20,
): Promise<{ id: string; availability: string }[]> {
  return (
    await pool.query<{ id: string; availability: string }>(
      `
        SELECT
          g.id,
          g.availability
        FROM
          generated_reel g
        WHERE
          g.provider_mode = 'live'
          AND (
            (
              g.availability = 'imported'
              AND NOT EXISTS (
                SELECT
                  1
                FROM
                  publication_gate_result r
                WHERE
                  r.generated_reel_id = g.id
                  AND r.policy_version = $1
              )
            )
            OR (
              g.availability IN ('eligible', 'test_eligible')
              AND NOT EXISTS (
                SELECT
                  1
                FROM
                  asset a
                WHERE
                  a.generated_reel_id = g.id
              )
            )
          )
        ORDER BY
          g.created_at,
          g.id
        LIMIT
          $2
      `,
      [policyVersion, limit],
    )
  ).rows;
}
