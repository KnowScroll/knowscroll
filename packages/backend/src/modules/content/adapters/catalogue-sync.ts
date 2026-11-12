import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { changesToMatch } from '../domain/catalogue/diff.js';
import { nodesOfPlan } from '../domain/catalogue/plan-import.js';
import type { RefusalCode, ReleaseChange, ReleaseSummary } from '../domain/catalogue/release.js';
import { CATALOGUE_LIMITS } from '../domain/catalogue/types.js';
import { topicsNowServable } from '../domain/catalogue/visibility.js';
import { LIBRARY_SYSTEMS } from '../domain/library/index.js';
import type { LibrarySystem } from '../domain/library/plan.js';
import { appendRelease, planNextRelease, readCatalogueIn, type AppendOutcome } from './catalogue-store.js';
import { readReleasedCoverage } from './gap-reads.js';

/** What one `content catalogue sync` did, or would do: counts and codes, never a label, meaning or reader. */
export interface CatalogueSyncSummary {
  readonly dryRun: boolean;
  /** The release the catalogue was at when the command read it, and its digest. */
  readonly releaseBefore: number;
  readonly digestBefore: string;
  /** The plan's imports: `appended` (a release was made), `unchanged` (the catalogue already matches the plan), `refused` (nothing written), `would_append` (dry run). */
  readonly plan: 'appended' | 'unchanged' | 'refused' | 'would_append';
  /** The last release the import made, and how many it made (a plan larger than one release is imported as several). */
  readonly planReleaseId?: number;
  /** Releases made (a dry run: the releases it would make). */
  readonly releasesMade?: number;
  readonly planSummary?: ReleaseSummary;
  readonly refusals?: readonly { readonly code: RefusalCode; readonly nodeId: string }[];
  /** Nodes the catalogue holds that the plan no longer names. Reported only: nothing is retired because a line is missing. */
  readonly missingFromPlan: number;
  /** Topics that now have released supply and are (or, dry run, would be) made servable. */
  readonly nowServable: number;
  readonly servableReleaseId?: number;
  readonly releaseAfter: number;
  readonly digestAfter: string;
}

/**
 * Splits the changes into releases no larger than the limit of one, never between a topic and its facets (a topic needs its facets in
 * its own release). A plan of ten thousand topics is a few releases; each is checked and committed on its own, so an import that
 * stops half way leaves a catalogue that is whole, and running it again carries on.
 */
export function releaseChunks(changes: readonly ReleaseChange[]): readonly (readonly ReleaseChange[])[] {
  const groups: ReleaseChange[][] = [];
  for (const change of changes) {
    const joins = change.kind === 'add' && change.draft.kind === 'facet' && groups.length > 0;
    if (joins) groups.at(-1)!.push(change);
    else groups.push([change]);
  }
  const chunks: ReleaseChange[][] = [];
  let size = 0;
  for (const group of groups) {
    if (chunks.length === 0 || size + group.length > CATALOGUE_LIMITS.nodesPerRelease) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(...group);
    size += group.length;
  }
  return chunks;
}

const ZERO: ReleaseSummary = {
  addedSystems: 0,
  addedTopics: 0,
  addedFacets: 0,
  revised: 0,
  rewordedOnly: 0,
  shown: 0,
  retired: 0,
};
const sum = (a: ReleaseSummary, b: ReleaseSummary): ReleaseSummary => ({
  addedSystems: a.addedSystems + b.addedSystems,
  addedTopics: a.addedTopics + b.addedTopics,
  addedFacets: a.addedFacets + b.addedFacets,
  revised: a.revised + b.revised,
  rewordedOnly: a.rewordedOnly + b.rewordedOnly,
  shown: a.shown + b.shown,
  retired: a.retired + b.retired,
});

/** Makes the servable topics servable: those that now have released, coverage-mapped supply (three units over two facets by default). One release, or none. */
export async function showServableTopics(db: Kysely<Database>): Promise<AppendOutcome> {
  const snapshot = await readCatalogueIn(db);
  const ids = topicsNowServable(snapshot, await readReleasedCoverage(db, snapshot));
  if (ids.length === 0) return { kind: 'unchanged' };
  return appendRelease(
    db,
    ids.map((nodeId) => ({ kind: 'show', nodeId })),
    'visibility',
  );
}

/**
 * `content catalogue sync [--dry-run]` (D-419): imports the TypeScript library plan, which stays the authoring source, as the
 * next release of the catalogue, then makes servable the topics whose supply has been released. The plan's ids, labels, meanings
 * and looks are compared with the current release: what already matches is left alone, so running it twice is one release
 * and a plan that matches the catalogue makes none. A new topic is added, a changed meaning is a new revision (it keeps earlier
 * certificates valid only where the plan declares `sameMeaningAs`), a changed silhouette or haze of an existing node is refused, and a node the plan no longer
 * names is reported, never retired. Any refusal writes nothing. Shared content only: no provider, no personal root, no network.
 * `plan` is the library plan to import; the operator command passes none and gets the plan in code, a test passes a frozen one.
 */
export async function syncCatalogue(
  db: Kysely<Database>,
  options: { readonly dryRun: boolean },
  plan: readonly LibrarySystem[] = LIBRARY_SYSTEMS,
): Promise<CatalogueSyncSummary> {
  const before = await readCatalogueIn(db);
  const difference = changesToMatch(before, nodesOfPlan(plan));
  const base = {
    dryRun: options.dryRun,
    releaseBefore: before.releaseId,
    digestBefore: before.digest,
    missingFromPlan: difference.missingFromPlan.length,
  };
  const done = async (partial: Omit<CatalogueSyncSummary, keyof typeof base | 'releaseAfter' | 'digestAfter'>) => {
    const after = options.dryRun ? before : await readCatalogueIn(db);
    return {
      ...base,
      ...partial,
      releaseAfter: after.releaseId,
      digestAfter: after.digest,
    } satisfies CatalogueSyncSummary;
  };
  if (options.dryRun) {
    // The first release of the import stands for it: the rest are checked as each is made.
    const chunks = releaseChunks(difference.changes);
    const plan = await planNextRelease(db, chunks[0] ?? []);
    const servable = topicsNowServable(before, await readReleasedCoverage(db, before));
    if (plan.kind === 'refused')
      return done({ plan: 'refused', refusals: plan.refusals, nowServable: servable.length });
    if (plan.kind === 'unchanged') return done({ plan: 'unchanged', nowServable: servable.length });
    return done({
      plan: 'would_append',
      planReleaseId: plan.releaseId,
      releasesMade: chunks.length,
      planSummary: plan.summary,
      nowServable: servable.length,
    });
  }
  let planSummary: ReleaseSummary | undefined;
  let planReleaseId: number | undefined;
  let releasesMade = 0;
  for (const chunk of releaseChunks(difference.changes)) {
    const imported = await appendRelease(db, chunk, 'plan');
    if (imported.kind === 'refused') return done({ plan: 'refused', refusals: imported.refusals, nowServable: 0 });
    if (imported.kind === 'appended') {
      planSummary = sum(planSummary ?? ZERO, imported.summary);
      planReleaseId = imported.releaseId;
      releasesMade += 1;
    }
  }
  const shown = await showServableTopics(db);
  const nowServable = shown.kind === 'appended' ? shown.summary.shown : 0;
  return done({
    plan: planSummary === undefined ? 'unchanged' : 'appended',
    ...(planSummary === undefined ? {} : { planReleaseId, releasesMade, planSummary }),
    nowServable,
    ...(shown.kind === 'appended' ? { servableReleaseId: shown.releaseId } : {}),
  });
}

/** Where the catalogue stands, in counts: what `content catalogue status` prints. No label, meaning or reader. */
export interface CatalogueStatus {
  readonly releaseId: number;
  readonly digest: string;
  readonly systems: number;
  readonly topics: number;
  readonly facets: number;
  /** Topics a person can be offered, matched to or given a room for. */
  readonly servableTopics: number;
  /** Topics that exist and wait for released supply (three explanations over two facets by default). */
  readonly waitingTopics: number;
}

export async function catalogueStatus(db: Kysely<Database>): Promise<CatalogueStatus> {
  const snapshot = await readCatalogueIn(db);
  const topics = snapshot.allTopics();
  return {
    releaseId: snapshot.releaseId,
    digest: snapshot.digest,
    systems: snapshot.all().filter((concept) => concept.kind === 'system').length,
    topics: topics.length,
    facets: topics.reduce((total, topic) => total + topic.facets.length, 0),
    servableTopics: snapshot.topics().length,
    waitingTopics: topics.filter((topic) => !topic.servable).length,
  };
}
