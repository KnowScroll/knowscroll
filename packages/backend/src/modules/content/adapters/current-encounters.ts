import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { LockCurrentEncounters } from '../public.js';
import { readExactEncounter } from './discovery-store.js';

/** Lock once in canonical order, then re-read every head after any withdrawal/admission wait. */
export const lockCurrentEncounters: LockCurrentEncounters = async (scope, query) => {
  if (query.refs.length > 101 || query.refs.some((r) => !Number.isSafeInteger(r.assetRevision) || r.assetRevision < 1))
    throw new Error('CONTENT_CURRENT_QUERY_INVALID');
  const refs = [
    ...new Map(
      query.refs.map((r) => [
        `${r.assetId.toLowerCase()}:${r.assetRevision}`,
        { assetId: r.assetId.toLowerCase(), assetRevision: r.assetRevision },
      ]),
    ).values(),
  ].sort((a, b) => a.assetId.localeCompare(b.assetId) || a.assetRevision - b.assetRevision);
  if (!refs.length) return [];
  const rows = await sql<{
    id: string;
    revision: number;
    status: string;
    availability_revision: number;
    availability_changed_at: Date;
  }>`
    select id,revision,status,availability_revision,availability_changed_at from content.assets
    where id=any(${[...new Set(refs.map((r) => r.assetId))]}::uuid[]) order by id for share`.execute(
    transactionOf(scope),
  );
  const result: Awaited<ReturnType<LockCurrentEncounters>>[number][] = [];
  for (const ref of refs) {
    const row = rows.rows.find((r) => r.id === ref.assetId);
    if (!row) continue;
    if (!Number.isSafeInteger(row.availability_revision) || row.availability_revision < 1)
      throw new Error('CONTENT_AVAILABILITY_INVALID');
    const encounter =
      row.status === 'admitted' && row.revision === ref.assetRevision
        ? await readExactEncounter(scope, { ...ref, capabilities: query.capabilities })
        : undefined;
    result.push({
      ref,
      availabilityRevision: row.availability_revision,
      changedAt: row.availability_changed_at.toISOString(),
      ...(encounter ? { encounter } : {}),
    });
  }
  return result;
};
