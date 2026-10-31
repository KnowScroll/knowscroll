import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import {
  ConfigurationError,
  readContentOperatorConfig,
  type DatabaseSettings,
} from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  libraryRecipes,
  parseScrollTopic,
  planLibraryProduction,
  planRegeneration,
  REQUEST_BOUND_V2_PER_TOPIC,
} from '@knowscroll/backend/modules/content';
import type { ProductionSend, ScrollTopic } from '@knowscroll/backend/modules/content';
import {
  admitLibraryContinuityUseCase,
  makeEnqueueScrollProduction,
  readLibraryStatus,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

/** Recipes named by `--only a,b,c`, or every recipe; `undefined` when a name is not a recipe key. */
function selectedRecipes(only: string | undefined): readonly ScrollTopic[] | undefined {
  if (only === undefined) return libraryRecipes();
  const keys = only.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}

/** Sends the production job of each take through the producer queue; a job already queued or running is not doubled. */
async function sendProduction(database: DatabaseSettings, sends: readonly ProductionSend[]) {
  const boss = createBoss(database, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  try {
    const enqueue = makeEnqueueScrollProduction(boss);
    const queued: ProductionSend[] = [];
    const alreadyQueued: ProductionSend[] = [];
    for (const send of sends) {
      const sent = await enqueue(send.recipe, send.take);
      (sent === 'queued' ? queued : alreadyQueued).push(send);
    }
    return { queued, alreadyQueued };
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
}

/**
 * `content produce-library [--only <keys>] [--interactive-first] [--dry-run]`: seeds the library
 * through the same `content.produce-scroll` jobs Quartermaster sends. Recipes that already have a
 * Scroll, or that cannot be taken again, are listed as skipped; a rejected recipe gets its next take
 * (at most three) and is listed under `retaking`. Nothing is produced here: a worker with the
 * production grant runs the jobs. The shared database only; no provider and
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
        print({
          command: 'content produce-library',
          dryRun: true,
          wouldQueue: plan.queue,
          retaking: plan.queue.filter((send) => send.take > 1),
          skipped: plan.skipped,
        });
        return 0;
      }
      const { queued, alreadyQueued } = await sendProduction(config.database, plan.queue);
      print({
        command: 'content produce-library',
        queued,
        alreadyQueued,
        retaking: queued.filter((send) => send.take > 1),
        skipped: plan.skipped,
      });
      return 0;
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
 * `content regenerate --only <keys> [--dry-run]` (D-197): makes another take of a v2 library recipe whose
 * Scroll is already served, through the same `content.produce-scroll` job. The new take is stored held and
 * served to nobody until `content release`; the served Scroll keeps serving. A recipe has three takes per
 * production version, so a recipe cannot loop paid production; a new writer version gives new takes. A
 * running take is sent again to resume it. Every other recipe is skipped with the reason
 * (`not_published`, `held`, `spent`, `stopped`, `not_v2`). `--only` is required: regeneration is never a
 * sweep of the library. Nothing is produced here: a worker with the production grant runs the jobs. The
 * shared database only; no provider and no personal root.
 */
export async function regenerateCommand(
  options: { readonly only?: string; readonly dryRun: boolean },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const recipes = options.only === undefined ? undefined : selectedRecipes(options.only);
  if (recipes === undefined) {
    print({
      result: options.only === undefined ? 'usage' : 'recipe_refused',
      usage: 'content regenerate --only <keys> [--dry-run]',
    });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const standing = await readLibraryStatus(database.db, recipes);
      const plan = planRegeneration(standing);
      const resuming = plan.queue.filter(
        (send) => standing.find((row) => row.recipe === send.recipe)?.regeneration === 'running',
      );
      if (options.dryRun) {
        print({
          command: 'content regenerate',
          dryRun: true,
          requestBoundPerTake: REQUEST_BOUND_V2_PER_TOPIC,
          wouldQueue: plan.queue,
          resuming,
          skipped: plan.skipped,
        });
        return 0;
      }
      const { queued, alreadyQueued } = await sendProduction(config.database, plan.queue);
      print({
        command: 'content regenerate',
        requestBoundPerTake: REQUEST_BOUND_V2_PER_TOPIC,
        queued,
        alreadyQueued,
        resuming,
        skipped: plan.skipped,
      });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'regenerate_failed', error });
    return 1;
  }
}

/**
 * `content production-status [--only <keys>]`: every recipe with its state, its Scroll's asset and
 * revision once admitted, and the paid attempts its job holds. A v2 recipe also shows its regeneration
 * state, the takes it has left at this production version and what the answer check said about its
 * latest take. Read-only.
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

/**
 * `content admit-continuity [--dry-run]`: admits the library plan's series (Part tabs) and related
 * moves (Related tabs) between the Scrolls that are published, and lists what it skipped because an
 * end is not published yet. Idempotent. Shared content only: no provider, no personal root.
 */
export async function admitContinuityCommand(
  options: { readonly dryRun: boolean },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const summary = await admitLibraryContinuityUseCase(database.db)(options);
      print({ command: 'content admit-continuity', ...summary });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'admit_continuity_failed', error });
    return 1;
  }
}
