import { sql } from 'kysely';
import { z } from 'zod';
import type { AdmitContinuity } from '../public.js';
import { admissionTransaction } from './postgres-store.js';
const Ref = z.strictObject({ assetId: z.uuid(), assetRevision: z.number().int().min(1) });
const Position = z.strictObject({
  seriesId: z.string().min(1).max(160),
  seriesRevision: z.number().int().min(1),
  part: z.number().int().min(1).max(99),
});
const Admission = z.strictObject({
  authorityReference: z.string().min(1).max(240),
  series: z
    .array(
      z.strictObject({
        seriesId: z.string().min(1).max(160),
        seriesRevision: z.number().int().min(1),
        units: z
          .array(Ref.extend({ part: z.number().int().min(1).max(99) }))
          .min(1)
          .max(99),
      }),
    )
    .max(10),
  links: z
    .array(
      z.strictObject({
        linkId: z.uuid(),
        revision: z.number().int().min(1),
        source: Ref,
        target: Ref,
        direction: z.enum(['previous', 'next', 'related']),
        relation: z.union([
          Position.extend({ kind: z.literal('series_step') }),
          z.strictObject({ kind: z.literal('related_move'), label: z.string().min(1).max(160) }),
        ]),
        strength: z.number().min(0).max(1),
        authorityReference: z.string().min(1).max(240),
      }),
    )
    .max(100),
});
/** Bounded operator admission inside its existing admission transaction, with no personal lock. */
export const admitContinuity: AdmitContinuity = async (tx, input) => {
  const a = Admission.parse(input);
  const db = admissionTransaction(tx);
  if (JSON.stringify(a).length > 65536 || a.series.reduce((n, s) => n + s.units.length, 0) > 100)
    throw new Error('CONTINUITY_ADMISSION_LIMIT');
  // One shared metadata writer at a time, disjoint from personal-root lock order.
  await sql`select pg_advisory_xact_lock(hashtextextended('content.continuity-admission',0))`.execute(db);
  const checkRef = async (ref: z.infer<typeof Ref>) => {
    const r = await sql<{
      explanation_unit_id: string;
      document: unknown;
    }>`select r.explanation_unit_id,r.document from content.asset_revisions r join content.assets a on a.id=r.asset_id and a.status='admitted' where r.asset_id=${ref.assetId}::uuid and r.revision=${ref.assetRevision}`.execute(
      db,
    );
    if (!r.rows[0]) throw new Error('CONTINUITY_REVISION_UNAVAILABLE');
    return r.rows[0];
  };
  for (const series of a.series) {
    if (
      new Set(series.units.map((u) => u.part)).size !== series.units.length ||
      new Set(series.units.map((u) => `${u.assetId}@${String(u.assetRevision)}`)).size !== series.units.length
    )
      throw new Error('CONTINUITY_SERIES_CONTRADICTORY');
    for (const unit of series.units) {
      const revision = await checkRef(unit);
      const declared = (revision.document as { series?: { seriesId?: string; part?: number } }).series;
      if (declared && (declared.seriesId !== series.seriesId || declared.part !== unit.part))
        throw new Error('CONTINUITY_SERIES_CONTRADICTORY');
      const inserted =
        await sql`insert into content.series_units(series_id,series_revision,part,asset_id,asset_revision,authority_reference) values(${series.seriesId},${series.seriesRevision},${unit.part},${unit.assetId}::uuid,${unit.assetRevision},${a.authorityReference}) on conflict do nothing returning part`.execute(
          db,
        );
      if (!inserted.rows.length) {
        const exact =
          await sql`select part from content.series_units where series_id=${series.seriesId} and series_revision=${series.seriesRevision} and part=${unit.part} and asset_id=${unit.assetId}::uuid and asset_revision=${unit.assetRevision} and authority_reference=${a.authorityReference}`.execute(
            db,
          );
        if (!exact.rows.length) throw new Error('CONTINUITY_SERIES_CONFLICT');
      }
    }
  }
  const slots = new Set<string>();
  for (const link of a.links) {
    const slot = `${link.source.assetId}@${String(link.source.assetRevision)}:${link.direction}`;
    if (slots.has(slot) || link.authorityReference !== a.authorityReference)
      throw new Error('CONTINUITY_LINK_CONTRADICTORY');
    slots.add(slot);
    const source = await checkRef(link.source);
    const target = await checkRef(link.target);
    if (source.explanation_unit_id === target.explanation_unit_id) throw new Error('CONTINUITY_IS_FORMAT_VARIANT');
    if (link.direction === 'related' ? link.relation.kind !== 'related_move' : link.relation.kind !== 'series_step')
      throw new Error('CONTINUITY_RELATION_MISMATCH');
    if (link.relation.kind === 'series_step') {
      const rel = link.relation;
      const parts = await sql<{
        part: number;
        asset_id: string;
        asset_revision: number;
      }>`select part,asset_id,asset_revision from content.series_units where series_id=${rel.seriesId} and series_revision=${rel.seriesRevision} and part in (${rel.part},${rel.part + (link.direction === 'next' ? -1 : 1)})`.execute(
        db,
      );
      const to = parts.rows.find((p) => p.part === rel.part);
      const from = parts.rows.find((p) => p.part !== rel.part);
      if (
        !to ||
        !from ||
        to.asset_id !== link.target.assetId ||
        to.asset_revision !== link.target.assetRevision ||
        from.asset_id !== link.source.assetId ||
        from.asset_revision !== link.source.assetRevision
      )
        throw new Error('CONTINUITY_NOT_DECLARED_NEIGHBOR');
    }
    const existing = await sql<{
      revision: number;
      relation: unknown;
      target_asset_id: string;
      target_asset_revision: number;
      id: string;
      strength: number;
      authority_reference: string;
    }>`select id,revision,relation,target_asset_id,target_asset_revision,strength,authority_reference from content.continuity_links where source_asset_id=${link.source.assetId}::uuid and source_asset_revision=${link.source.assetRevision} and direction=${link.direction} and active`.execute(
      db,
    );
    const old = existing.rows[0];
    if (old) {
      if (old.id === link.linkId) {
        if (
          old.revision !== link.revision ||
          old.target_asset_id !== link.target.assetId ||
          old.target_asset_revision !== link.target.assetRevision ||
          old.strength !== link.strength ||
          old.authority_reference !== link.authorityReference ||
          JSON.stringify(Object.entries(old.relation as object).sort()) !==
            JSON.stringify(Object.entries(link.relation).sort())
        )
          throw new Error('CONTINUITY_LINK_CONFLICT');
        continue;
      }
      if (link.revision <= old.revision) throw new Error('CONTINUITY_LINK_STALE');
      await sql`update content.continuity_links set active=false where id=${old.id}::uuid`.execute(db);
    }
    await sql`insert into content.continuity_links(id,revision,source_asset_id,source_asset_revision,target_asset_id,target_asset_revision,direction,relation,strength,authority_reference) values(${link.linkId}::uuid,${link.revision},${link.source.assetId}::uuid,${link.source.assetRevision},${link.target.assetId}::uuid,${link.target.assetRevision},${link.direction},${JSON.stringify(link.relation)}::jsonb,${link.strength},${link.authorityReference})`.execute(
      db,
    );
  }
};
