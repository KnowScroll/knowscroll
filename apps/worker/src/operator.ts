import { replayPolicyCommand } from './composer-operator.js';
import {
  admitContinuityCommand,
  produceLibraryCommand,
  productionStatusCommand,
  regenerateCommand,
} from './library-operator.js';
import { journeyCommand } from './journey-operator.js';
import { reelCommand } from './reel-operator.js';
import { roomsCommand } from './rooms-operator.js';
import { backfillLooksCommand } from './scenes-operator.js';
import { recoverOpenDemandCommand } from './supply-operator.js';
import { rejectCommand, releaseCommand, reviewListCommand, reviewShowCommand } from './review-operator.js';
import { writerSpikeCommand } from './writer-spike-operator.js';
import { makeCutroomReelImporter } from '@knowscroll/backend/modules/content/nest-providers';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import {
  ConfigurationError,
  commitForDiagnostics,
  readWorkerOperatorConfig,
  readContentOperatorConfig,
  readScrollProductionOperatorConfig,
  readMediaImportConfig,
  worldForDiagnostics,
} from '@knowscroll/backend/infrastructure/config';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  reasoningOperatorFor,
  configuredModelPort,
  makeProductionReasoningHarness,
  productionHarnessSettings,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  MAX_TAKES_PER_RECIPE,
  parseScrollTopic,
  REQUEST_BOUND_PER_TOPIC,
  requestBoundOf,
} from '@knowscroll/backend/modules/content';
import { produceScrollUseCase, readmitCoverageUseCase } from '@knowscroll/backend/modules/content/nest-providers';

/**
 * `node dist/operator.js <area> <command> [options]`: operator commands of the worker release,
 * run from a server shell with the world's environment (`KS_WORLD`, `DATABASE_URL`). Results are
 * one JSON line on stdout; diagnostics (typed `logEvent` records) go to stderr.
 *
 *   reasoning write-off --attempt <uuid> --reason <text>   unknown → written_off, reason and `cli:<name>` recorded
 *   reasoning unknown [--limit <n>]                        attempts awaiting reconciliation
 *   reasoning sweep-dispatched [--older-than-seconds <n>]  attempts a crash left dispatched -> unknown
 *   reasoning purge-expired                                delete expired protected requests
 *   reasoning rejected [--limit <n>]                       refused answers of Scroll production, newest first
 *   reasoning rejected --attempt <uuid>                    one refused answer with its text and findings
 *   reel check|order|follow|receive|status|write-off|settle  Reels from Cutroom (reel-operator.ts, docs/v2/operations/cutroom-and-spend.md)
 *   journey <id> | journey --account <accountId> [--json]    one record's journey across modules (journey-operator.ts, docs/v2/operations/looking-at-the-system.md)
 *   rooms seed [--dry-run] | rooms moderator --room <slug> --account <uuid> [--remove]   idea rooms, one per library system (rooms-operator.ts)
 *   composer replay-policy --since <date> [--limit <n>] [--intent-weight <x>] [--recent-topic-penalty <x>] [--sweep]   stored vertical decisions re-run under Composer policy v0 and v1; counts only (composer-operator.ts, D-190)
 *   rooms kit|kit-list|kit-review|backdrop|backdrop-list|backdrop-review|spend|backdrop-reconcile|backdrop-write-off   every room's face and painted backdrops within $1 (rooms-face-operator.ts, D-166, D-170)
 *   rooms rituals|ritual-list|ritual-review   a room's daily question and Spot the flaw: draft, list, approve (rooms-ritual-operator.ts, D-176)
 *   scenes backfill-looks [--dry-run] [--limit <n>]       give worlds projected before looks existed their look; moves no slot, seed, family or anchor (scenes-operator.ts, D-102)
 *   content writer-spike-v2 --topics <keys> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]   the v15 writer on real recipes; admits and publishes nothing (writer-spike-operator.ts, S-0)
 *   content regenerate --only <keys> [--dry-run]            another take of a served v2 library Scroll, stored held until release (library-operator.ts, D-197)
 *   content review-list [--all] | review-show --asset <id> [--revision <n>] [--sources]   library v2 Scrolls held for review, and their text with the answer check (review-operator.ts, D-138, D-198)
 *   content release --asset <id> --revision <n> | reject --asset <id> --revision <n> --reason <text>   the two decisions; both are recorded with who and when
 *
 * Exit status: 0 done, 2 refused or not applicable (bad usage, not unknown, missing), 1 failure.
 * MiniMax offers no request lookup: an `unknown` attempt is never resent; a write-off records the
 * unresolved liability and its reason, and does not prove that the provider stopped work.
 */
const usage =
  'usage: operator.js composer replay-policy --since <ISO date> [--limit <1-20000>] [--intent-weight <0-1>] [--recent-topic-penalty <0-1>] [--sweep] | operator.js scenes backfill-looks [--dry-run] [--limit <1-1000>] | operator.js rooms seed [--dry-run] | rooms moderator --room <slug> --account <uuid> [--remove] | rooms kit|kit-list|kit-review|backdrop|backdrop-list|backdrop-review|spend|backdrop-reconcile|backdrop-write-off|rituals|ritual-list|ritual-review (see `rooms` for its options) | operator.js journey <id> | journey --account <accountId> [--json] | operator.js reel <check|order|follow|receive|status|write-off|settle> (see `reel` for its options) | operator.js content produce-scroll --topic <recipe key> [--take <1-3>] [--dry-run] [--resume] | operator.js content writer-spike-v2 --topics <recipe keys> [--out <file>] [--concurrency <1-4>] [--spike-id <id>] | operator.js content produce-library [--only <keys>] [--interactive-first] [--dry-run] | operator.js content regenerate --only <keys> [--dry-run] | operator.js content production-status [--only <keys>] | operator.js supply recover-open-demand [--dry-run] | operator.js content readmit-coverage [--dry-run] | operator.js content admit-continuity [--dry-run] | operator.js content review-list [--all] | content review-show --asset <uuid> [--revision <n>] [--sources] | content release --asset <uuid> --revision <n> | content reject --asset <uuid> --revision <n> --reason <text> | operator.js reasoning write-off --attempt <uuid> --reason <text> | reasoning unknown [--limit <n>] | reasoning sweep-dispatched [--older-than-seconds <n>] | reasoning purge-expired | reasoning rejected [--limit <n>] [--attempt <uuid>]';

const operatorName = /^[a-z_][a-z0-9_.-]{0,31}$/;

/**
 * Who ran the command, for the write-off record: the user behind `sudo` (`SUDO_USER`), else the
 * login user, as `cli:<name>`; `cli:unknown` when neither is a plain user name (the same rule as
 * the API tree's operator command).
 */
function operatorSource(env: NodeJS.ProcessEnv): string {
  const candidates = [env['SUDO_USER'], env['USER'], env['LOGNAME']];
  try {
    candidates.push(userInfo().username);
  } catch {
    // No passwd entry for this uid: the environment's names are all there is.
  }
  const name = candidates.find((candidate) => candidate !== undefined && operatorName.test(candidate));
  return `cli:${name ?? 'unknown'}`;
}

function print(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main(): Promise<number> {
  const logEvent = createEventLog({
    service: 'operator',
    environment: worldForDiagnostics(process.env),
    revision: commitForDiagnostics(process.env),
    destination: process.stderr,
  });
  if (process.argv[2] === 'reel') return reelCommand(process.argv.slice(3), print, logEvent);
  if (process.argv[2] === 'journey') return journeyCommand(process.argv.slice(3), print, logEvent);
  if (process.argv[2] === 'rooms') return roomsCommand(process.argv.slice(3), print, logEvent);
  let args;
  try {
    args = parseArgs({
      args: process.argv.slice(2),
      options: {
        topic: { type: 'string' },
        only: { type: 'string' },
        'interactive-first': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        take: { type: 'string' },
        run: { type: 'string' },
        script: { type: 'string' },
        fixture: { type: 'boolean' },
        attempt: { type: 'string' },
        reason: { type: 'string' },
        limit: { type: 'string' },
        'older-than-seconds': { type: 'string' },
        topics: { type: 'string' },
        out: { type: 'string' },
        concurrency: { type: 'string' },
        'spike-id': { type: 'string' },
        asset: { type: 'string' },
        revision: { type: 'string' },
        all: { type: 'boolean', default: false },
        sources: { type: 'boolean', default: false },
        since: { type: 'string' },
        'intent-weight': { type: 'string' },
        'recent-topic-penalty': { type: 'string' },
        sweep: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({ result: 'usage', usage });
    return 2;
  }
  const [area, command] = args.positionals;
  if (area === 'content' && command === 'produce-scroll' && args.positionals.length === 2) {
    const topic = parseScrollTopic(args.values.topic);
    if (topic === undefined) {
      print({ result: 'topic_refused', requestBound: REQUEST_BOUND_PER_TOPIC });
      return 2;
    }
    const take = args.values.take === undefined ? 1 : Number(args.values.take);
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKES_PER_RECIPE) {
      print({ result: 'take_refused', maxTakes: MAX_TAKES_PER_RECIPE });
      return 2;
    }
    try {
      // Both dry and real paths validate the allowlisted world before touching the database/provider.
      if (args.values['dry-run']) {
        readContentOperatorConfig(process.env);
        print({ command: 'content produce-scroll', outcome: 'dry_run', requestBound: requestBoundOf(topic) });
        return 0;
      }
      const contentConfig = readScrollProductionOperatorConfig(process.env);
      const contentDatabase = createDatabase<Database>(contentConfig.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      try {
        const withScope = makeWithProductionScope(contentDatabase.db, {
          enabled: contentConfig.reasoning.productionEnabled,
          lockTimeoutMs: contentConfig.scopeLockTimeoutMs,
        });
        const model = configuredModelPort(contentConfig.reasoning);
        const harness = makeProductionReasoningHarness(
          postgresProductionHarnessPorts({
            db: contentDatabase.db,
            withProductionScope: withScope,
            enabled: contentConfig.reasoning.productionEnabled,
            model,
            logEvent,
            settings: productionHarnessSettings(contentConfig.reasoning, operatorSource(process.env)),
          }),
        );
        const produce = produceScrollUseCase({
          db: contentDatabase.db,
          authority: { scopeId: 'scroll-supply', generation: contentConfig.productionGeneration },
          withScope,
          harness,
          model: model?.model ?? 'none',
        });
        print({ command: 'content produce-scroll', requestBound: requestBoundOf(topic), outcome: 'starting' });
        const result = await produce(topic, false, abort.signal, args.values.resume, take);
        print({ command: 'content produce-scroll', ...result });
        return result.outcome === 'published' ? 0 : 2;
      } finally {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
        await contentDatabase.close();
      }
    } catch (error) {
      if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
      else logEvent('process.crashed', { reasonCode: 'scroll_production_failed', error });
      return 1;
    }
  }
  if (area === 'content' && command === 'writer-spike-v2' && args.positionals.length === 2)
    return writerSpikeCommand(
      {
        topics: args.values.topics,
        out: args.values.out,
        concurrency: args.values.concurrency,
        spikeId: args.values['spike-id'],
        dispatchedBy: operatorSource(process.env),
      },
      print,
      logEvent,
    );
  if (area === 'content' && command === 'produce-library' && args.positionals.length === 2)
    return produceLibraryCommand(
      {
        ...(args.values.only === undefined ? {} : { only: args.values.only }),
        interactiveFirst: args.values['interactive-first'],
        dryRun: args.values['dry-run'],
      },
      print,
      logEvent,
    );
  if (area === 'content' && command === 'regenerate' && args.positionals.length === 2)
    return regenerateCommand(
      { ...(args.values.only === undefined ? {} : { only: args.values.only }), dryRun: args.values['dry-run'] },
      print,
      logEvent,
    );
  if (area === 'composer' && command === 'replay-policy' && args.positionals.length === 2)
    return replayPolicyCommand(
      {
        since: args.values.since,
        limit: args.values.limit,
        intentWeight: args.values['intent-weight'],
        recentTopicPenalty: args.values['recent-topic-penalty'],
        sweep: args.values.sweep,
      },
      print,
      logEvent,
    );
  if (area === 'scenes' && command === 'backfill-looks' && args.positionals.length === 2)
    return backfillLooksCommand({ dryRun: args.values['dry-run'], limit: args.values.limit }, print, logEvent);
  if (area === 'content' && command === 'review-list' && args.positionals.length === 2)
    return reviewListCommand({ all: args.values.all }, print, logEvent);
  if (area === 'content' && command === 'review-show' && args.positionals.length === 2)
    return reviewShowCommand(
      {
        ...(args.values.asset === undefined ? {} : { asset: args.values.asset }),
        ...(args.values.revision === undefined ? {} : { revision: args.values.revision }),
        sources: args.values.sources,
      },
      print,
      (text) =>
        process.stdout.write(`${text}
`),
      logEvent,
    );
  if (area === 'content' && command === 'release' && args.positionals.length === 2)
    return releaseCommand(
      {
        ...(args.values.asset === undefined ? {} : { asset: args.values.asset }),
        ...(args.values.revision === undefined ? {} : { revision: args.values.revision }),
        decidedBy: operatorSource(process.env),
      },
      print,
      logEvent,
    );
  if (area === 'content' && command === 'reject' && args.positionals.length === 2)
    return rejectCommand(
      {
        ...(args.values.asset === undefined ? {} : { asset: args.values.asset }),
        ...(args.values.revision === undefined ? {} : { revision: args.values.revision }),
        ...(args.values.reason === undefined ? {} : { reason: args.values.reason }),
        decidedBy: operatorSource(process.env),
      },
      print,
      logEvent,
    );
  if (area === 'supply' && command === 'recover-open-demand' && args.positionals.length === 2)
    return recoverOpenDemandCommand({ dryRun: args.values['dry-run'] }, print, logEvent);
  if (area === 'content' && command === 'production-status' && args.positionals.length === 2)
    return productionStatusCommand(args.values.only === undefined ? {} : { only: args.values.only }, print, logEvent);
  if (area === 'content' && command === 'admit-continuity' && args.positionals.length === 2)
    return admitContinuityCommand({ dryRun: args.values['dry-run'] }, print, logEvent);
  if (area === 'content' && command === 'readmit-coverage' && args.positionals.length === 2) {
    // Decides coverage again for generated Scrolls from the current plan. Shared content only: no
    // provider, personal root or network. Refused outside the operator worlds before the database.
    try {
      const config = readContentOperatorConfig(process.env);
      const contentDatabase = createDatabase<Database>(config.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      try {
        const summary = await readmitCoverageUseCase(contentDatabase.db)({ dryRun: args.values['dry-run'] });
        print({ command: 'content readmit-coverage', ...summary });
        return 0;
      } finally {
        await contentDatabase.close();
      }
    } catch (error) {
      if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
      else logEvent('process.crashed', { reasonCode: 'readmit_coverage_failed', error });
      return 1;
    }
  }
  if (area === 'content' && command === 'import-cutroom-reel' && args.positionals.length === 2) {
    if (!args.values.run || !args.values.script) {
      print({
        result: 'usage',
        usage: 'content import-cutroom-reel --run <uuid> --script <name> [--fixture (ci/local only)]',
      });
      return 2;
    }
    try {
      const settings = readMediaImportConfig(process.env);
      const database = createDatabase<Database>(settings.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      try {
        const result = await makeCutroomReelImporter(
          database.db,
          settings,
        )({ runId: args.values.run, script: args.values.script, fixture: args.values.fixture });
        print({ command: 'content import-cutroom-reel', ...result });
        return result.kind === 'refused' ? 2 : 0;
      } finally {
        await database.close();
      }
    } catch (error) {
      if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
      else logEvent('process.crashed', { reasonCode: 'media_import_failed' });
      return 1;
    }
  }
  const known =
    area === 'reasoning' &&
    (command === 'write-off' ||
      command === 'unknown' ||
      command === 'sweep-dispatched' ||
      command === 'purge-expired' ||
      command === 'rejected');
  if (!known || args.positionals.length !== 2) {
    print({ result: 'usage', usage });
    return 2;
  }
  let config;
  try {
    config = readWorkerOperatorConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.start_failed', { reasonCode: 'config_failed', error });
    return 1;
  }
  const database = createDatabase<Database>(config.database, {
    onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
  });
  const operator = reasoningOperatorFor(database.db, logEvent);
  try {
    switch (command) {
      case 'write-off': {
        if (args.values.attempt === undefined || args.values.reason === undefined) {
          print({ result: 'usage', usage });
          return 2;
        }
        const result = await operator.writeOff(args.values.attempt, args.values.reason, operatorSource(process.env));
        print({ command: 'reasoning write-off', result: result.kind, ...result });
        return result.kind === 'written_off' ? 0 : 2;
      }
      case 'unknown': {
        const limit = args.values.limit === undefined ? 50 : Number(args.values.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          print({ result: 'usage', usage });
          return 2;
        }
        const attempts = await operator.listUnknown(limit);
        print({
          command: 'reasoning unknown',
          result: 'listed',
          attempts: attempts.map((attempt) => ({
            ...attempt,
            dispatchedAt: attempt.dispatchedAt === null ? null : attempt.dispatchedAt.toISOString(),
          })),
        });
        return 0;
      }
      case 'sweep-dispatched': {
        const olderThan =
          args.values['older-than-seconds'] === undefined ? 900 : Number(args.values['older-than-seconds']);
        if (!Number.isInteger(olderThan) || olderThan < 0) {
          print({ result: 'usage', usage });
          return 2;
        }
        print({
          command: 'reasoning sweep-dispatched',
          result: 'swept',
          count: await operator.sweepStaleDispatched(olderThan),
        });
        return 0;
      }
      case 'purge-expired': {
        print({ command: 'reasoning purge-expired', result: 'purged', count: await operator.purgeExpired() });
        return 0;
      }
      case 'rejected': {
        if (args.values.attempt !== undefined) {
          const shown = await operator.showRejectedAnswer(args.values.attempt);
          print({ command: 'reasoning rejected', ...shown });
          return shown.kind === 'found' ? 0 : 2;
        }
        const limit = args.values.limit === undefined ? 20 : Number(args.values.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          print({ result: 'usage', usage });
          return 2;
        }
        print({ command: 'reasoning rejected', result: 'listed', answers: await operator.listRejectedAnswers(limit) });
        return 0;
      }
    }
  } catch (error) {
    logEvent('process.crashed', { reasonCode: 'operator_failed', error });
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
