import { sql, type Kysely, type Transaction } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { Catalogue } from '../application/catalogue.js';
import { planRelease, type ReleaseChange, type ReleasePlan, type ReleaseSummary } from '../domain/catalogue/release.js';
import { makeSnapshot, type CatalogueSnapshot } from '../domain/catalogue/snapshot.js';
import type { NodeKind, NodeRow, ReleaseRows, RevisionRow } from '../domain/catalogue/types.js';
import type { HazeFamilyName, SceneFamilyName } from '../domain/library/plan.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/** The hash every catalogue identity is made with: the one coverage certificates use. */
export const catalogueHash = canonicalSha256;

/** One release, read once and kept: a release never changes, so what is read for it is good for the life of the process. */
interface Loaded {
  readonly key: string;
  readonly rows: ReleaseRows;
  readonly snapshot: CatalogueSnapshot;
}

const KEPT_RELEASES = 8;
const loaded = new Map<string, Loaded>();

/**
 * A release is named by its number, its digest and the moment it was made, so two databases in one process (a test's clones of one
 * template) never share a release that only has the same number.
 */
const keyOf = (releaseId: number, digest: string, madeAt: Date) =>
  `${String(releaseId)}:${digest}:${String(madeAt.getTime())}`;

function keep(entry: Loaded): Loaded {
  loaded.set(entry.key, entry);
  while (loaded.size > KEPT_RELEASES) loaded.delete(loaded.keys().next().value!);
  return entry;
}

/** The release the pointer names, with its digest; `undefined` before the catalogue has been seeded. */
export async function readCurrentRelease(
  db: Queryable,
): Promise<{ releaseId: number; digest: string; madeAt: Date } | undefined> {
  const row = await db
    .selectFrom('content.concept_current as c')
    .innerJoin('content.concept_releases as r', 'r.release_id', 'c.release_id')
    .select(['r.release_id', 'r.digest', 'r.created_at'])
    .executeTakeFirst();
  return row === undefined ? undefined : { releaseId: row.release_id, digest: row.digest, madeAt: row.created_at };
}

async function readRows(db: Queryable, releaseId: number, digest: string): Promise<ReleaseRows> {
  const nodeRows = await db
    .selectFrom('content.concept_nodes')
    .select(['node_id', 'kind', 'parent_id', 'seq', 'introduced_in', 'visible_in', 'retired_in', 'merged_into'])
    .where('introduced_in', '<=', releaseId)
    .orderBy('seq')
    .execute();
  const nodes = nodeRows.map((row): NodeRow => ({
    nodeId: row.node_id,
    kind: row.kind as NodeKind,
    parentId: row.parent_id,
    seq: row.seq,
    introducedIn: row.introduced_in,
    visibleIn: row.visible_in,
    retiredIn: row.retired_in,
    mergedInto: row.merged_into,
  }));
  const columns = sql`node_id, revision, introduced_in, label, meaning, meaning_sha256, compatible_with,
    system_units, planet_units, planet_facets, scene_family, haze`;
  type Stored = {
    node_id: string;
    revision: number;
    introduced_in: number;
    label: string;
    meaning: string;
    meaning_sha256: string;
    compatible_with: string[];
    system_units: number | null;
    planet_units: number | null;
    planet_facets: number | null;
    scene_family: string | null;
    haze: string | null;
  };
  const newest = await sql<Stored>`select distinct on (node_id) ${columns} from content.concept_node_revisions
    where introduced_in <= ${releaseId} order by node_id, revision desc`.execute(db);
  // The wordings a newest revision declared the same meaning: their texts are what an earlier certificate was decided against.
  const wanted = newest.rows.flatMap((row) => row.compatible_with.map((hash) => ({ nodeId: row.node_id, hash })));
  const earlier =
    wanted.length === 0
      ? { rows: [] as Stored[] }
      : await sql<Stored>`select ${columns} from content.concept_node_revisions r
          join unnest(${wanted.map((w) => w.nodeId)}::text[], ${wanted.map((w) => w.hash)}::text[]) as w(node, hash)
            on r.node_id = w.node and r.meaning_sha256 = w.hash
          where r.introduced_in <= ${releaseId}`.execute(db);
  const toRevision = (row: Stored): RevisionRow => ({
    nodeId: row.node_id,
    revision: row.revision,
    introducedIn: row.introduced_in,
    label: row.label,
    meaning: row.meaning,
    meaningSha256: row.meaning_sha256,
    compatibleWith: row.compatible_with,
    systemUnits: row.system_units,
    planetUnits: row.planet_units,
    planetFacets: row.planet_facets,
    sceneFamily: row.scene_family as SceneFamilyName | null,
    haze: row.haze as HazeFamilyName | null,
  });
  return { releaseId, digest, nodes, revisions: [...newest.rows, ...earlier.rows].map(toRevision) };
}

async function loadRelease(db: Queryable, releaseId: number, digest: string, madeAt: Date): Promise<Loaded> {
  const key = keyOf(releaseId, digest, madeAt);
  const known = loaded.get(key);
  if (known !== undefined) return known;
  const rows = await readRows(db, releaseId, digest);
  return keep({ key, rows, snapshot: makeSnapshot(rows, catalogueHash) });
}

/** The current release's rows and snapshot, read in the caller's transaction or on the pool. One pointer read, then the process's own copy. */
async function currentLoaded(db: Queryable): Promise<Loaded> {
  const pointer = await readCurrentRelease(db);
  if (pointer === undefined) throw new Error('CONTENT_CATALOGUE_NOT_SEEDED');
  return loadRelease(db, pointer.releaseId, pointer.digest, pointer.madeAt);
}

/**
 * The current release of the catalogue, read through the given handle: the caller's own transaction, so the release is the one
 * that transaction sees, or the pool. One indexed read of the one-row pointer; the release itself is kept by the process and is
 * read again only when the pointer moves. Shared, nonpersonal tables only.
 */
export async function readCatalogueIn(db: Queryable): Promise<CatalogueSnapshot> {
  return (await currentLoaded(db)).snapshot;
}

/** An earlier release by number, or `undefined` when there is none: what a run that pinned it reads. */
export async function readCatalogueRelease(db: Queryable, releaseId: number): Promise<CatalogueSnapshot | undefined> {
  const row = await db
    .selectFrom('content.concept_releases')
    .select(['release_id', 'digest', 'created_at'])
    .where('release_id', '=', releaseId)
    .executeTakeFirst();
  return row === undefined ? undefined : (await loadRelease(db, row.release_id, row.digest, row.created_at)).snapshot;
}

export interface CatalogueOptions {
  /** How long a process trusts the release it has before it looks at the pointer again. 0 looks every time. Default 5 seconds. */
  readonly revalidateMs?: number;
  /**
   * Whether a stale release is returned at once while the pointer is looked at in the background (default), so a read made inside a
   * transaction never waits for a pool connection, or the look is awaited (tests, which move the pointer and read at once).
   */
  readonly background?: boolean;
}

/**
 * The `Catalogue` over the process's pool: the current release is kept for `revalidateMs` and then checked against the pointer, so a
 * release made by another process is read within seconds without a deploy. A release never changes, so every release this
 * handle has read is kept by its number (the last few): `release(n)` for one of those, and for the current one, answers from memory
 * and never touches the pool, which a read inside a personal transaction must not do (it would hold a second connection while
 * holding the first). Only a release the process has never read is read, once, on the pool. A failed check keeps the release
 * the process has, which is a valid catalogue, and is tried again on the next read.
 */
export function makeCatalogue(db: Kysely<Database>, options: CatalogueOptions = {}): Catalogue {
  const revalidateMs = options.revalidateMs ?? 5000;
  const background = options.background ?? true;
  let current: CatalogueSnapshot | undefined;
  let checkedAt = 0;
  let inflight: Promise<CatalogueSnapshot> | undefined;
  const byNumber = new Map<number, CatalogueSnapshot>();
  const remember = (snapshot: CatalogueSnapshot): CatalogueSnapshot => {
    byNumber.delete(snapshot.releaseId);
    byNumber.set(snapshot.releaseId, snapshot);
    while (byNumber.size > KEPT_RELEASES) byNumber.delete(byNumber.keys().next().value!);
    return snapshot;
  };
  const refresh = (): Promise<CatalogueSnapshot> => {
    inflight ??= readCatalogueIn(db)
      .then((snapshot) => {
        current = remember(snapshot);
        checkedAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return {
    async current() {
      if (current === undefined) return refresh();
      if (Date.now() - checkedAt < revalidateMs) return current;
      if (!background) return refresh();
      // A failed look keeps the release in hand; the next read tries again.
      refresh().catch(() => undefined);
      return current;
    },
    async release(releaseId) {
      const held = current?.releaseId === releaseId ? current : byNumber.get(releaseId);
      if (held !== undefined) return held;
      const read = await readCatalogueRelease(db, releaseId);
      return read === undefined ? undefined : remember(read);
    },
  };
}

export type AppendOutcome =
  | { readonly kind: 'appended'; readonly releaseId: number; readonly digest: string; readonly summary: ReleaseSummary }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly refusals: Extract<ReleasePlan, { kind: 'refused' }>['refusals'] };

export type ReleaseSource = 'plan' | 'visibility' | 'operator';

const CHUNK = 1000;
const chunks = <T>(rows: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, at) => rows.slice(at * CHUNK, (at + 1) * CHUNK));

/**
 * What a release of `changes` would be, from the current catalogue, written nowhere: the dry run of {@link appendRelease}.
 * The plan is judged against the release the pointer names at the moment of the read.
 */
export async function planNextRelease(db: Queryable, changes: readonly ReleaseChange[]): Promise<ReleasePlan> {
  const { rows } = await currentLoaded(db);
  return planRelease(rows, changes, catalogueHash);
}

/**
 * Appends one release made of `changes`, or says why it cannot. One transaction, under the advisory lock `content.concept-releases` so
 * two releases never race: it reads the release the pointer names, checks every change by code (any refusal refuses the whole
 * release and nothing is written), inserts the release row, the new nodes and revisions and the visibility and retirement
 * updates, and moves the pointer forward from the release it read. Shared tables only; no model, no network, no personal root.
 * A release with no change is not made, so running the same import twice is one release.
 */
export async function appendRelease(
  db: Kysely<Database>,
  changes: readonly ReleaseChange[],
  source: ReleaseSource,
): Promise<AppendOutcome> {
  const made = await withTransaction(db, 'content.concept-release', async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('content.concept-releases', 0))`.execute(trx);
    const { rows } = await currentLoaded(trx);
    const plan = planRelease(rows, changes, catalogueHash);
    if (plan.kind !== 'release') return plan;
    await trx
      .insertInto('content.concept_releases')
      .values({
        release_id: plan.releaseId,
        digest: plan.digest,
        source,
        summary: JSON.stringify(plan.summary),
      })
      .execute();
    for (const part of chunks(plan.newNodes))
      await trx
        .insertInto('content.concept_nodes')
        .values(
          part.map((node) => ({
            node_id: node.nodeId,
            kind: node.kind,
            parent_id: node.parentId,
            seq: node.seq,
            status: 'active',
            introduced_in: node.introducedIn,
            visible_in: node.visibleIn,
          })),
        )
        .execute();
    for (const part of chunks(plan.newRevisions))
      await trx
        .insertInto('content.concept_node_revisions')
        .values(
          part.map((revision) => ({
            node_id: revision.nodeId,
            revision: revision.revision,
            introduced_in: revision.introducedIn,
            label: revision.label,
            meaning: revision.meaning,
            meaning_sha256: revision.meaningSha256,
            compatible_with: [...revision.compatibleWith],
            system_units: revision.systemUnits,
            planet_units: revision.planetUnits,
            planet_facets: revision.planetFacets,
            scene_family: revision.sceneFamily,
            haze: revision.haze,
          })),
        )
        .execute();
    for (const update of plan.updates)
      await trx
        .updateTable('content.concept_nodes')
        .set({
          ...(update.visibleIn === undefined ? {} : { visible_in: update.visibleIn }),
          ...(update.retiredIn === undefined ? {} : { retired_in: update.retiredIn, status: 'retired' }),
        })
        .where('node_id', '=', update.nodeId)
        .execute();
    const moved = await trx
      .updateTable('content.concept_current')
      .set({ release_id: plan.releaseId })
      .where('release_id', '=', rows.releaseId)
      .returning('release_id')
      .execute();
    if (moved.length !== 1) throw new Error('CONTENT_CATALOGUE_POINTER_MOVED');
    return plan;
  });
  if (made.kind === 'refused') return { kind: 'refused', refusals: made.refusals };
  if (made.kind === 'unchanged') return { kind: 'unchanged' };
  return { kind: 'appended', releaseId: made.releaseId, digest: made.digest, summary: made.summary };
}
