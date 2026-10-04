import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  planFoundations,
  planPlaces,
  planRejection,
  type PlaceAccount,
  type PlaceDelta,
} from '@knowscroll/core/atlas/cartographer';
import type { KeeperAsk } from '@knowscroll/core/rooms/keeper';
import { postInquiryMail } from '../reasoning/inquiries.ts';
import { keepRooms, retireRooms } from '../rooms.ts';
import { AtlasConflict, AtlasNotFound } from './errors.ts';
import {
  loadPlaces,
  loadSubstrate,
  type PlaceRow,
  type Substrate,
} from './inputs.ts';

const snapshot = (p: {
  kind: string;
  state: string;
  parentPlaceId: string | null;
}) => ({
  kind: p.kind,
  state: p.state,
  parentPlaceId: p.parentPlaceId,
});

async function insertDelta(
  client: pg.PoolClient,
  universeId: string,
  placeId: string,
  d: {
    kind: string;
    causalClass: string;
    policyVersion: string;
    evidence: unknown;
  },
  before: object | null,
  after: object,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `
      INSERT INTO
        atlas_delta (
          id,
          universe_id,
          place_id,
          kind,
          causal_class,
          policy_version,
          evidence,
          before,
          after
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      id,
      universeId,
      placeId,
      d.kind,
      d.causalClass,
      d.policyVersion,
      JSON.stringify(d.evidence),
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
  return id;
}

/** Applies deltas in plan order; parents are resolved by anchor, including places formed earlier in the plan. */
async function applyDeltas(
  client: pg.PoolClient,
  universeId: string,
  substrate: Substrate,
  places: PlaceRow[],
  deltas: PlaceDelta[],
): Promise<number> {
  const liveByAnchor = new Map(
    places.filter((p) => p.state === 'live').map((p) => [p.anchor, p]),
  );
  const byId = new Map(places.map((p) => [p.placeId, p]));
  const parentId = (anchor: string | null) =>
    anchor === null ? null : (liveByAnchor.get(anchor)?.placeId ?? null);
  for (const d of deltas) {
    if (d.kind === 'place_formed' || d.kind === 'sighting_appeared') {
      if (d.kind === 'place_formed' && d.promotesPlaceId) {
        const sighting = byId.get(d.promotesPlaceId)!;
        await client.query(
          `UPDATE atlas_place SET state='promoted' WHERE id=$1 AND state='live'`,
          [sighting.placeId],
        );
        const parent = sighting.parentPlaceId;
        await insertDelta(
          client,
          universeId,
          sighting.placeId,
          {
            kind: 'sighting_promoted',
            causalClass: 'personal_exploration',
            policyVersion: d.policyVersion,
            evidence: d.evidence,
          },
          snapshot({ kind: 'sighting', state: 'live', parentPlaceId: parent }),
          snapshot({
            kind: 'sighting',
            state: 'promoted',
            parentPlaceId: parent,
          }),
        );
        liveByAnchor.delete(d.anchor);
      }
      const id = randomUUID();
      const kind = d.kind === 'place_formed' ? d.placeKind : 'sighting';
      const parent = parentId(d.parentAnchor);
      if (d.parentAnchor !== null && parent === null)
        throw new Error(
          `Cartographer planned a parent that is not live: ${d.parentAnchor}`,
        );
      await client.query(
        `
          INSERT INTO
            atlas_place (
              id,
              universe_id,
              anchor_concept_id,
              kind,
              parent_place_id,
              basis,
              policy_version
            )
          VALUES
            ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          id,
          universeId,
          substrate.ids.get(d.anchor),
          kind,
          parent,
          d.kind === 'sighting_appeared'
            ? JSON.stringify(d.evidence.relation)
            : null,
          d.policyVersion,
        ],
      );
      const deltaId = await insertDelta(
        client,
        universeId,
        id,
        d,
        null,
        snapshot({ kind, state: 'live', parentPlaceId: parent }),
      );
      // ADR-0038 §3: a new planet or region may be worth a look for a connection, if the reader
      // consented; the mail joins this same transaction (and nothing is mailed while paused).
      if (kind !== 'sighting')
        await postInquiryMail(client, universeId, {
          kind: 'place_formed',
          deltaId,
        });
      const row: PlaceRow = {
        placeId: id,
        anchor: d.anchor,
        anchorId: substrate.ids.get(d.anchor)!,
        kind,
        parentAnchor: d.parentAnchor,
        parentPlaceId: parent,
        state: 'live',
        basis: d.kind === 'sighting_appeared' ? d.evidence.relation : null,
      };
      liveByAnchor.set(d.anchor, row);
      byId.set(id, row);
      continue;
    }
    if (
      d.kind === 'foundation_recognised' ||
      d.kind === 'foundation_withdrawn'
    ) {
      const place = liveByAnchor.get(d.anchor)!;
      const bearing = d.kind === 'foundation_recognised';
      await client.query(
        "UPDATE atlas_place SET load_bearing=$2 WHERE id=$1 AND state='live'",
        [place.placeId, bearing],
      );
      // A re-recognition (the connections changed while it stood) keeps the flag: true -> true.
      await insertDelta(
        client,
        universeId,
        place.placeId,
        d,
        { loadBearing: place.loadBearing ?? false },
        { loadBearing: bearing },
      );
      place.loadBearing = bearing;
      place.foundationBasis =
        d.kind === 'foundation_recognised' ? d.evidence.relations : null;
      continue;
    }
    const place = byId.get(d.placeId)!;
    const parent = place.parentPlaceId;
    const before = snapshot({
      kind: place.kind,
      state: 'live',
      parentPlaceId: parent,
    });
    if (d.kind === 'place_released') {
      await client.query(
        `UPDATE atlas_place SET kind='planet', parent_place_id=NULL WHERE id=$1 AND state='live'`,
        [place.placeId],
      );
      await insertDelta(
        client,
        universeId,
        place.placeId,
        d,
        before,
        snapshot({ kind: 'planet', state: 'live', parentPlaceId: null }),
      );
      place.kind = 'planet';
      place.parentAnchor = null;
      place.parentPlaceId = null;
    } else {
      const state = d.kind === 'place_rejected' ? 'rejected' : 'retired';
      await client.query(
        `UPDATE atlas_place SET state=$2 WHERE id=$1 AND state='live'`,
        [place.placeId, state],
      );
      await insertDelta(
        client,
        universeId,
        place.placeId,
        d,
        before,
        snapshot({ kind: place.kind, state, parentPlaceId: parent }),
      );
      place.state = state;
      liveByAnchor.delete(place.anchor);
    }
  }
  return deltas.length;
}

/** Called by the personal-model refresh after attention accounts are written (never while paused). */
export async function runCartographer(
  client: pg.PoolClient,
  universeId: string,
  accounts: readonly PlaceAccount[],
): Promise<number> {
  const substrate = await loadSubstrate(client);
  const places = await loadPlaces(client, universeId);
  const deltas = planPlaces({
    concepts: substrate.concepts,
    relations: substrate.relations,
    accounts,
    places,
    rejectedAnchors: places
      .filter((p) => p.state === 'rejected')
      .map((p) => p.anchor),
  });
  return applyDeltas(client, universeId, substrate, places, deltas);
}

/** ADR-0045 §5: the Keeper runs right after the Cartographer, in the same refresh, over the places as
 * it left them and the reader's Asks. */
export async function runKeeper(
  client: pg.PoolClient,
  universeId: string,
  asks: readonly KeeperAsk[],
): Promise<number> {
  return keepRooms(
    client,
    universeId,
    await loadSubstrate(client),
    await loadPlaces(client, universeId),
    asks,
  );
}

export async function rejectPlace(
  client: pg.PoolClient,
  universeId: string,
  placeId: string,
): Promise<{ deltas: number }> {
  const paused = (
    await client.query<{ paused: boolean }>(
      'SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1',
      [universeId],
    )
  ).rows[0]?.paused;
  if (paused) throw new AtlasConflict('Recording is paused');
  const places = await loadPlaces(client, universeId);
  const target = places.find((p) => p.placeId === placeId);
  if (!target) throw new AtlasNotFound();
  if (target.state === 'rejected') return { deltas: 0 };
  if (target.state !== 'live' || target.kind === 'sighting')
    throw new AtlasConflict('Only a live planet or region can be set aside');
  const substrate = await loadSubstrate(client);
  const rejected = await applyDeltas(
    client,
    universeId,
    substrate,
    places,
    planRejection(places, placeId),
  );
  // Foundations, and only foundations, are re-evaluated at once (ADR-0037); every other change
  // waits for the reader's next refresh, exactly as in ADR-0036.
  const after = await loadPlaces(client, universeId);
  const followUp = planFoundations({
    relations: substrate.relations,
    places: after,
  });
  // Its rooms retire with it, in this same transaction (ADR-0045 §6).
  return {
    deltas:
      rejected +
      (await applyDeltas(client, universeId, substrate, after, followUp)) +
      (await retireRooms(client, universeId, after)),
  };
}
