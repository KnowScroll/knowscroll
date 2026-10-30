import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, exportReading } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { clearCoreTransactionOf } from '../../../infrastructure/postgres/privacy-scope.js';

/**
 * Play is the person's own game record: the calls they locked and what those earned. Every row is
 * universe-keyed, so selective Clear and account deletion delete all of it (D-050, D-082). Nothing
 * of it is kept beside the person's Saved items or friends, and no other module holds a copy: the
 * modules that rank, plan and form places never import play (D-063).
 */
const tables = ['calls', 'scroll_results'] as const;

interface ExportRow {
  readonly asset_id: string;
  readonly revision: number;
  readonly title: string | null;
  readonly stop: { readonly prompt?: string; readonly options?: readonly string[] } | null;
  readonly option: number;
  readonly correct: boolean;
  readonly locked_at: Date;
  readonly sparks: number;
  readonly combo: number;
}

export const playErasure = declareErasure({
  module: 'play',
  tables: tables.map((table) => ({ schema: 'play', table, ownerColumn: 'universe_id' as const })),
  nonRowStores: [],

  async erase(scope) {
    let removed = 0;
    for (const table of tables) {
      const result =
        await sql`delete from ${sql.table(`play.${table}`)} where universe_id = ${scope.authority.universeId}::uuid`.execute(
          transactionOf(scope),
        );
      removed += Number(result.numAffectedRows ?? 0);
    }
    return { module: 'play', status: 'completed', removed };
  },

  clear: {
    defaultDisposition: 'erase',
    async erase(scope) {
      let removed = 0;
      for (const table of tables) {
        const result =
          await sql`delete from ${sql.table(`play.${table}`)} where universe_id = ${scope.binding.universeId}::uuid`.execute(
            clearCoreTransactionOf(scope),
          );
        removed += Number(result.numAffectedRows ?? 0);
      }
      return { module: 'play', status: 'completed', removed };
    },
  },

  /**
   * The calls the person locked, by Scroll: its title (when they may still read it), each question,
   * the option they picked in words, whether it was right, and the sparks and combo it earned. The
   * option is shown as the person saw it; internal identifiers and the right answer are left out.
   */
  export: (declaration) =>
    exportReading(
      declaration,
      ['play.calls', 'play.scroll_results'],
      'Nothing else is declared.',
      async (scope, person) => {
        const rows = await sql<ExportRow>`
        select call.asset_id, call.revision, revision.title,
          jsonb_path_query_first(revision.document, '$.stops[*] ? (@.id == $stop)', jsonb_build_object('stop', call.stop_id)) as stop,
          call.option, call.correct, call.locked_at, results.sparks, results.combo
        from play.calls call
        join play.scroll_results results
          on results.universe_id = call.universe_id and results.asset_id = call.asset_id and results.revision = call.revision
        left join content.asset_revisions revision
          on revision.asset_id = call.asset_id and revision.revision = call.revision
        where call.universe_id = ${scope.authority.universeId}::uuid and call.privacy_epoch = ${scope.authority.privacyEpoch}
        order by call.locked_at desc, call.stop_id
        limit ${EXPORT_LIST_LIMIT + 1}`.execute(transactionOf(scope));
        if (rows.rows.length === 0) return {};
        const reachable = await person.reach([...new Set(rows.rows.map((row) => row.asset_id))]);
        // The list is bounded by calls, not by Scrolls, so its own cut is reported.
        const listed = rows.rows.slice(0, EXPORT_LIST_LIMIT);
        return {
          scrolls: { items: groupByScroll(listed, reachable), truncated: rows.rows.length > EXPORT_LIST_LIMIT },
        };
      },
    ),
});

/** One entry per Scroll revision, newest play first, each with its calls newest first. */
function groupByScroll(rows: readonly ExportRow[], reachable: ReadonlySet<string>) {
  const scrolls = new Map<string, { entry: Record<string, unknown>; calls: Record<string, unknown>[] }>();
  for (const row of rows) {
    const key = `${row.asset_id}@${String(row.revision)}`;
    let scroll = scrolls.get(key);
    if (scroll === undefined) {
      const calls: Record<string, unknown>[] = [];
      scroll = {
        entry: {
          ...(reachable.has(row.asset_id) && row.title !== null ? { title: row.title } : {}),
          sparks: row.sparks,
          combo: row.combo,
          calls,
        },
        calls,
      };
      scrolls.set(key, scroll);
    }
    const readable = reachable.has(row.asset_id);
    scroll.calls.push({
      ...(readable && row.stop?.prompt !== undefined ? { question: row.stop.prompt } : {}),
      ...(readable && row.stop?.options?.[row.option] !== undefined ? { picked: row.stop.options[row.option] } : {}),
      right: row.correct,
      lockedAt: row.locked_at.toISOString(),
    });
  }
  return [...scrolls.values()].map((scroll) => scroll.entry);
}
