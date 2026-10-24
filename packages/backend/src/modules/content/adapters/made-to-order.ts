import { sql, type Kysely } from 'kysely';
import { Framing } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readerOn, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { RECIPE_KEYS, RECIPES } from '../domain/library/index.js';
import { productionStanding, takeToSend, type ProductionJobState } from '../domain/library/serving.js';
import { madeToOrderKey } from '../domain/order-key.js';
import { SCROLL_PRODUCTION_VERSION } from '../production/topics.js';
import type {
  CheckAssetAudience,
  ReadMadeToOrderProduction,
  ReadOrderAudience,
  ReadScrollSourcePages,
  RecordMadeToOrderScroll,
} from '../public.js';

/** The most research pages one order may rest on; a recipe names one to three. */
const MAX_PAGES = 3;

/**
 * Stores an order in the caller's transaction. The order's identity is its recipe key, so the same
 * order sent twice is one row, and nothing about it is rewritten after the first. The explanation
 * identity of an ordered Scroll is its own key: it shares no explanation with the subject it
 * comments on, so it can never be counted as that subject twice.
 */
export const recordMadeToOrderScroll: RecordMadeToOrderScroll = async (scope, order) => {
  const recipe = madeToOrderKey(order.orderId);
  const framing = Framing.parse(order.framing);
  await sql`insert into content.made_to_order_scrolls (recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing)
    values (${recipe}, ${order.assetId}::uuid, ${recipe}, ${order.mode}, ${order.brief}, ${order.pages}::text[], ${order.kicker}, ${JSON.stringify(framing)}::jsonb)
    on conflict (recipe) do nothing`.execute(transactionOf(scope));
  return { recipe };
};

/**
 * An order's production standing from its jobs at the current recipe version, and the admitted Scroll
 * once there is one. Shared nonpersonal tables only, so the resolver reads it without any scope.
 */
export function makeReadMadeToOrderProduction(db: Kysely<Database>): ReadMadeToOrderProduction {
  return async (recipe) => {
    const order = await db
      .selectFrom('content.made_to_order_scrolls')
      .select('asset_id')
      .where('recipe', '=', recipe)
      .executeTakeFirst();
    if (order === undefined) return { state: 'stopped' };
    const jobs = (
      await sql<{ state: ProductionJobState }>`select state from content.scroll_production_runs
        where topic = ${recipe} and policy_version = ${SCROLL_PRODUCTION_VERSION} order by take`.execute(db)
    ).rows;
    const asset = await db
      .selectFrom('content.assets as asset')
      .innerJoin('content.asset_revisions as revision', (join) =>
        join.onRef('revision.asset_id', '=', 'asset.id').onRef('revision.revision', '=', 'asset.revision'),
      )
      .select(['asset.revision', 'asset.status', 'revision.title'])
      .where('asset.id', '=', order.asset_id)
      .executeTakeFirst();
    const admitted = asset?.status === 'admitted';
    const state = productionStanding(
      jobs.map((job) => job.state),
      admitted,
    );
    const take = takeToSend(state, jobs.length);
    return {
      state,
      ...(take === undefined ? {} : { take }),
      ...(admitted
        ? { published: { assetId: order.asset_id, assetRevision: asset.revision, title: asset.title } }
        : {}),
    };
  };
}

/** Every `https` page of a provenance record's sources, in order, without repeats. */
function pagesOf(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const urls = sources.flatMap((source: unknown) => {
    const url = typeof source === 'object' && source !== null && 'url' in source ? source.url : undefined;
    return typeof url === 'string' && url.startsWith('https://') ? [url] : [];
  });
  return [...new Set(urls)];
}

/**
 * The pages a what-if of this revision may draw on, chosen by code: the revision's own recorded
 * sources; else those of an admitted Scroll that gives the same explanation (a Reel's twin, a Scroll's
 * other revision); else the pages of the library recipe of that explanation. A page a person or a
 * model named never enters. Production fetches them through the same allowlisted research boundary as
 * a library recipe, so a source outside it ends the take.
 */
export const readScrollSourcePages: ReadScrollSourcePages = async (scope, root) => {
  const trx = transactionOf(scope);
  const unit = await trx
    .selectFrom('content.asset_revisions')
    .select('explanation_unit_id')
    .where('asset_id', '=', root.assetId)
    .where('revision', '=', root.assetRevision)
    .executeTakeFirst();
  if (unit === undefined) return [];
  const records = await sql<{ sources: unknown }>`
    select p.provenance -> 'sources' as sources
    from content.asset_revisions r
    join content.assets a on a.id = r.asset_id and a.kind = 'scroll' and a.status = 'admitted'
    join content.asset_provenance p on p.asset_id = r.asset_id and p.revision = r.revision
    where r.explanation_unit_id = ${unit.explanation_unit_id}
      and not exists (select 1 from content.made_to_order_scrolls o where o.asset_id = r.asset_id)
    order by (r.asset_id = ${root.assetId}::uuid and r.revision = ${root.assetRevision}) desc, r.admitted_at, r.asset_id, r.revision desc
    limit 8`.execute(trx);
  for (const record of records.rows) {
    const pages = pagesOf(record.sources);
    if (pages.length > 0) return pages.slice(0, MAX_PAGES);
  }
  const library = RECIPE_KEYS.find((key) => RECIPES[key].explanationUnitId === unit.explanation_unit_id);
  return library === undefined ? [] : RECIPES[library].pages.slice(0, MAX_PAGES);
};

/**
 * Which of these assets may this caller open or read. An asset with no order is as public as it always
 * was; one with an order is open only to the audience the ordering module names, and to no one if none
 * does. One query finds the orders; the ordering module is asked once for them all.
 */
export function makeCheckAssetAudience(db: Kysely<Database>, readOrderAudience: ReadOrderAudience): CheckAssetAudience {
  return async (on, authority, assetIds) => {
    if (assetIds.length === 0) return new Set();
    // An ID is the same ID in any letter case; the stored ones are lower case, so compare in lower case.
    const orders = await readerOn(db, on)
      .selectFrom('content.made_to_order_scrolls')
      .select('asset_id')
      .where(
        'asset_id',
        'in',
        assetIds.map((assetId) => assetId.toLowerCase()),
      )
      .execute();
    const ordered = orders.map((order) => order.asset_id.toLowerCase());
    const held = ordered.length === 0 ? new Set<string>() : await readOrderAudience(on, authority, ordered);
    const orderedSet = new Set(ordered);
    return new Set(
      assetIds.filter((assetId) => {
        const id = assetId.toLowerCase();
        return !orderedSet.has(id) || held.has(id);
      }),
    );
  };
}
