import {
  ConfigurationError,
  readContentOperatorConfig,
  readScrollProductionOperatorConfig,
} from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { RECIPE_STATUSES, type RecipeStatus } from '@knowscroll/backend/modules/content';
import {
  listStoredRecipes,
  makeProposeRecipes,
  previewRecipeProposal,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const USAGE_PROPOSE = 'content propose-recipes --topic <planet id> [--facet <facet id>] [--dry-run]';
const USAGE_LIST = `content recipes [--status ${RECIPE_STATUSES.join('|')}]`;

export interface ProposeRecipesOptions {
  readonly topic: string | undefined;
  readonly facet: string | undefined;
  readonly dryRun: boolean;
  readonly dispatchedBy: string;
}

/**
 * `content propose-recipes --topic <planet id> [--facet <facet id>] [--dry-run]`: asks the brief role once (and, for an invalid
 * answer, repairs once) for new recipes for a planet that exists, and stores the drafts code accepts as `checked` recipes
 * (#674, D-412). It sends no production job and publishes nothing: the operator then produces a stored recipe with
 * `content produce-library --only <key>`, reads its Scroll with `content review-list`, and releases it. `--dry-run` builds the
 * frozen context and prints its counts: no provider is called and nothing is stored. The same request reaches the same run, so
 * running it again never pays twice. Shared database and the production harness only: no personal root.
 *
 * Exit status: 0 done, 2 refused, paused or failed to get a usable answer, 1 a failure.
 */
export async function proposeRecipesCommand(
  options: ProposeRecipesOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (options.topic === undefined || options.topic === '' || options.facet === '') {
    print({ result: 'usage', usage: USAGE_PROPOSE });
    return 2;
  }
  const request = {
    topicId: options.topic,
    ...(options.facet === undefined ? {} : { facetId: options.facet }),
    dryRun: options.dryRun,
  };
  try {
    if (options.dryRun) {
      // A dry run reads the shared database only: no model, no production grant and no harness.
      const database = createDatabase<Database>(readContentOperatorConfig(process.env).database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      try {
        const result = await previewRecipeProposal(database.db, request);
        print({ command: 'content propose-recipes', dryRun: true, ...result });
        return result.kind === 'refused' ? 2 : 0;
      } finally {
        await database.close();
      }
    }
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined) {
      print({ command: 'content propose-recipes', result: 'model_refused' });
      return 2;
    }
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const withScope = makeWithProductionScope(database.db, {
        enabled: config.reasoning.productionEnabled,
        lockTimeoutMs: config.scopeLockTimeoutMs,
      });
      const harness = makeProductionReasoningHarness(
        postgresProductionHarnessPorts({
          db: database.db,
          withProductionScope: withScope,
          enabled: config.reasoning.productionEnabled,
          model,
          logEvent,
          settings: productionHarnessSettings(config.reasoning, options.dispatchedBy),
        }),
      );
      const propose = makeProposeRecipes({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        withScope,
        harness,
      });
      const result = await propose(request, abort.signal);
      print({ command: 'content propose-recipes', ...result });
      return result.kind === 'refused' || result.kind === 'paused' || result.kind === 'failed' ? 2 : 0;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'propose_recipes_failed', error });
    return 1;
  }
}

/**
 * `content recipes [--status checked|queued|produced|retired]`: the recipes stored in the database, newest first, with their
 * key, planet, facet, standing, page count and the passage pool the check found. No brief and no page address: read the
 * Scroll itself with `content review-show`. Read-only; the shared database only.
 */
export async function recipesCommand(
  options: { readonly status: string | undefined },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const status = RECIPE_STATUSES.find((candidate) => candidate === options.status);
  if (options.status !== undefined && status === undefined) {
    print({ result: 'usage', usage: USAGE_LIST });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const recipes = await listStoredRecipes(database.db, status === undefined ? {} : { status });
      const counts: Partial<Record<RecipeStatus, number>> = {};
      for (const recipe of recipes) counts[recipe.status] = (counts[recipe.status] ?? 0) + 1;
      print({ command: 'content recipes', counts, recipes });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'recipes_list_failed', error });
    return 1;
  }
}
