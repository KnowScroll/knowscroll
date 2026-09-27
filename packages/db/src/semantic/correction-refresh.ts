/**
 * #160 (ADR-0040) — a source correction reaches the reader's places while they are away.
 *
 * A correction changes shared knowledge at once, but a reader's places follow only at their next
 * personal-model refresh, and only their own actions run one. Every refresh records how much of the
 * append-only correction log it had seen (its row count, read at the refresh's start). A universe
 * that is not paused, has a live place and has seen fewer corrections than are committed is behind:
 * the worker refreshes it, a bounded batch at a time, longest-behind first, each in its own
 * transaction under its universe lock -- exactly the refresh the reader's next action would have
 * run. No model is called, and every change keeps the Cartographer's own cause (a sighting lost to
 * a correction is `source_correction`, so it is away news, ADR-0039).
 */
import type pg from 'pg';
import { lockUniverse, transaction } from '../index.ts';
import { CORRECTIONS_COMMITTED, refreshPersonalModel, type PersonalModelResult } from './personal-model.ts';

// Recording on, something a correction can change (a place on the map, or a Scroll bound to the
// reader's need, ADR-0046 §5), and a correction committed since the last refresh (or none recorded yet).
const BEHIND = `u.recording_paused_at IS NULL
  AND (EXISTS (SELECT 1 FROM atlas_place p WHERE p.universe_id = u.id AND p.state = 'live')
    OR EXISTS (SELECT 1 FROM encounter_binding b WHERE b.universe_id = u.id AND b.status = 'active'))
  AND (c.universe_id IS NULL OR c.corrections_seen < ${CORRECTIONS_COMMITTED})`;

/** Up to `limit` behind universes, longest-behind first: never recorded, then the oldest refresh.
 * `deferred` (the universes whose refresh failed last pass) go after everyone else: a failure
 * records nothing, so it would otherwise stay longest-behind and take the head of every batch. */
export async function findBehindUniverses(client: pg.Pool | pg.PoolClient, limit: number, deferred: readonly string[] = []): Promise<string[]> {
  return (await client.query<{ id: string }>(
    `SELECT u.id FROM universe u LEFT JOIN correction_catch_up c ON c.universe_id = u.id
     WHERE ${BEHIND} ORDER BY u.id = ANY($2::uuid[]), c.refreshed_at NULLS FIRST, u.id LIMIT $1`, [limit, deferred],
  )).rows.map(r => r.id);
}

/** Takes the universe lock, checks again that it is still behind (a reader's own action, or a pause,
 * may have come first), then refreshes it. Null when there was nothing to do. */
export async function catchUpUniverse(client: pg.PoolClient, universeId: string): Promise<PersonalModelResult | null> {
  await lockUniverse(client, universeId);
  const behind = (await client.query(
    `SELECT 1 FROM universe u LEFT JOIN correction_catch_up c ON c.universe_id = u.id WHERE u.id = $1 AND ${BEHIND}`, [universeId],
  )).rowCount;
  return behind ? refreshPersonalModel(client, universeId) : null;
}

/** A failed universe and what kind of error it was: a PostgreSQL error code or the error's name,
 * never its message (which may quote a row). */
export interface FailedCatchUp { universeId: string; error: string }
export interface CorrectionRefreshPass { refreshed: string[]; placeChanges: number; failed: FailedCatchUp[] }

/** One worker pass. A universe whose refresh fails is rolled back and named; it is still behind, so
 * it is taken again, after the others when the caller passes this pass's failures as `deferred`. */
export async function runCorrectionRefreshPass(pool: pg.Pool, opts: { limit: number; deferred?: readonly string[] }): Promise<CorrectionRefreshPass> {
  const pass: CorrectionRefreshPass = { refreshed: [], placeChanges: 0, failed: [] };
  for (const universeId of await findBehindUniverses(pool, opts.limit, opts.deferred)) {
    try {
      const result = await transaction(client => catchUpUniverse(client, universeId), pool);
      if (!result) continue;
      pass.refreshed.push(universeId);
      pass.placeChanges += result.places;
    } catch (error) {
      pass.failed.push({ universeId, error: (error as { code?: string }).code ?? (error as Error).name ?? 'unknown' });
    }
  }
  return pass;
}
