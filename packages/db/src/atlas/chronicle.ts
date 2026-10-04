/**
 * The chronicle's deterministic lines (ADR-0036): wording comes from core's `chronicleLine`, never
 * from a model. `DELTA_PLACES` is SQL text shared by the readers that name a delta's places.
 */

import type { RelationKind } from '@knowscroll/core/atlas/cartographer';
import { chronicleLine } from '@knowscroll/core/atlas/chronicle';
import type pg from 'pg';

/** What names a delta's chronicle line: the place it changed, and the parent it belonged to then. */
export const DELTA_PLACES = `JOIN atlas_place p ON p.id = d.place_id JOIN concept c ON c.id = p.anchor_concept_id
     LEFT JOIN atlas_place pp ON pp.id = COALESCE((d.after->>'parentPlaceId')::uuid, (d.before->>'parentPlaceId')::uuid)
     LEFT JOIN concept pc ON pc.id = pp.anchor_concept_id`;

/** A delta row with the anchor codes [DELTA_PLACES] selects as `anchor` and `parent_anchor`. */
export type DeltaNaming = {
  kind: string;
  causal_class: string;
  evidence: Record<string, unknown>;
  anchor: string;
  parent_anchor: string | null;
};

/** The chronicle's own deterministic line for one delta (ADR-0036), never model text. */
export function deltaLine(
  d: DeltaNaming,
  nameOf: (code: string | null) => string | null,
): string {
  const relation = d.evidence.relation as
    | { kind: RelationKind; from: string; to: string }
    | undefined;
  return chronicleLine({
    kind: d.kind,
    causalClass: d.causal_class,
    name: nameOf(d.anchor)!,
    parentName: nameOf(d.parent_anchor),
    relation: relation
      ? {
          kind: relation.kind,
          fromName: nameOf(relation.from)!,
          toName: nameOf(relation.to)!,
        }
      : null,
    holdsUp: ((d.evidence.holdsUp as string[] | undefined) ?? []).map(
      (code) => nameOf(code)!,
    ),
  });
}

/** Lines for a few deltas, naming only the concepts they mention (the return, a place Relic). */
export async function deltaLines(
  client: pg.PoolClient,
  deltas: readonly DeltaNaming[],
): Promise<(d: DeltaNaming) => string> {
  const codes = [
    ...new Set(
      deltas
        .flatMap((d) => {
          const relation = d.evidence.relation as
            | { from?: string; to?: string }
            | undefined;
          return [
            d.anchor,
            d.parent_anchor,
            relation?.from,
            relation?.to,
            ...((d.evidence.holdsUp as string[] | undefined) ?? []),
          ];
        })
        .filter((c): c is string => typeof c === 'string'),
    ),
  ];
  const names = new Map(
    (
      await client.query<{ code: string; name: string }>(
        'SELECT code, name FROM concept WHERE code = ANY($1)',
        [codes],
      )
    ).rows.map((r) => [r.code, r.name]),
  );
  const nameOf = (code: string | null) =>
    code === null ? null : (names.get(code) ?? code);
  return (d) => deltaLine(d, nameOf);
}
