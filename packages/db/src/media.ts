/** Which stored media a Reel may serve (ADR-0024 §4). Read-only; the API streams the bytes after commit. */
import type pg from 'pg';

/**
 * The storage key of content-addressed media an eligible or test_eligible Reel names, or null. When
 * several Reels name the same bytes, a genuine `eligible` one wins, so real bytes are never labelled
 * simulated.
 */
export async function findServableMedia(
  client: pg.PoolClient,
  sha256: string,
): Promise<{ storageKey: string; simulated: boolean } | null> {
  const row = (
    await client.query<{ storage_key: string; simulated: boolean }>(
      `
            SELECT
              m.storage_key,
              (g.availability = 'test_eligible') AS simulated
            FROM
              generated_reel g
              JOIN media_object m ON m.sha256 = g.media_sha256
            WHERE
              g.media_sha256 = $1
              AND g.availability IN ('eligible', 'test_eligible')
            ORDER BY
              (g.availability = 'eligible') DESC,
              g.created_at ASC
            LIMIT
              1
          `,
      [sha256],
    )
  ).rows[0];
  return row ? { storageKey: row.storage_key, simulated: row.simulated } : null;
}
