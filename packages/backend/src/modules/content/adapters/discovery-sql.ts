import { createHash } from 'node:crypto';
import { sql } from 'kysely';

/**
 * A Scroll ordered from code (a thread's what-if or perspective) is never a candidate for anyone's
 * Explore: it belongs to the thread it was made for (D-049). Exact reads still find it.
 */
export const notOrdered = sql`not exists (select 1 from content.made_to_order_scrolls o where o.asset_id=r.asset_id)`;
/**
 * Where in the random order (`serve_rand`, in [0, 1)) a lane starts: a point derived from the decision seed, so it varies per
 * decision and is the same for the same seed. Without a seed it is the beginning.
 */
export function rotationCursor(rotation: string | undefined): number {
  if (rotation === undefined || rotation === '') return 0;
  return createHash('sha256').update(rotation).digest().readUInt32BE(0) / 4294967296;
}

/**
 * A lane's distance from the cursor, going forward and wrapping round at 1: the sort key (`rot`) that orders a lane. A revision at
 * the cursor is first, the one just before it last.
 */
export const distance = (key: ReturnType<typeof sql>, cursor: number) =>
  sql<number>`(case when ${key}>=${cursor}::float8 then ${key}-${cursor}::float8 else ${key}-${cursor}::float8+1 end)`;
