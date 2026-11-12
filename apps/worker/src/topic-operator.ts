import {
  ConfigurationError,
  readContentOperatorConfig,
  readScrollProductionOperatorConfig,
  readTopicGrowthOperatorConfig,
} from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  CANDIDATE_STATUSES,
  countCandidates,
  decideTopic,
  makeProposeTopic,
  previewTopicProposal,
  proposeUnderLock,
  reviewCandidates,
  topicGrowthLock,
  type CandidateStatus,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const USAGE_PROPOSE = 'content propose-topic --page <https address of a candidate page> [--dry-run]';
const USAGE_LIST = `content topic-candidates [--status ${CANDIDATE_STATUSES.join('|')}]`;
const USAGE_DECIDE = 'content topic approve --topic <topic id> | content topic reject --topic <topic id>';

export interface ProposeTopicOptions {
  readonly page: string | undefined;
  readonly dryRun: boolean;
  readonly dispatchedBy: string;
}

/**
 * `content propose-topic --page <url> [--dry-run]`: asks the topic proposal role once (and, for an invalid answer, repairs once) where a
 * candidate page belongs, and lets code admit it as a topic under an existing system (#674, D-422). The page must be a candidate code found
 * (`content topic-candidates`): an operator never names a page of their own, and the research host list stays a human decision made in code. An
 * admitted topic is a catalogue release that is not servable: nothing is offered, matched or listed until the library has released supply for
 * it, and the gap loop then proposes its recipes. It sends no production job and publishes no Scroll. `--dry-run` builds the frozen context
 * and prints its counts: no provider is called and nothing is stored. The same request reaches the same run, so running it again never pays
 * twice. Shared database and the production harness only: no personal root. Output is codes and counts, never a label or a meaning.
 *
 * Exit status: 0 done (admitted, or already decided), 2 refused, paused, not admitted or failed to get a usable answer, 1 a failure.
 */
export async function proposeTopicCommand(
  options: ProposeTopicOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (options.page === undefined || !/^https:\/\/[^\s]+$/u.test(options.page)) {
    print({ result: 'usage', usage: USAGE_PROPOSE });
    return 2;
  }
  const request = { pageUrl: options.page, dryRun: options.dryRun };
  try {
    const { topicGrowthMaxPerSystem } = readTopicGrowthOperatorConfig(process.env);
    if (options.dryRun) {
      // A dry run reads the shared database only: no model, no production grant and no harness.
      const database = createDatabase<Database>(readContentOperatorConfig(process.env).database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      try {
        const result = await previewTopicProposal(database.db, request, topicGrowthMaxPerSystem);
        print({ command: 'content propose-topic', dryRun: true, ...result });
        return result.kind === 'refused' ? 2 : 0;
      } finally {
        await database.close();
      }
    }
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined) {
      print({ command: 'content propose-topic', result: 'model_refused' });
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
      const propose = makeProposeTopic({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        withScope,
        harness,
        maxTopicsPerSystem: topicGrowthMaxPerSystem,
      });
      // Under the pass's own lock: the command and the scheduled pass never run at the same time, so neither finds the other's attempt half done.
      const result = await proposeUnderLock(topicGrowthLock(database.db), propose, request, abort.signal);
      print({ command: 'content propose-topic', ...result });
      return ['refused', 'paused', 'failed', 'not_admitted', 'busy'].includes(result.kind) ? 2 : 0;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'propose_topic_failed', error });
    return 1;
  }
}

/**
 * `content topic-candidates [--status pending|eligible|rejected|proposed|refused|admitted|blocked_unknown]`: the candidate pages code found, newest
 * first, with their status, the verdict code, how many attempts they had, how many passages the page gives a writer and the topic made, with its
 * label, its meaning, its facets' labels and meanings and whether it is servable yet, and the owner's decision on it, so a person can read what the model
 * wrote and decide (`content topic approve|reject`) before the topic can be served. The page's
 * address is the handle `content propose-topic` takes. No page title and no page text. Read-only; the shared database only.
 */
export async function topicCandidatesCommand(
  options: { readonly status: string | undefined },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const status: CandidateStatus | undefined = CANDIDATE_STATUSES.find((candidate) => candidate === options.status);
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
      const counts = await countCandidates(database.db);
      const candidates = await reviewCandidates(database.db, status === undefined ? {} : { status });
      print({ command: 'content topic-candidates', counts, candidates });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'topic_candidates_failed', error });
    return 1;
  }
}

/**
 * `content topic approve --topic <id>` and `content topic reject --topic <id>` (#674, D-422): the owner's decision on a topic that grew. A grown topic is
 * not servable until it is approved, in addition to the supply every new topic waits for; read its label, meaning and facets in
 * `content topic-candidates --status admitted` first. Approving records who and when and makes the topic servable if it has its supply; rejecting
 * retires the topic by a release (its id is never reused). A decision is made once and never taken back; a topic of the plan has none to make.
 * Shared database only: no provider, no personal root. Output is codes.
 *
 * Exit status: 0 decided, 2 bad usage, no such grown topic, or already decided, 1 a failure.
 */
export async function topicDecisionCommand(
  options: { readonly decision: string | undefined; readonly topic: string | undefined; readonly decidedBy: string },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (
    (options.decision !== 'approve' && options.decision !== 'reject') ||
    options.topic === undefined ||
    !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(options.topic)
  ) {
    print({ result: 'usage', usage: USAGE_DECIDE });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const result = await decideTopic(database.db, {
        topicId: options.topic,
        decision: options.decision,
        decidedBy: options.decidedBy,
      });
      print({ command: `content topic ${options.decision}`, ...result });
      return result.kind === 'approved' || result.kind === 'rejected' ? 0 : 2;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'topic_decision_failed', error });
    return 1;
  }
}
