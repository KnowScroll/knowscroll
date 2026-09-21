import type pg from 'pg';
import type { FeedAsset } from '../../contracts/src/inventory.ts';
import type { ComposerPolicy, SignalCandidate } from '../../core/src/composer.ts';

/** ADR-0028 section 2: an immutable, versioned ranking policy. Rows never change once created
 * (migration 0017's `composer_policy_immutable` trigger), so this can be read once per request
 * with no staleness risk. */
export async function loadComposerPolicy(client: pg.PoolClient, version: string): Promise<ComposerPolicy> {
  const row = (await client.query(
    'SELECT version, weights, slate_size, max_per_source FROM composer_policy WHERE version=$1',
    [version],
  )).rows[0];
  if (!row) throw new Error(`composer_policy '${version}' is not registered`);
  return { version: row.version, weights: row.weights, slateSize: row.slate_size, maxPerSource: row.max_per_source };
}

/** ADR-0028 section 5: the registered, immutable explanation vocabulary, keyed by
 * `explanation_key`. */
export async function loadComposerExplanationTemplates(client: pg.PoolClient): Promise<Record<string, string>> {
  const rows = (await client.query<{ explanation_key: string; template: string }>(
    'SELECT explanation_key, template FROM composer_explanation_template',
  )).rows;
  const templates: Record<string, string> = {};
  for (const row of rows) templates[row.explanation_key] = row.template;
  return templates;
}

/**
 * ADR-0028 section 2's one bounded retrieval-time signal query: exposure count and the most
 * recent exposure time per candidate asset, from `exposure` joined to `ledger` for its timestamp
 * (`exposure` itself carries no timestamp column) — no network call, no provider, nothing beyond
 * what this schema already records. The clock reading comes from the same database transaction
 * (`clock_timestamp()`), not the caller's wall clock, so recency is computed against the same
 * instant the signals were read.
 */
export async function loadComposerSignalCandidates(
  client: pg.PoolClient,
  universeId: string,
  assets: readonly FeedAsset[],
): Promise<{ candidates: SignalCandidate[]; nowMs: number }> {
  const ids = assets.map(a => a.assetId);
  const rows = ids.length === 0 ? [] : (await client.query<{ asset_id: string; exposure_count: string; last_exposed_at: Date | null }>(
    `SELECT e.asset_id, count(*)::int AS exposure_count, max(l.created_at) AS last_exposed_at
     FROM exposure e JOIN ledger l ON l.id = e.event_id
     WHERE e.universe_id = $1 AND e.asset_id = ANY($2::uuid[])
     GROUP BY e.asset_id`,
    [universeId, ids],
  )).rows;
  const bySignal = new Map(rows.map(row => [row.asset_id, row]));

  // #113/ADR-0029 amendment: the coverage tie-break's own bounded signal query — total recorded
  // exposures in this universe for ANY asset sharing a candidate's source, not only this one
  // candidate asset (a source with other, already-exposed assets is not "unseen"). Bounded to the
  // distinct sourceKeys already present in this request's own candidate set, never every source
  // the universe has ever encountered.
  const sourceKeys = [...new Set(assets.map(a => a.sourceUrl))];
  const sourceRows = sourceKeys.length === 0 ? [] : (await client.query<{ source_url: string; exposure_count: string }>(
    `SELECT a.source_url, count(*)::int AS exposure_count
     FROM exposure e JOIN asset a ON a.id = e.asset_id
     WHERE e.universe_id = $1 AND a.source_url = ANY($2::text[])
     GROUP BY a.source_url`,
    [universeId, sourceKeys],
  )).rows;
  const bySource = new Map(sourceRows.map(row => [row.source_url, Number(row.exposure_count)]));

  const nowRow = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!;

  const candidates: SignalCandidate[] = assets.map(asset => {
    const signal = bySignal.get(asset.assetId);
    return {
      asset,
      sourceKey: asset.sourceUrl,
      sourceTitle: asset.sourceTitle,
      exposureCount: signal ? Number(signal.exposure_count) : 0,
      lastExposedAtMs: signal?.last_exposed_at ? signal.last_exposed_at.getTime() : null,
      sourceExposureCount: bySource.get(asset.sourceUrl) ?? 0,
    };
  });
  return { candidates, nowMs: nowRow.now.getTime() };
}
