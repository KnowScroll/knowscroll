import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { libraryRecipes, parseScrollTopic, planLibraryProduction } from '@knowscroll/backend/modules/content';
import type { ScrollTopic } from '@knowscroll/backend/modules/content';
import { makeEnqueueScrollProduction, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

/** Recipes named by `--only a,b,c`, or every recipe; `undefined` when a name is not a recipe key. */
function selectedRecipes(only: string | undefined): readonly ScrollTopic[] | undefined {
  if (only === undefined) return libraryRecipes();
  const keys = only.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}

/**
 * `content produce-library [--only <keys>] [--interactive-first] [--dry-run]`: seeds the library
 * through the same `content.produce-scroll` jobs Quartermaster sends. Recipes that already have a
 * Scroll, or whose job ended at this recipe version, are listed as skipped. Nothing is produced
 * here: a worker with the production grant runs the jobs. The shared database only; no provider and
 * no personal root.
 */
export async function produceLibraryCommand(
  options: { readonly only?: string; readonly interactiveFirst: boolean; readonly dryRun: boolean },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const recipes = selectedRecipes(options.only);
  if (recipes === undefined) {
    print({ result: 'recipe_refused' });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const plan = planLibraryProduction(await readLibraryStatus(database.db, recipes), {
        interactiveFirst: options.interactiveFirst,
      });
      if (options.dryRun) {
        print({ command: 'content produce-library', dryRun: true, wouldQueue: plan.queue, skipped: plan.skipped });
        return 0;
      }
      const boss = createBoss(config.database, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const enqueue = makeEnqueueScrollProduction(boss);
        const queued: string[] = [];
        const alreadyExists: string[] = [];
        for (const recipe of plan.queue) {
          const sent = await enqueue(recipe);
          (sent === 'queued' ? queued : alreadyExists).push(recipe);
        }
        print({ command: 'content produce-library', queued, alreadyExists, skipped: plan.skipped });
        return 0;
      } finally {
        await boss.stop({ graceful: true, timeout: 5000 });
      }
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'produce_library_failed', error });
    return 1;
  }
}

/**
 * `content production-status [--only <keys>]`: every recipe with its state, its Scroll's asset and
 * revision once admitted, and the paid attempts its job holds. Read-only.
 */
export async function productionStatusCommand(
  options: { readonly only?: string },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const recipes = selectedRecipes(options.only);
  if (recipes === undefined) {
    print({ result: 'recipe_refused' });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const standing = await readLibraryStatus(database.db, recipes);
      const counts: Record<string, number> = {};
      for (const row of standing) counts[row.state] = (counts[row.state] ?? 0) + 1;
      print({ command: 'content production-status', counts, recipes: standing });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'production_status_failed', error });
    return 1;
  }
}
