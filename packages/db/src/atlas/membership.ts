/**
 * Which of the reader's places an encounter belongs to (ADR-0036 §5, ADR-0049). One rule, read by
 * the Atlas's Scroll counts and by the place-scoped feed, so the two never disagree: the live
 * sighting its primary concept is, else the nearest live planet or region on that concept's ancestor
 * chain. Read-only; runs in the caller's authenticated transaction, under its universe lock.
 */

import { homeAnchor } from '@knowscroll/core/atlas/cartographer';
import type pg from 'pg';
import { AtlasNotFound } from './errors.ts';
import { loadPlaces, type PlaceRow } from './inputs.ts';

/** The place id an encounter with primary concept `code` belongs to, or null; `places` are live. */
export function placeMembership(
  places: readonly PlaceRow[],
  parentOf: ReadonlyMap<string, string | null>,
): (code: string) => string | null {
  const liveAnchor = new Map(places.map((p) => [p.anchor, p]));
  return (code) => {
    const own = liveAnchor.get(code);
    if (own?.kind === 'sighting') return own.placeId;
    const anchor = homeAnchor(code, parentOf, (c) => {
      const p = liveAnchor.get(c);
      return !!p && p.kind !== 'sighting';
    });
    return anchor === null ? null : liveAnchor.get(anchor)!.placeId;
  };
}

/**
 * The part of `assets` a feed asked from `placeId` may offer: those whose primary concept belongs
 * (by `placeMembership`) to that place or to a live region beneath it, at any depth. `placeIds` is
 * that place and those regions. A Reel carries its Scroll's concepts (ADR-0043), so it belongs where
 * its Scroll does; an unannotated asset belongs nowhere.
 *
 * Refusal: `AtlasNotFound` (404) unless `placeId` is a live planet or region of this universe.
 */
export async function scopeToPlace<T extends { assetId: string }>(
  client: pg.PoolClient,
  universeId: string,
  placeId: string,
  assets: readonly T[],
): Promise<{ placeIds: string[]; assets: T[] }> {
  const places = (await loadPlaces(client, universeId)).filter(
    (p) => p.state === 'live',
  );
  if (!places.some((p) => p.placeId === placeId && p.kind !== 'sighting'))
    throw new AtlasNotFound('Place not found');
  const placeIds = [placeId];
  for (let i = 0; i < placeIds.length; i += 1)
    for (const p of places)
      if (p.kind === 'region' && p.parentPlaceId === placeIds[i])
        placeIds.push(p.placeId);
  const parentOf = new Map(
    (
      await client.query<{ code: string; parent: string | null }>(
        'SELECT c.code, p.code AS parent FROM concept c LEFT JOIN concept p ON p.id = c.parent_id',
      )
    ).rows.map((r) => [r.code, r.parent]),
  );
  const primary = new Map(
    (
      await client.query<{ asset_id: string; code: string }>(
        `
        SELECT
          ac.asset_id,
          c.code
        FROM
          asset_concept ac
          JOIN concept c ON c.id = ac.concept_id
        WHERE
          ac.role = 'primary'
          AND ac.asset_id = ANY ($1::UUID[])
      `,
        [assets.map((a) => a.assetId)],
      )
    ).rows.map((r) => [r.asset_id, r.code]),
  );
  const memberOf = placeMembership(places, parentOf);
  const inScope = new Set(placeIds);
  return {
    placeIds,
    assets: assets.filter((a) => {
      const code = primary.get(a.assetId);
      const place = code === undefined ? null : memberOf(code);
      return place !== null && inScope.has(place);
    }),
  };
}
