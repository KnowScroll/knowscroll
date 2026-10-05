/**
 * What the Cartographer and the Keeper read: the shared concept substrate and one universe's places.
 * Read-only; callers hold whatever lock their transaction needs (ADR-0036).
 */

import type {
  ConceptNode,
  PlaceView,
  RelationKind,
  TypedRelation,
} from '@knowscroll/core/atlas/cartographer';
import type pg from 'pg';

export interface Substrate {
  concepts: ConceptNode[];
  ids: Map<string, string>;
  codes: Map<string, string>;
  relations: TypedRelation[];
}

export async function loadSubstrate(client: pg.PoolClient): Promise<Substrate> {
  const concepts = (
    await client.query<{
      id: string;
      code: string;
      name: string;
      parent: string | null;
    }>(
      `
      SELECT
        c.id,
        c.code,
        c.name,
        p.code AS parent
      FROM
        concept c
        LEFT JOIN concept p ON p.id = c.parent_id
      ORDER BY
        c.code
    `,
    )
  ).rows;
  const relations: TypedRelation[] = [
    ...(
      await client.query<{
        from: string;
        to: string;
        kind: RelationKind;
        claim_id: string;
      }>(
        `
        SELECT
          f.code AS
        FROM
        ,
          t.code AS TO,
          r.kind,
          r.claim_id
        FROM
          concept_relation r
          JOIN concept f ON f.id = r.from_concept_id
          JOIN concept t ON t.id = r.to_concept_id
        WHERE
          r.status = 'active'
          AND r.kind NOT IN ('narrower_than', 'part_of')
      `,
      )
    ).rows.map((r) => ({
      from: r.from,
      to: r.to,
      kind: r.kind,
      ref: { claimId: r.claim_id },
    })),
    ...(
      await client.query<{
        from: string;
        to: string;
        kind: RelationKind;
        id: string;
      }>(
        `
        SELECT
          f.code AS
        FROM
        ,
          t.code AS TO,
          b.relation_type AS kind,
          b.id
        FROM
          bridge b
          JOIN concept f ON f.id = b.from_concept_id
          JOIN concept t ON t.id = b.to_concept_id
        WHERE
          b.status = 'admitted'
          AND b.scope_kind = 'shared'
      `,
      )
    ).rows.map((r) => ({
      from: r.from,
      to: r.to,
      kind: r.kind,
      ref: { bridgeId: r.id },
    })),
  ];
  return {
    concepts: concepts.map((c) => ({
      code: c.code,
      parent: c.parent,
      name: c.name,
    })),
    ids: new Map(concepts.map((c) => [c.code, c.id])),
    codes: new Map(concepts.map((c) => [c.id, c.code])),
    relations,
  };
}

export type PlaceRow = PlaceView & {
  anchorId: string;
  parentPlaceId: string | null;
};
export async function loadPlaces(
  client: pg.PoolClient,
  universeId: string,
): Promise<PlaceRow[]> {
  return (
    await client.query<{
      id: string;
      anchor: string;
      anchor_id: string;
      kind: PlaceView['kind'];
      parent_anchor: string | null;
      parent_place_id: string | null;
      state: PlaceView['state'];
      basis: TypedRelation | null;
      load_bearing: boolean;
      foundation_basis: TypedRelation[] | null;
    }>(
      `
      SELECT
        p.id,
        c.code AS anchor,
        c.id AS anchor_id,
        p.kind,
        pc.code AS parent_anchor,
        p.parent_place_id,
        p.state,
        p.basis,
        p.load_bearing,
        (
          SELECT
            d.evidence -> 'relations'
          FROM
            atlas_delta d
          WHERE
            d.place_id = p.id
            AND d.kind = 'foundation_recognised'
          ORDER BY
            d.created_at DESC,
            d.id
          LIMIT
            1
        ) AS foundation_basis
      FROM
        atlas_place p
        JOIN concept c ON c.id = p.anchor_concept_id
        LEFT JOIN atlas_place pp ON pp.id = p.parent_place_id
        LEFT JOIN concept pc ON pc.id = pp.anchor_concept_id
      WHERE
        p.universe_id = $1
      ORDER BY
        p.created_at,
        p.id
    `,
      [universeId],
    )
  ).rows.map((r) => ({
    placeId: r.id,
    anchor: r.anchor,
    anchorId: r.anchor_id,
    kind: r.kind,
    parentAnchor: r.parent_anchor,
    parentPlaceId: r.parent_place_id,
    state: r.state,
    basis: r.basis,
    loadBearing: r.load_bearing,
    foundationBasis: r.load_bearing ? r.foundation_basis : null,
  }));
}
