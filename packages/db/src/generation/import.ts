/**
 * The database half of verified import: `recordImportedReel` writes the `media_object` and
 * immutable `generated_reel` rows in one transaction. Migration 0013's own guards (unique
 * `attempt_id`, the lineage trigger) make a repeat call and a lineage mismatch both fail safely.
 * Needs the caller's client; owns its own BEGIN/COMMIT on it (ADR-0023 section 4).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface RecordedMedia {
  sha256: string;
  byteSize: number;
  /** The probe summary from a successful `importFinishedVideo` call; stored as `media_object.probe`. */
  probe: unknown;
  storageKey: string;
}

export interface GeneratedReelLineage {
  briefSha256: string;
  contractRevision: string;
  runId: string;
  /** e.g. Cutroom's own record summary: take/used counts and degradations. Never all attempts. */
  recordSummary: unknown;
}

export interface RecordImportedReelInput {
  attemptId: string;
  briefId: string;
  engineId: string;
  cutroomRunId: string;
  /** Must equal the engine's own declared provider mode; the lineage guard enforces this. */
  providerMode: 'standin' | 'live';
  /** The exact untrusted engine path the finished attempt's result declared for this video. */
  enginePath: string;
  media: RecordedMedia;
  lineage: GeneratedReelLineage;
}

export type RecordImportedReelOutcome =
  | { ok: true; generatedReelId: string; created: boolean }
  | { ok: false; reason: 'lineage_mismatch' };

const LINEAGE_ERROR_PATTERN = /lineage/i;

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
}

/**
 * Inserts `media_object` and the immutable `generated_reel` row in one transaction. Migration
 * 0013's `generated_reel_lineage_guard` trigger is the actual authority for whether this attempt,
 * job, brief, engine and provider mode line up; a rejection from that trigger is reported as
 * `lineage_mismatch` rather than a raw database error. The unique `attempt_id` is the fence: a
 * second call with the same `attemptId` finds the existing row (via `ON CONFLICT DO NOTHING`,
 * which still runs the lineage trigger first) and returns it with `created:false` instead of
 * erroring or inserting a duplicate.
 */
export async function recordImportedReel(
  client: pg.PoolClient,
  input: RecordImportedReelInput,
): Promise<RecordImportedReelOutcome> {
  assertNonEmptyString(input.attemptId, 'attemptId');
  assertNonEmptyString(input.briefId, 'briefId');
  assertNonEmptyString(input.engineId, 'engineId');
  assertNonEmptyString(input.cutroomRunId, 'cutroomRunId');
  assertNonEmptyString(input.enginePath, 'enginePath');
  if (input.providerMode !== 'standin' && input.providerMode !== 'live')
    throw new Error('providerMode must be "standin" or "live"');
  if (!/^[0-9a-f]{64}$/.test(input.media.sha256))
    throw new Error('media.sha256 must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(input.media.byteSize) || input.media.byteSize <= 0)
    throw new Error('media.byteSize must be a positive integer');

  const candidateId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO media_object(sha256,byte_size,content_type,probe,storage_key)
       VALUES($1,$2,'video/mp4',$3,$4)
       ON CONFLICT (sha256) DO NOTHING`,
      [
        input.media.sha256,
        input.media.byteSize,
        JSON.stringify(input.media.probe),
        input.media.storageKey,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO generated_reel(id,attempt_id,brief_id,engine_id,cutroom_run_id,media_sha256,engine_path,provider_mode,truth_state,generated_label,lineage)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthesis',true,$9)
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING id`,
      [
        candidateId,
        input.attemptId,
        input.briefId,
        input.engineId,
        input.cutroomRunId,
        input.media.sha256,
        input.enginePath,
        input.providerMode,
        JSON.stringify(input.lineage),
      ],
    );
    if (inserted.rowCount === 1) {
      await client.query('COMMIT');
      const row = inserted.rows[0];
      if (row === undefined)
        throw new Error('unreachable: rowCount was 1 with no row');
      return { ok: true, generatedReelId: row.id, created: true };
    }
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM generated_reel WHERE attempt_id=$1',
      [input.attemptId],
    );
    await client.query('COMMIT');
    const existingId = existing.rows[0]?.id;
    if (existingId === undefined)
      throw new Error(
        'generated_reel insert produced neither a new row nor an existing one for this attempt',
      );
    return { ok: true, generatedReelId: existingId, created: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof Error && LINEAGE_ERROR_PATTERN.test(error.message))
      return { ok: false, reason: 'lineage_mismatch' };
    throw error;
  }
}
