import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeRecipeBook, type RecipeBook, type StoredRecipes } from '../application/recipe-book.js';
import { readCatalogueIn } from './catalogue-store.js';
import {
  generatedScrollV3PlanOf,
  StoredScrollV3Schema,
  type BookRecipe,
  type RecipeOrigin,
  type RecipeStatus,
} from '../domain/library/generated.js';
import type { ScrollV2Plan } from '../domain/library/plan.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/** One row of `content.recipes`, as the book reads it. */
export interface StoredRecipeRow {
  readonly key: string;
  readonly origin: RecipeOrigin;
  readonly status: RecipeStatus;
  readonly title: string;
  readonly topic_id: string;
  readonly facet_id: string;
  readonly supporting_facet_id: string | null;
  readonly asset_id: string;
  readonly explanation_unit_id: string;
  readonly brief: string;
  readonly pages: readonly string[];
  /** The plain v2 plan an older row holds; null for a row that holds a document v3 plan. */
  readonly scroll_v2: ScrollV2Plan | null;
  /** The document v3 plan of a proposal (`{shape, sections}`), unparsed; null for a row that holds the v2 plan. */
  readonly scroll_v3: unknown;
  readonly proposing_run_id: string | null;
  readonly check_results: unknown;
  readonly created_at: Date;
}

const COLUMNS = sql.raw(
  'key, origin, status, title, topic_id, facet_id, supporting_facet_id, asset_id, explanation_unit_id, brief, pages, scroll_v2, scroll_v3, proposing_run_id, check_results, created_at',
);

/**
 * A stored recipe as the library plan's own shape: never interactive, never drawn with a kit. A proposal carries a document v3 plan
 * (`scroll_v3`: the shape and the section intents; the writer picks the pictures, #781), which is read strictly: a row whose plan does
 * not parse is a defect and is refused loudly, never read as if it had none, because a recipe without a plan would be written as
 * something it was not asked to be. The v2 plan of an older row is carried only when the row has one. `systemId` is the planet's
 * system in the catalogue, empty for a planet the catalogue does not hold.
 */
export function bookRecipeOf(row: StoredRecipeRow, systemId: string): BookRecipe {
  let scrollV3: BookRecipe['scrollV3'];
  if (row.scroll_v3 !== null && row.scroll_v3 !== undefined) {
    const plan = StoredScrollV3Schema.safeParse(row.scroll_v3);
    if (!plan.success) throw new Error(`STORED_RECIPE_PLAN_INVALID: ${row.key}`);
    scrollV3 = generatedScrollV3PlanOf(plan.data);
  }
  return {
    key: row.key,
    origin: row.origin,
    status: row.status,
    title: row.title,
    explanationUnitId: row.explanation_unit_id,
    assetId: row.asset_id,
    systemId,
    topicId: row.topic_id,
    facetId: row.facet_id,
    ...(row.supporting_facet_id === null ? {} : { supportingFacetId: row.supporting_facet_id }),
    interactive: false,
    interactiveKind: null,
    brief: row.brief,
    pages: row.pages,
    ...(row.scroll_v2 === null ? {} : { scrollV2: row.scroll_v2 }),
    ...(scrollV3 === undefined ? {} : { scrollV3 }),
  };
}

/** The stored recipes, read from `content.recipes` on the caller's handle or transaction. */
export function makeStoredRecipes(db: Queryable): StoredRecipes {
  const booked = async (rows: readonly StoredRecipeRow[]): Promise<BookRecipe[]> => {
    if (rows.length === 0) return [];
    const catalogue = await readCatalogueIn(db);
    return rows.map((row) => bookRecipeOf(row, catalogue.systemOf(row.topic_id) ?? ''));
  };
  return {
    async get(key) {
      const row = (await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes where key = ${key}`.execute(db))
        .rows[0];
      return row === undefined ? undefined : (await booked([row]))[0];
    },
    async ofPlanet(topicId) {
      const { rows } = await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes
        where topic_id = ${topicId} and status <> 'retired' order by created_at, key`.execute(db);
      return booked(rows);
    },
    async all() {
      const { rows } =
        await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes order by created_at, key`.execute(db);
      return booked(rows);
    },
  };
}

/** The recipe book over a database handle or a transaction: code recipes first, then the stored ones. */
export const recipeBookOf = (db: Queryable): RecipeBook => makeRecipeBook(makeStoredRecipes(db));
