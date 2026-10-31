import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { PlayLevel } from '../../content/public.js';
import type { FormatCell } from '../application/context-ports.js';

/** One exposure's counts for a topic, and the play level they were added to. */
export interface CellContribution {
  readonly level: PlayLevel;
  readonly measured: number;
  readonly qualified: number;
}

/**
 * Moves one exposure's counts for one topic from the cell they were in to the cell they belong in now
 * (D-192). A first projection only adds. A correction under the same level adds the difference; one whose
 * level changed (an exposure counted as plain before play levels existed) removes the old counts and adds the
 * new. Counts never go below zero, and a cell never has more qualified than measured: a process from before
 * the migration counts the parent and not the cell, so a later correction may take away what was never added.
 */
export async function moveCellCounts(
  db: Kysely<Database>,
  where: {
    readonly universeId: string;
    readonly privacyEpoch: number;
    readonly topicId: string;
    readonly kind: 'reel' | 'scroll';
  },
  before: CellContribution | undefined,
  next: CellContribution,
): Promise<void> {
  const changes: { level: PlayLevel; measured: number; qualified: number }[] =
    before !== undefined && before.level === next.level
      ? [{ level: next.level, measured: next.measured - before.measured, qualified: next.qualified - before.qualified }]
      : [
          ...(before ? [{ level: before.level, measured: -before.measured, qualified: -before.qualified }] : []),
          { level: next.level, measured: next.measured, qualified: next.qualified },
        ];
  for (const change of changes) {
    if (change.measured === 0 && change.qualified === 0) continue;
    await sql`insert into evidence.topic_format_cells(universe_id,privacy_epoch,topic_id,kind,play_level,measured,qualified)
      values(${where.universeId}::uuid,${where.privacyEpoch},${where.topicId},${where.kind},${change.level},greatest(0,${change.measured}),least(greatest(0,${change.qualified}),greatest(0,${change.measured})))
      on conflict(universe_id,topic_id,kind,play_level) do update set privacy_epoch=excluded.privacy_epoch,
        measured=greatest(0,evidence.topic_format_cells.measured+${change.measured}),
        qualified=least(greatest(0,evidence.topic_format_cells.qualified+${change.qualified}),greatest(0,evidence.topic_format_cells.measured+${change.measured}))`.execute(
      db,
    );
  }
}

/** The cells of up to 100 topics, grouped by topic: at most six rows each (two kinds, three levels). */
export async function readCells(
  scope: PersonalScopeTx,
  topicIds: readonly string[],
): Promise<ReadonlyMap<string, readonly FormatCell[]>> {
  if (topicIds.length === 0) return new Map();
  const rows = await sql<{
    topic_id: string;
    kind: 'reel' | 'scroll';
    play_level: PlayLevel;
    measured: number;
    qualified: number;
  }>`select topic_id,kind,play_level,measured,qualified from evidence.topic_format_cells
    where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and topic_id=any(${topicIds}::text[])
    order by topic_id,kind,play_level limit 600`.execute(transactionOf(scope));
  const byTopic = new Map<string, FormatCell[]>();
  for (const row of rows.rows)
    byTopic.set(row.topic_id, [
      ...(byTopic.get(row.topic_id) ?? []),
      { kind: row.kind, level: row.play_level, measured: row.measured, qualified: row.qualified },
    ]);
  return byTopic;
}
