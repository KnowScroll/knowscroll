import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeRecipeBook, systemOfTopic, type RecipeBook, type StoredRecipes } from '../application/recipe-book.js';
import type { BookRecipe, RecipeOrigin, RecipeStatus } from '../domain/library/generated.js';
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
  readonly scroll_v2: ScrollV2Plan;
  readonly proposing_run_id: string | null;
  readonly check_results: unknown;
  readonly created_at: Date;
}

const COLUMNS = sql.raw(
  'key, origin, status, title, topic_id, facet_id, supporting_facet_id, asset_id, explanation_unit_id, brief, pages, scroll_v2, proposing_run_id, check_results, created_at',
);

/** A stored recipe as the library plan's own shape: a plain Scroll, never interactive, never drawn with a kit. */
export function bookRecipeOf(row: StoredRecipeRow): BookRecipe {
  return {
    key: row.key,
    origin: row.origin,
    status: row.status,
    title: row.title,
    explanationUnitId: row.explanation_unit_id,
    assetId: row.asset_id,
    systemId: systemOfTopic(row.topic_id),
    topicId: row.topic_id,
    facetId: row.facet_id,
    ...(row.supporting_facet_id === null ? {} : { supportingFacetId: row.supporting_facet_id }),
    interactive: false,
    interactiveKind: null,
    brief: row.brief,
    pages: row.pages,
    scrollV2: row.scroll_v2,
  };
}

/** The stored recipes, read from `content.recipes` on the caller's handle or transaction. */
export function makeStoredRecipes(db: Queryable): StoredRecipes {
  return {
    async get(key) {
      const row = (await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes where key = ${key}`.execute(db))
        .rows[0];
      return row === undefined ? undefined : bookRecipeOf(row);
    },
    async ofPlanet(topicId) {
      const { rows } = await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes
        where topic_id = ${topicId} and status <> 'retired' order by created_at, key`.execute(db);
      return rows.map(bookRecipeOf);
    },
    async all() {
      const { rows } =
        await sql<StoredRecipeRow>`select ${COLUMNS} from content.recipes order by created_at, key`.execute(db);
      return rows.map(bookRecipeOf);
    },
  };
}

/** The recipe book over a database handle or a transaction: code recipes first, then the stored ones. */
export const recipeBookOf = (db: Queryable): RecipeBook => makeRecipeBook(makeStoredRecipes(db));
