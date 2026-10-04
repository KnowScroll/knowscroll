import type pg from 'pg';
import {
  CARTOGRAPHER_POLICY,
  homeAnchor,
  relationKey,
  type PlaceView,
  type RelationKind,
  type TypedRelation,
} from '@knowscroll/core/atlas/cartographer';
import type { PlaceDemand } from '@knowscroll/contracts/inventory';
import type { RoomSummary } from '@knowscroll/contracts/rooms';
import { toIsoString } from '../shared/time.ts';
import { placeDemands } from '../inventory/read.ts';
import { readPlaceRooms } from '../rooms.ts';
import { DELTA_PLACES, deltaLine, type DeltaNaming } from './chronicle.ts';
import { AtlasNotFound } from './errors.ts';
import { loadPlaces, loadSubstrate, type PlaceRow } from './inputs.ts';

export interface AtlasView {
  policyVersion: string;
  places: {
    placeId: string;
    kind: PlaceView['kind'];
    parentPlaceId: string | null;
    anchor: { code: string; name: string; description: string };
    basis: {
      kind: RelationKind;
      from: string;
      to: string;
      claim: { text: string; sourceTitle: string } | null;
      bridge: { mechanism: string } | null;
    } | null;
    attention: {
      state: string;
      episodes: number;
      daysActive: number;
      sourceFamilies: number;
    } | null;
    scrolls: { total: number; seen: number };
    formedAt: string;
    formedBy: string;
    /** ADR-0037: the places this one holds up, and the sourced connections that say so. */
    foundation: {
      holdsUp: string[];
      relations: {
        kind: RelationKind;
        from: string;
        to: string;
        claim: { text: string; sourceTitle: string } | null;
        bridge: { mechanism: string } | null;
      }[];
    } | null;
    /** ADR-0045: its live Idea Rooms. */
    rooms: RoomSummary[];
    /** ADR-0046 §6: the live demand for more about this place's anchor. */
    demand: PlaceDemand | null;
  }[];
  relations: {
    fromPlaceId: string;
    toPlaceId: string;
    kind: RelationKind;
    claim: { text: string; sourceTitle: string } | null;
    bridge: { mechanism: string } | null;
  }[];
  chronicle: {
    deltaId: string;
    placeId: string;
    parentPlaceId: string | null;
    kind: string;
    causalClass: string;
    at: string;
    line: string;
  }[];
}

/** `anySnapshot`: a change's own evidence keeps naming the claim even after its source was corrected. */
async function describeRefs(
  client: pg.PoolClient,
  relations: TypedRelation[],
  anySnapshot = false,
) {
  const claimIds = relations.flatMap((r) =>
    'claimId' in r.ref ? [r.ref.claimId] : [],
  );
  const bridgeIds = relations.flatMap((r) =>
    'bridgeId' in r.ref ? [r.ref.bridgeId] : [],
  );
  const claims = new Map(
    (
      await client.query<{ id: string; text: string; source_title: string }>(
        `
      SELECT DISTINCT
        ON (cl.id) cl.id,
        cl.statement AS text,
        src.title AS source_title
      FROM
        claim cl
        JOIN claim_support cs ON cs.claim_id = cl.id
        AND cs.support_kind = 'supports'
        JOIN source_snapshot ss ON ss.id = cs.snapshot_id
        AND (
          $2
          OR ss.status = 'current'
        )
        JOIN semantic_source src ON src.id = ss.source_id
      WHERE
        cl.id = ANY ($1::UUID[])
      ORDER BY
        cl.id,
        (ss.status = 'current') DESC,
        src.title
    `,
        [claimIds, anySnapshot],
      )
    ).rows.map((r) => [r.id, { text: r.text, sourceTitle: r.source_title }]),
  );
  const bridges = new Map(
    (
      await client.query<{ id: string; mechanism: string }>(
        'SELECT id, mechanism FROM bridge WHERE id = ANY($1::uuid[])',
        [bridgeIds],
      )
    ).rows.map((r) => [r.id, { mechanism: r.mechanism }]),
  );
  return (r: TypedRelation) => ({
    claim: 'claimId' in r.ref ? (claims.get(r.ref.claimId) ?? null) : null,
    bridge: 'bridgeId' in r.ref ? (bridges.get(r.ref.bridgeId) ?? null) : null,
  });
}

export async function readAtlas(
  client: pg.PoolClient,
  universeId: string,
): Promise<AtlasView> {
  const substrate = await loadSubstrate(client);
  const names = new Map(
    (
      await client.query<{ code: string; name: string; description: string }>(
        'SELECT code, name, description FROM concept',
      )
    ).rows.map((r) => [r.code, r]),
  );
  const places = (await loadPlaces(client, universeId)).filter(
    (p) => p.state === 'live',
  );
  const liveAnchor = new Map(places.map((p) => [p.anchor, p]));
  const parentOf = new Map(substrate.concepts.map((c) => [c.code, c.parent]));
  // A Scroll belongs to the nearest planet/region on its primary concept's ancestor chain; a sighting counts its own anchor.
  const home = (code: string): string | null => {
    const anchor = homeAnchor(code, parentOf, (c) => {
      const p = liveAnchor.get(c);
      return !!p && p.kind !== 'sighting';
    });
    return anchor === null ? null : liveAnchor.get(anchor)!.placeId;
  };
  // Scrolls only: a Reel carries its Scroll's concepts (ADR-0043) but is not one of its Scrolls.
  const primaries = (
    await client.query<{ asset_id: string; code: string; seen: boolean }>(
      `
      SELECT
        ac.asset_id,
        c.code,
        EXISTS (
          SELECT
            1
          FROM
            exposure e
          WHERE
            e.universe_id = $1
            AND e.asset_id = ac.asset_id
        ) AS seen
      FROM
        asset_concept ac
        JOIN concept c ON c.id = ac.concept_id
        JOIN asset a ON a.id = ac.asset_id
      WHERE
        ac.role = 'primary'
        AND a.kind = 'Scroll'
    `,
      [universeId],
    )
  ).rows;
  const counts = new Map<string, { total: number; seen: number }>();
  const add = (placeId: string, seen: boolean) => {
    const c = counts.get(placeId) ?? { total: 0, seen: 0 };
    c.total += 1;
    if (seen) c.seen += 1;
    counts.set(placeId, c);
  };
  // A Scroll counts once: toward the sighting its primary concept is, or else toward its home place.
  for (const r of primaries) {
    const sighting = liveAnchor.get(r.code);
    if (sighting?.kind === 'sighting') {
      add(sighting.placeId, r.seen);
      continue;
    }
    const h = home(r.code);
    if (h) add(h, r.seen);
  }
  const accounts = new Map(
    (
      await client.query<{
        code: string;
        state: string;
        episodes: number;
        days_active: number;
        source_families: number;
      }>(
        `
      SELECT
        c.code,
        a.state,
        a.episodes,
        a.days_active,
        a.source_families
      FROM
        attention_account a
        JOIN concept c ON c.id = a.concept_id
      WHERE
        a.universe_id = $1
    `,
        [universeId],
      )
    ).rows.map((r) => [
      r.code,
      {
        state: r.state,
        episodes: r.episodes,
        daysActive: r.days_active,
        sourceFamilies: r.source_families,
      },
    ]),
  );
  const demands = await placeDemands(client, universeId);
  const formed = new Map(
    (
      await client.query<{ place_id: string; created_at: Date; kind: string }>(
        `
      SELECT DISTINCT
        ON (place_id) place_id,
        created_at,
        kind
      FROM
        atlas_delta
      WHERE
        universe_id = $1
        AND before IS NULL
      ORDER BY
        place_id,
        created_at
    `,
        [universeId],
      )
    ).rows.map((r) => [r.place_id, r]),
  );

  const between = substrate.relations.filter(
    (r) =>
      liveAnchor.has(r.from) &&
      liveAnchor.has(r.to) &&
      liveAnchor.get(r.from)!.kind !== 'sighting' &&
      liveAnchor.get(r.to)!.kind !== 'sighting',
  );
  const refs = await describeRefs(client, [
    ...between,
    ...places.flatMap((p) => [
      ...(p.basis ? [p.basis] : []),
      ...(p.loadBearing ? (p.foundationBasis ?? []) : []),
    ]),
  ]);

  const rooms = await readPlaceRooms(client, universeId);
  const deltas = (
    await client.query<
      DeltaNaming & {
        id: string;
        place_id: string;
        created_at: Date;
        parent_place_id: string | null;
      }
    >(
      `SELECT d.id, d.place_id, d.kind, d.causal_class, d.created_at, d.evidence, c.code AS anchor, pc.code AS parent_anchor, pp.id AS parent_place_id
     FROM atlas_delta d ${DELTA_PLACES}
     WHERE d.universe_id = $1 AND d.kind <> 'sighting_promoted' ORDER BY d.created_at DESC, d.id LIMIT 20`,
      [universeId],
    )
  ).rows;
  const nameOf = (code: string | null) =>
    code === null ? null : (names.get(code)?.name ?? code);
  // What a foundation holds up is always among the reader's live planets and regions, by active
  // connections: one whose place has gone or whose source was revoked is not shown, and a
  // foundation left holding nothing up shows as none until the next plan records it.
  const active = new Set(substrate.relations.map(relationKey));
  const foundationOf = (
    p: PlaceRow,
  ): AtlasView['places'][number]['foundation'] => {
    if (!p.loadBearing || !p.foundationBasis) return null;
    // A connection revoked since the last refresh (a source correction) is not shown either.
    const standing = p.foundationBasis.filter((r) => {
      const t = liveAnchor.get(r.to);
      return !!t && t.kind !== 'sighting' && active.has(relationKey(r));
    });
    const holdsUp = [
      ...new Set(standing.map((r) => liveAnchor.get(r.to)!.placeId)),
    ];
    if (holdsUp.length === 0) return null;
    return {
      holdsUp,
      relations: standing.map((r) => ({
        kind: r.kind,
        from: nameOf(r.from)!,
        to: nameOf(r.to)!,
        ...refs(r),
      })),
    };
  };

  return {
    policyVersion: CARTOGRAPHER_POLICY,
    places: places.map((p) => {
      const anchor = names.get(p.anchor)!;
      const f = formed.get(p.placeId);
      return {
        placeId: p.placeId,
        kind: p.kind,
        parentPlaceId: p.parentAnchor
          ? (liveAnchor.get(p.parentAnchor)?.placeId ?? null)
          : null,
        anchor: {
          code: p.anchor,
          name: anchor.name,
          description: anchor.description,
        },
        basis: p.basis
          ? {
              kind: p.basis.kind,
              from: nameOf(p.basis.from)!,
              to: nameOf(p.basis.to)!,
              ...refs(p.basis),
            }
          : null,
        // A sighting is by definition not yet met: it never carries the reader's attention.
        attention:
          p.kind === 'sighting' ? null : (accounts.get(p.anchor) ?? null),
        scrolls: counts.get(p.placeId) ?? { total: 0, seen: 0 },
        formedAt: f ? toIsoString(f.created_at) : toIsoString(new Date()),
        formedBy: f?.kind ?? 'place_formed',
        foundation: foundationOf(p),
        rooms: rooms.get(p.placeId) ?? [],
        demand: demands.get(p.anchor) ?? null,
      };
    }),
    relations: between.map((r) => ({
      fromPlaceId: liveAnchor.get(r.from)!.placeId,
      toPlaceId: liveAnchor.get(r.to)!.placeId,
      kind: r.kind,
      ...refs(r),
    })),
    chronicle: deltas.map((d) => ({
      deltaId: d.id,
      placeId: d.place_id,
      parentPlaceId: d.parent_place_id,
      kind: d.kind,
      causalClass: d.causal_class,
      at: toIsoString(d.created_at),
      line: deltaLine(d, nameOf),
    })),
  };
}

/** One delta and its evidence, readable only in its own universe. */
export async function readAtlasDelta(
  client: pg.PoolClient,
  universeId: string,
  deltaId: string,
) {
  const d = (
    await client.query<{
      id: string;
      place_id: string;
      kind: string;
      causal_class: string;
      policy_version: string;
      evidence: Record<string, unknown>;
      before: unknown;
      after: unknown;
      created_at: Date;
      anchor: string;
      name: string;
    }>(
      `
      SELECT
        d.id,
        d.place_id,
        d.kind,
        d.causal_class,
        d.policy_version,
        d.evidence,
        d.before,
        d.after,
        d.created_at,
        c.code AS anchor,
        c.name
      FROM
        atlas_delta d
        JOIN atlas_place p ON p.id = d.place_id
        JOIN concept c ON c.id = p.anchor_concept_id
      WHERE
        d.id = $1
        AND d.universe_id = $2
    `,
      [deltaId, universeId],
    )
  ).rows[0];
  if (!d) throw new AtlasNotFound();
  const relation = d.evidence.relation as TypedRelation | undefined;
  const described = relation
    ? (await describeRefs(client, [relation], true))(relation)
    : null;
  return {
    deltaId: d.id,
    placeId: d.place_id,
    kind: d.kind,
    causalClass: d.causal_class,
    policyVersion: d.policy_version,
    at: toIsoString(d.created_at),
    anchor: { code: d.anchor, name: d.name },
    before: d.before,
    after: d.after,
    evidence: {
      ...d.evidence,
      ...(described ? { relationSupport: described } : {}),
    },
  };
}
