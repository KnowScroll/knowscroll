/**
 * ADR-0028 — evidence-backed semantic worlds. This is the consumer the contract migration
 * (0017_evidence_backed_worlds.sql) explicitly deferred: the deterministic derivation that turns
 * recorded `asset` rows into a shared `world` catalog, and one universe's own `exposure` rows
 * (each one step from the causing `ledger` event) into that universe's `world_system`.
 *
 * Both functions are pure recomputations, never assertions: every `world`/`world_system` row is
 * found by its evidence key (`derivation_method` + `source_url`, or `derivation_method` +
 * `universe_id`) rather than minted fresh, so calling either function twice with unchanged
 * underlying data inserts nothing new and leaves every row's values identical. `scroll_count` and
 * `seen_count` are never computed here in the sense of "the value this module decides" — migration
 * 0017's own `world_guard`/`world_system_member_guard` triggers independently recompute and refuse
 * any value that does not match the live evidence, so a wrong count here would fail loudly, not
 * silently, at the `UPDATE`/`INSERT` that tries to write it.
 *
 * Law 1 (the universe emerges from lived behavior) and law 4 (behavior is evidence, never proof)
 * from docs/product/definition.md section 3: nothing here infers a topic, a relationship or an
 * intrinsic preference. `shared_source_v1` groups by a fact the asset row already recorded.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export const SHARED_SOURCE_V1 = 'shared_source_v1';

export interface WorldRow {
  worldId: string;
  sourceTitle: string;
  sourceUrl: string;
  /** The live count of Scroll-kind assets behind this world, as migration 0017's `world_guard`
   * trigger itself verifies -- never a value this module merely asserts. */
  scrollCount: number;
}

export interface SystemWorldRow extends WorldRow {
  /** How many of this world's Scrolls this universe has an `exposure` row for -- migration
   * 0017's `world_system_member_guard` trigger independently recomputes and refuses this too. */
  seenCount: number;
}

export interface SystemResult {
  systemId: string;
  worlds: SystemWorldRow[];
}

/**
 * Recomputes the shared world catalog from the `asset` table alone (ADR-0028 section 1): every
 * distinct `source_url` among all recorded assets becomes exactly one world,
 * carrying every asset row sharing that pair as its `world_member` evidence. Idempotent by
 * construction -- a world is looked up by `(derivation_method, source_url)` before ever being
 * inserted, and `world_member` rows are inserted `ON CONFLICT DO NOTHING`, so a second call against
 * unchanged `asset` rows produces identical rows, though it does restate each `computed_at` (only `scroll_count`/`computed_at` are always
 * re-stated, to the same value, which migration 0017's trigger accepts because it is already
 * correct). Must run inside the caller's own transaction, with the universe lock already held if
 * the caller is a request path (this module never acquires it itself, since the world catalog
 * itself is universe-independent -- ADR-0028's "alternatives" section 4).
 *
 * A source with zero asset rows can never appear here, and nothing here deletes an existing world:
 * assets are withdrawn, never deleted (ADR-0025), so a world's evidence is never removed out from
 * under it by this module.
 */
export async function deriveWorlds(client: pg.PoolClient, method: string = SHARED_SOURCE_V1): Promise<WorldRow[]> {
  const sources = (await client.query<{ source_title: string; source_url: string; scroll_count: string }>(
    // Grouped by URL alone, because the URL is what identifies a source; the title is a label that
     // legitimately varies for the same source. Grouping by the pair produced two groups that both
     // resolved to one world, and the second group's assets then failed the membership guard --
     // every exposure against a library with one such variant returned 500.
     // The representative title is chosen deterministically (lowest by collation) so the same
     // evidence always yields the same world row.
    `SELECT min(source_title) AS source_title, source_url,
            count(*) FILTER (WHERE kind = 'Scroll') AS scroll_count
     FROM asset GROUP BY source_url`,
  )).rows;

  const out: WorldRow[] = [];
  for (const source of sources) {
    // Insert-then-read, never read-then-insert. The `world` catalog is shared across universes and
    // this module holds no lock of its own, so two transactions meeting a brand-new source at the
    // same moment would both see "none exists" and both insert -- the loser taking a duplicate-key
    // error, surfaced as a 500 on a perfectly legitimate encounter. `ON CONFLICT DO NOTHING` makes
    // the race a no-op and the following read always finds the winner's row.
    await client.query(
      `INSERT INTO world(id,derivation_method,source_title,source_url) VALUES($1,$2,$3,$4)
       ON CONFLICT (derivation_method, source_url) DO NOTHING`,
      [randomUUID(), method, source.source_title, source.source_url],
    );
    const settled = (await client.query<{ id: string }>(
      'SELECT id FROM world WHERE derivation_method=$1 AND source_url=$2',
      [method, source.source_url],
    )).rows[0];
    // The insert above either created this row or lost the race to a transaction that did; either
    // way it exists by now, and its absence would mean the unique key no longer matches the lookup.
    if (!settled) throw new Error(`world row missing for source after insert: ${source.source_url}`);
    const worldId = settled.id;

    const members = (await client.query<{ id: string }>(
      // Membership follows the same identity as the grouping: the source URL.
      'SELECT id FROM asset WHERE source_url=$1',
      [source.source_url],
    )).rows;
    for (const member of members) {
      await client.query(
        'INSERT INTO world_member(world_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [worldId, member.id],
      );
    }

    const scrollCount = Number(source.scroll_count);
    await client.query(
      'UPDATE world SET scroll_count=$2, computed_at=clock_timestamp() WHERE id=$1',
      [worldId, scrollCount],
    );
    out.push({ worldId, sourceTitle: source.source_title, sourceUrl: source.source_url, scrollCount });
  }
  return out;
}

/**
 * Recomputes one universe's `world_system` from its own `exposure` rows (ADR-0028 section 2): a
 * world is a member of this universe's system exactly when at least one of its Scroll-kind assets
 * has an `exposure` row for this `universe_id` -- `exposure.event_id` is itself a `ledger` row, so
 * this reads the same causation lineage ADR-0004 already requires rather than restating it.
 *
 * Returns `null`, and writes nothing, when this universe has not yet encountered any world's
 * evidence -- "a universe with nothing derives nothing" -- deliberately never attempting to
 * `INSERT` an empty `world_system` row, which migration 0017's deferred constraint trigger would
 * refuse at commit anyway. Assumes the shared world catalog (`deriveWorlds`) is already current;
 * callers that may have just recorded a new source's first asset should call `deriveWorlds` first.
 */
export async function deriveWorldSystemForUniverse(
  client: pg.PoolClient,
  universeId: string,
  method: string = SHARED_SOURCE_V1,
): Promise<SystemResult | null> {
  const seen = (await client.query<{
    world_id: string; source_title: string; source_url: string; scroll_count: number; seen_count: string;
  }>(
    `SELECT w.id AS world_id, w.source_title, w.source_url, w.scroll_count,
            count(DISTINCT m.asset_id) AS seen_count
     FROM world w
     JOIN world_member m ON m.world_id = w.id
     JOIN asset a ON a.id = m.asset_id AND a.kind = 'Scroll'
     JOIN exposure e ON e.asset_id = a.id AND e.universe_id = $1
     WHERE w.derivation_method = $2
     GROUP BY w.id, w.source_title, w.source_url, w.scroll_count`,
    [universeId, method],
  )).rows;
  if (seen.length === 0) return null;

  const existing = (await client.query<{ id: string }>(
    'SELECT id FROM world_system WHERE universe_id=$1 AND derivation_method=$2',
    [universeId, method],
  )).rows[0];
  const systemId = existing?.id ?? randomUUID();
  if (!existing) {
    await client.query(
      'INSERT INTO world_system(id,universe_id,derivation_method) VALUES($1,$2,$3)',
      [systemId, universeId, method],
    );
  }

  const worlds: SystemWorldRow[] = [];
  for (const row of seen) {
    const seenCount = Number(row.seen_count);
    await client.query(
      `INSERT INTO world_system_member(system_id,world_id,seen_count) VALUES($1,$2,$3)
       ON CONFLICT (system_id,world_id) DO UPDATE SET seen_count=EXCLUDED.seen_count, computed_at=clock_timestamp()`,
      [systemId, row.world_id, seenCount],
    );
    worlds.push({
      worldId: row.world_id, sourceTitle: row.source_title, sourceUrl: row.source_url,
      scrollCount: Number(row.scroll_count), seenCount,
    });
  }
  return { systemId, worlds };
}

/**
 * The projection hook: run after recording a new exposure event, in the same transaction (and
 * therefore under the same universe lock `authenticateAndLock` already acquired before any
 * session/domain row -- see AGENTS.md). Deliberately does the full, cheap recompute rather than a
 * narrower incremental update: the evidence base (`asset`) is small, and a full recompute is
 * trivially provable to reconstruct identical output from the recorded rows alone, which a
 * hand-maintained incremental counter would not be.
 */
export async function projectWorldsForEncounter(client: pg.PoolClient, universeId: string): Promise<void> {
  await deriveWorlds(client);
  await deriveWorldSystemForUniverse(client, universeId);
}

/**
 * A pure read: the current state of one universe's system, exactly as already-run projections
 * left it, with no recomputation and no writes. This is what `GET /v1/worlds` serves.
 */
export async function readWorldSystem(
  client: pg.PoolClient,
  universeId: string,
  method: string = SHARED_SOURCE_V1,
): Promise<SystemResult | null> {
  const system = (await client.query<{ id: string }>(
    'SELECT id FROM world_system WHERE universe_id=$1 AND derivation_method=$2',
    [universeId, method],
  )).rows[0];
  if (!system) return null;

  const worlds = (await client.query<{
    world_id: string; source_title: string; source_url: string; scroll_count: number; seen_count: number;
  }>(
    `SELECT w.id AS world_id, w.source_title, w.source_url, w.scroll_count, m.seen_count
     FROM world_system_member m JOIN world w ON w.id = m.world_id
     WHERE m.system_id = $1
     ORDER BY w.source_title`,
    [system.id],
  )).rows.map(row => ({
    worldId: row.world_id, sourceTitle: row.source_title, sourceUrl: row.source_url,
    scrollCount: Number(row.scroll_count), seenCount: Number(row.seen_count),
  }));
  return { systemId: system.id, worlds };
}
