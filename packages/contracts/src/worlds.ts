/**
 * ADR-0028 — additive wire types for `GET /v1/worlds`. Nothing here is re-exported from
 * `./index.ts` (the same convention `generation.ts`/`publication.ts`/`inventory.ts` already
 * follow); callers import this file directly.
 */

/** A "planet": the shared, universe-independent catalog entry for one recorded source. */
export interface WorldSummary {
  worldId: string;
  sourceTitle: string;
  sourceUrl: string;
  /** The live count of Scroll-kind assets sharing this source, database-verified. */
  scrollCount: number;
  /** How many of this world's Scrolls this reader's own exposures have actually reached. */
  seenCount: number;
}

/** A "solar system": the worlds one universe's reader has actually encountered so far. */
export interface WorldSystemResponse {
  derivationMethod: string;
  /** `null` for a universe that has not yet encountered any recorded source's evidence. */
  system: { systemId: string; worlds: WorldSummary[] } | null;
}
