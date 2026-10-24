import { createHash } from 'node:crypto';
import type { ContinuityAdmission, ContinuityLink } from '../domain/discovery.js';
import type { LibraryRelatedLink, LibrarySeries } from '../domain/library/continuity.js';
import type { RecipeKey } from '../domain/library/index.js';

/** Private authority recorded on every unit and link the library plan admits. It never changes. */
export const LIBRARY_CONTINUITY_AUTHORITY = 'library-plan.continuity.v1';
const SERIES_STRENGTH = 1;
const RELATED_STRENGTH = 0.6;

/** An exact admitted Scroll revision. */
export interface ScrollRef {
  readonly assetId: string;
  readonly assetRevision: number;
}

/** The Scroll revision currently admitted for each recipe that has one. */
export type AdmittedScrolls = ReadonlyMap<RecipeKey, ScrollRef>;

/** What `content.series_units` and `content.continuity_links` hold now, for the declared recipes. */
export interface StoredContinuity {
  /** The latest stored revision of each series, with its units. */
  readonly series: ReadonlyMap<string, { readonly seriesRevision: number; readonly units: readonly StoredUnit[] }>;
  /** Active links whose source is a declared recipe's Scroll. */
  readonly activeLinks: readonly ContinuityLink[];
}
type StoredUnit = ScrollRef & { readonly part: number };

/** What one batch would admit. Empty `series` and `links` mean the store already holds it all. */
export interface ContinuityBatch {
  readonly admission: Pick<ContinuityAdmission, 'series' | 'links'>;
  /** Links the store already holds exactly. */
  readonly unchangedLinks: number;
}

/** `unpublished` lists the parts without an admitted Scroll; when it is not empty the batch is empty. */
export interface SeriesPlan extends ContinuityBatch {
  readonly seriesId: string;
  readonly unpublished: readonly RecipeKey[];
}

export interface RelatedPlan extends ContinuityBatch {
  readonly skipped: readonly { readonly from: RecipeKey; readonly to: RecipeKey; readonly unpublished: RecipeKey[] }[];
}

function sameRef(a: ScrollRef, b: ScrollRef): boolean {
  return a.assetId === b.assetId && a.assetRevision === b.assetRevision;
}

function sameRelation(a: ContinuityLink['relation'], b: ContinuityLink['relation']): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

/** A link id any run derives alike, so a replay or a concurrent run is the same link, not a conflict. */
function linkIdFor(link: Omit<ContinuityLink, 'linkId'>): string {
  const hex = createHash('sha256').update(JSON.stringify(link)).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Decides which of the wanted links the store lacks. A link the store holds exactly is left alone;
 * a slot held by a different link gets the next link revision under a new id, which retires the old.
 */
function newLinks(
  wanted: readonly Omit<ContinuityLink, 'linkId' | 'revision' | 'authorityReference'>[],
  stored: StoredContinuity,
): { readonly links: ContinuityLink[]; readonly unchanged: number } {
  const links: ContinuityLink[] = [];
  let unchanged = 0;
  for (const link of wanted) {
    const held = stored.activeLinks.find(
      (candidate) => sameRef(candidate.source, link.source) && candidate.direction === link.direction,
    );
    if (
      held &&
      sameRef(held.target, link.target) &&
      sameRelation(held.relation, link.relation) &&
      held.strength === link.strength
    ) {
      unchanged++;
      continue;
    }
    const complete = { ...link, revision: (held?.revision ?? 0) + 1, authorityReference: LIBRARY_CONTINUITY_AUTHORITY };
    links.push({ ...complete, linkId: linkIdFor(complete) });
  }
  return { links, unchanged };
}

/**
 * Plans one series: its units as a complete manifest (a new series revision only when the admitted
 * revisions differ from the stored latest one), and a previous and a next link between neighbours.
 * A series with any part unpublished is skipped whole, because a series revision is a complete manifest.
 */
export function planSeries(series: LibrarySeries, admitted: AdmittedScrolls, stored: StoredContinuity): SeriesPlan {
  const unpublished = series.parts.filter((key) => !admitted.has(key));
  if (unpublished.length > 0)
    return { seriesId: series.id, unpublished, admission: { series: [], links: [] }, unchangedLinks: 0 };
  const units = series.parts.map((key, index) => ({ ...admitted.get(key)!, part: index + 1 }));
  const latest = stored.series.get(series.id);
  const held =
    latest !== undefined &&
    latest.units.length === units.length &&
    latest.units.every((unit, index) => unit.part === units[index]!.part && sameRef(unit, units[index]!));
  const seriesRevision = held ? latest.seriesRevision : (latest?.seriesRevision ?? 0) + 1;
  const wanted = units.slice(1).flatMap((unit, index) => {
    const before = units[index]!;
    const step = (source: StoredUnit, target: StoredUnit, direction: 'previous' | 'next') => ({
      source: { assetId: source.assetId, assetRevision: source.assetRevision },
      target: { assetId: target.assetId, assetRevision: target.assetRevision },
      direction,
      relation: { kind: 'series_step' as const, seriesId: series.id, seriesRevision, part: target.part },
      strength: SERIES_STRENGTH,
    });
    return [step(before, unit, 'next'), step(unit, before, 'previous')];
  });
  const { links, unchanged } = newLinks(wanted, stored);
  return {
    seriesId: series.id,
    unpublished: [],
    admission: { series: held ? [] : [{ seriesId: series.id, seriesRevision, units }], links },
    unchangedLinks: unchanged,
  };
}

/** Plans the related moves. One whose source or target has no admitted Scroll is skipped. */
export function planRelated(
  declared: readonly LibraryRelatedLink[],
  admitted: AdmittedScrolls,
  stored: StoredContinuity,
): RelatedPlan {
  const skipped: RelatedPlan['skipped'][number][] = [];
  const wanted: Parameters<typeof newLinks>[0][number][] = [];
  for (const { from, to, label } of declared) {
    const source = admitted.get(from);
    const target = admitted.get(to);
    if (source === undefined || target === undefined) {
      skipped.push({ from, to, unpublished: [from, to].filter((key) => !admitted.has(key)) });
      continue;
    }
    wanted.push({
      source,
      target,
      direction: 'related',
      relation: { kind: 'related_move', label },
      strength: RELATED_STRENGTH,
    });
  }
  const { links, unchanged } = newLinks(wanted, stored);
  return { admission: { series: [], links }, unchangedLinks: unchanged, skipped };
}
