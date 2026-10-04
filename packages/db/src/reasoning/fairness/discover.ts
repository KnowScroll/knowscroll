// Reads the scheduler state and the head of the next ring without taking locks that a probe later needs.
// Only constant-size indexed reads happen here; the generation it records is advisory until probe re-checks it.
import type pg from 'pg';
import { FAIRNESS_CLASSES } from '../fairness-policy.ts';
import { decode, deny, readyColumns } from './shared.ts';
import type { Discovery, Lane, Ready, State, UniverseLane } from './types.ts';

/** Constant-size indexed probes; expired/ineligible heads are inspected, never
 * filtered through an unbounded scan before LIMIT. The generation is advisory.
 */
export async function discover(
  db: pg.Pool,
  version: string,
  inspectHead = true,
): Promise<Discovery> {
  const state = (
    await db.query<State>(
      'SELECT * FROM reasoning_fairness_scheduler WHERE policy_version=$1',
      [version],
    )
  ).rows[0];
  if (!state) return deny('fairness_policy_missing');
  const klass = FAIRNESS_CLASSES[state.class_cursor]!;
  const lane = (
    await db.query<Lane>(
      'SELECT * FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2',
      [version, klass],
    )
  ).rows[0];
  if (!lane) return deny('fairness_lane_missing');
  if (!inspectHead)
    return { state, lane, klass, universe: undefined, ready: undefined };
  let universe: UniverseLane | undefined;
  if (lane.open_universe_id)
    universe = (
      await db.query<UniverseLane>(
        `
   SELECT
     *
   FROM
     reasoning_fairness_universe
   WHERE
     policy_version = $1
     AND class = $2
     AND universe_id = $3
     AND ready_count > 0
 `,
        [version, klass, lane.open_universe_id],
      )
    ).rows[0];
  if (!universe && lane.universe_cursor)
    universe = (
      await db.query<UniverseLane>(
        `
   SELECT
     *
   FROM
     reasoning_fairness_universe
   WHERE
     policy_version = $1
     AND class = $2
     AND ready_count > 0
     AND universe_id > $3
   ORDER BY
     universe_id
   LIMIT
     1
 `,
        [version, klass, lane.universe_cursor],
      )
    ).rows[0];
  if (!universe)
    universe = (
      await db.query<UniverseLane>(
        `
   SELECT
     *
   FROM
     reasoning_fairness_universe
   WHERE
     policy_version = $1
     AND class = $2
     AND ready_count > 0
   ORDER BY
     universe_id
   LIMIT
     1
 `,
        [version, klass],
      )
    ).rows[0];
  let ready: Ready | undefined;
  if (universe) {
    const select = `SELECT ${readyColumns} FROM reasoning_fairness_ready r JOIN reasoning_job j ON j.id=r.job_id WHERE r.policy_version=$1 AND r.class=$2 AND r.universe_id=$3`;
    ready = (
      await db.query<Ready>(select + ' AND r.seq>$4 ORDER BY r.seq LIMIT 1', [
        version,
        klass,
        universe.universe_id,
        universe.candidate_cursor,
      ])
    ).rows[0];
    if (!ready)
      ready = (
        await db.query<Ready>(select + ' ORDER BY r.seq LIMIT 1', [
          version,
          klass,
          universe.universe_id,
        ])
      ).rows[0];
  }
  return {
    state,
    lane,
    klass,
    universe,
    ready: ready ? decode(ready) : undefined,
  };
}
