import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import type { CatalogueBrief, ChooseRecipeOptions, GapRecipe, ScrollRecipeChoice } from '../../content/public.js';
import type { GrowthStore, GrowthTx } from '../application/gap-ports.js';

type Queryable = Kysely<Database> | Transaction<Database>;

/** Content's shared reads, bound to a connection: the composition root passes them, so Supply names no Content table or adapter. */
export interface GrowthReads {
  readonly readRecipes: (db: Queryable, target: CatalogueBrief) => Promise<readonly GapRecipe[]>;
  readonly chooseRecipe: (
    db: Queryable,
    brief: CatalogueBrief,
    options: ChooseRecipeOptions,
  ) => Promise<ScrollRecipeChoice>;
}

/** Production groups of stored recipes, started since a moment (what the growth cap counts, whoever asked). */
async function countGrowthSince(db: Kysely<Database> | Transaction<Database>, since: Date): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from supply.work
    where production_recipe like 'gen-%' and created_at >= ${since}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

function growthTx(trx: Transaction<Database>, reads: GrowthReads): GrowthTx {
  return {
    countGrowthSince: (since) => countGrowthSince(trx, since),
    readRecipes: (target) => reads.readRecipes(trx, target),
    chooseRecipe: (brief, options) => reads.chooseRecipe(trx, brief, options),
    async findActiveWork(brief) {
      const { rows } = await sql<{
        id: string;
        production_recipe: string | null;
      }>`select id, production_recipe from supply.work
        where canonical_key = ${requestHash('supply-public-canonical.v1', brief)} and active`.execute(trx);
      const row = rows[0];
      return row === undefined
        ? undefined
        : { id: row.id, ...(row.production_recipe === null ? {} : { recipe: row.production_recipe }) };
    },
    async joinOrCreate(brief, id, recipe) {
      const { rows } = await sql<{
        id: string;
      }>`insert into supply.work(id, canonical_key, brief, production_recipe, commissioned_by)
        values (${id}::uuid, ${requestHash('supply-public-canonical.v1', brief)}, ${JSON.stringify(brief)}::jsonb, ${recipe}, 'growth')
        on conflict (canonical_key) where active do update set canonical_key = excluded.canonical_key returning id`.execute(
        trx,
      );
      return { id: rows[0]!.id, joined: rows[0]!.id !== id };
    },
    async closeWork(id) {
      await sql`update supply.work set active = false, closed_at = now() where id = ${id}::uuid and active`.execute(
        trx,
      );
    },
  };
}

/**
 * The growth commissioning's store (#674, D-414): the shared production groups, with no person. One transaction takes the
 * commissioning lock first, the same advisory lock Create takes (`supply.commissioning`), so the day's growth count and the groups
 * started agree whoever starts them.
 */
export const growthStore = (db: Kysely<Database>, reads: GrowthReads): GrowthStore => ({
  inCommissioning: (work) =>
    withTransaction(db, 'supply.commission-growth', async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('supply.commissioning', 0))`.execute(trx);
      return work(growthTx(trx, reads));
    }),
  countGrowthSince: (since) => countGrowthSince(db, since),
});
