import { sql } from 'kysely';
import { z } from 'zod';
import type { PersonalScopeTx } from '../../identity/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { ASSESSMENT_LIFETIME_MS } from '../domain/buffer.js';
import { poolWith, type JevPool } from '../domain/jev-pool.js';
import type { ReadJevPool, StoreJevAssessments } from '../application/ports.js';

const EntriesSchema = z.array(
  z.strictObject({
    subject: z.string(),
    assetId: z.string(),
    assetRevision: z.number().int().min(1),
    relevance: z.number().min(0).max(1),
    appropriateness: z.number().min(0).max(1),
    redundancy: z.number().min(0).max(1),
    assessedAt: z.iso.datetime(),
  }),
);

interface PoolRow {
  readonly role_version: string;
  readonly model: string;
  readonly entries: unknown;
}

/** The person's pool of the current privacy epoch; a row left by an earlier epoch is not theirs to use. */
const readJevPool: ReadJevPool = async (scope) => {
  const { universeId, privacyEpoch } = scope.authority;
  const rows = await sql<PoolRow>`select role_version,model,entries from composer.jev_assessments
    where universe_id=${universeId}::uuid and privacy_epoch=${privacyEpoch}`.execute(transactionOf(scope));
  const row = rows.rows[0];
  if (!row) return undefined;
  return { roleVersion: row.role_version, model: row.model, entries: EntriesSchema.parse(row.entries) };
};

/** Merges `added` into the person's row (one row per universe) under the caller's personal lock. */
const storeJevAssessments: StoreJevAssessments = async (scope, added, now) => {
  const { universeId, privacyEpoch } = scope.authority;
  const db = transactionOf(scope);
  const merged: JevPool = poolWith(await readJevPool(scope), added, now);
  if (merged.entries.length === 0) {
    await sql`delete from composer.jev_assessments where universe_id=${universeId}::uuid`.execute(db);
    return;
  }
  await sql`insert into composer.jev_assessments(universe_id,privacy_epoch,role_version,model,entries,updated_at)
    values(${universeId}::uuid,${privacyEpoch},${merged.roleVersion},${merged.model},${JSON.stringify(merged.entries)}::jsonb,${now.toISOString()}::timestamptz)
    on conflict(universe_id) do update set privacy_epoch=excluded.privacy_epoch, role_version=excluded.role_version,
      model=excluded.model, entries=excluded.entries, updated_at=excluded.updated_at`.execute(db);
};

/** Deletes the person's pool once every entry in it is past its life, so an idle person leaves no row behind. */
const purgeExpiredJevPool = async (scope: PersonalScopeTx, now: Date): Promise<void> => {
  await sql`delete from composer.jev_assessments where universe_id=${scope.authority.universeId}::uuid
    and not exists (
      select 1 from jsonb_array_elements(entries) entry
      where (entry->>'assessedAt')::timestamptz + make_interval(secs => ${ASSESSMENT_LIFETIME_MS / 1000}::double precision)
        > ${now.toISOString()}::timestamptz)`.execute(transactionOf(scope));
};

/**
 * The `composer.jev_assessments` store: the worker reads it when a preparation starts and merges into it when
 * it commits; the expired-row purge of the buffer store sweeps it.
 */
export const jevPoolStore = {
  read: readJevPool,
  store: storeJevAssessments,
  purgeExpired: purgeExpiredJevPool,
} as const;
