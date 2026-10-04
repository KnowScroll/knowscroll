/**
 * The feed's candidate assets and the reads around a feed decision (ADR-0025 §2). Read-only; runs in
 * the caller's authenticated transaction.
 */
import type pg from 'pg';
import type { ScrollAsset } from '@knowscroll/contracts';
import type {
  FeedAsset,
  ReelAssetDisplay,
} from '@knowscroll/contracts/inventory';
import { validateScrollWebArtifact } from '@knowscroll/core/scrolls/web-artifact';

interface ReelRow {
  assetId: string;
  revision: number;
  title: string;
  summary: string;
  truthState: string;
  simulated: boolean;
  mediaSha256: string;
  sourceTitle: string;
  sourceUrl: string;
  probe: unknown;
}

/** ADR-0025 section 2: only ever built from a stored ffprobe `probe` and the KnowScroll-owned
 * content-addressed media route — the engine's own file path is never sent. */
function toReelAsset(row: ReelRow): ReelAssetDisplay {
  const probe = row.probe as {
    durationSeconds?: unknown;
    width?: unknown;
    height?: unknown;
  } | null;
  const durationSeconds =
    typeof probe?.durationSeconds === 'number' ? probe.durationSeconds : 0;
  const width = typeof probe?.width === 'number' ? probe.width : 0;
  const height = typeof probe?.height === 'number' ? probe.height : 0;
  return {
    assetId: row.assetId,
    revision: row.revision,
    kind: 'Reel',
    title: row.title,
    summary: row.summary,
    truthState: 'synthesis',
    generatedLabel: true,
    simulated: row.simulated,
    mediaUrl: `/v1/media/${row.mediaSha256}`,
    durationSeconds,
    aspect: `${width}:${height}`,
    sourceTitle: row.sourceTitle,
    sourceUrl: row.sourceUrl,
  };
}

/**
 * ADR-0025 section 2: candidates for `GET /v1/feed`. The default (`kinds` absent, or explicitly
 * `Scroll` alone) queries and returns EXACTLY what this route has always returned — the Reel query
 * never even runs — so an existing client sees no change at all. When `Reel` is requested, eligible/
 * test_eligible non-withdrawn Reel assets are interleaved (Scroll, Reel, Scroll, Reel, …) with the
 * Scroll list before `compose()`'s own bound/kept-filter runs, so a bounded few candidates are not
 * permanently dominated by whichever kind currently has more rows; this is still no inference and
 * no engagement signal, only a fixed, documented merge order.
 */
export async function feedCandidates(
  client: pg.PoolClient,
  kinds: readonly ('Scroll' | 'Reel')[],
): Promise<FeedAsset[]> {
  const scrolls = kinds.includes('Scroll')
    ? ((
        await client.query<ScrollAsset>(
          `
      SELECT
        id AS "assetId",
        revision,
        kind,
        title,
        summary,
        body,
        source_title AS "sourceTitle",
        source_url AS "sourceUrl",
        truth_state AS "truthState"
      FROM
        asset
      WHERE
        kind = 'Scroll'
      ORDER BY
        editorial_order
    `,
        )
      ).rows as ScrollAsset[])
    : [];
  if (!kinds.includes('Reel')) return scrolls;
  const reelRows = (
    await client.query<ReelRow>(
      `
      SELECT
        a.id AS "assetId",
        a.revision,
        a.title,
        a.summary,
        a.truth_state AS "truthState",
        a.simulated,
        a.media_sha256 AS "mediaSha256",
        a.source_title AS "sourceTitle",
        a.source_url AS "sourceUrl",
        m.probe AS probe
      FROM
        asset a
        JOIN generated_reel g ON g.id = a.generated_reel_id
        JOIN media_object m ON m.sha256 = a.media_sha256
      WHERE
        a.kind = 'Reel'
        AND a.withdrawn_at IS NULL
        AND g.availability IN ('eligible', 'test_eligible')
      ORDER BY
        g.created_at,
        a.id
    `,
    )
  ).rows;
  const reels = reelRows.map(toReelAsset);
  const merged: FeedAsset[] = [];
  for (let i = 0; i < Math.max(scrolls.length, reels.length); i += 1) {
    if (scrolls[i]) merged.push(scrolls[i]!);
    if (reels[i]) merged.push(reels[i]!);
  }
  return merged;
}

/** The universe's accounts row, as the composers read it. */
export async function readFeedAccount(
  client: pg.PoolClient,
  universeId: string,
) {
  return (
    await client.query('SELECT * FROM accounts WHERE universe_id=$1', [
      universeId,
    ])
  ).rows[0];
}

/**
 * The checked web artifact of each selected Scroll, keyed by asset id. An invalid or stale artifact
 * becomes null (the reader falls back to the body); selection and exposure are never affected.
 */
export async function readFeedWebArtifacts(
  client: pg.PoolClient,
  scrollIds: string[],
): Promise<Map<string, unknown>> {
  const artifacts = new Map<string, unknown>();
  if (scrollIds.length > 0) {
    const rows = await client.query<{
      id: string;
      revision: number;
      body: string;
      web_artifact: unknown;
    }>(
      'SELECT id, revision, body, web_artifact FROM asset WHERE id = ANY($1::uuid[])',
      [scrollIds],
    );
    for (const row of rows.rows)
      artifacts.set(
        row.id,
        validateScrollWebArtifact(row.web_artifact, {
          assetId: row.id,
          revision: row.revision,
          body: row.body,
        }),
      );
  }
  return artifacts;
}
