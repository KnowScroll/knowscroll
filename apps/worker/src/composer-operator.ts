import { ConfigurationError, readWorkerOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  COMPOSER_POLICY_V1,
  DEFAULT_VARIANTS,
  startPolicyReplay,
  withVerticalWeights,
  type ReplayVariant,
} from '@knowscroll/backend/modules/composer';
import { readRetainedDecisions } from '@knowscroll/backend/modules/composer/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20_000;

const usage =
  'usage: operator.js composer replay-policy --since <ISO date> [--limit <1-20000>] [--intent-weight <0-1>] [--recent-topic-penalty <0-1>] [--sweep]';

/** The grid `--sweep` replays v1 under, beside v0: the vertical Intent weight against the recent-topic penalty. */
const SWEEP_INTENT_WEIGHTS = [0.35, 0.25, 0.15, 0.1, 0.05] as const;
const SWEEP_RECENT_TOPIC_PENALTIES = [0, 0.1, 0.25, 0.4] as const;

export interface ReplayPolicyOptions {
  readonly since: string | undefined;
  readonly limit: string | undefined;
  readonly intentWeight: string | undefined;
  readonly recentTopicPenalty: string | undefined;
  readonly sweep: boolean;
}

function unitInterval(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 'invalid';
}

/** The policies to replay: v0 and v1 as shipped, v1 with the given weights, or v0 with a grid of v1 weights. */
function variantsFor(options: {
  readonly intentWeight: number | undefined;
  readonly recentTopicPenalty: number | undefined;
  readonly sweep: boolean;
}): readonly ReplayVariant[] {
  if (options.sweep)
    return [
      DEFAULT_VARIANTS[0]!,
      ...SWEEP_INTENT_WEIGHTS.flatMap((intent) =>
        SWEEP_RECENT_TOPIC_PENALTIES.map((recentTopic) =>
          withVerticalWeights(COMPOSER_POLICY_V1, { intent, recentTopic }),
        ),
      ),
    ];
  if (options.intentWeight === undefined && options.recentTopicPenalty === undefined) return DEFAULT_VARIANTS;
  return [
    DEFAULT_VARIANTS[0]!,
    withVerticalWeights(COMPOSER_POLICY_V1, {
      ...(options.intentWeight === undefined ? {} : { intent: options.intentWeight }),
      ...(options.recentTopicPenalty === undefined ? {} : { recentTopic: options.recentTopicPenalty }),
    }),
  ];
}

/**
 * `composer replay-policy --since <date> [--limit <n>]` (D-190): re-runs the stored vertical decisions
 * recorded since a date, newest first, under Composer policy v0 and v1, and prints counts only: how many
 * first offers stay on the source's topic, how many are another part of its series, how often sticky
 * format fell back, and how many first offers move to another Jev subject (each a possible Jev call under
 * D-058). `--intent-weight` and `--recent-topic-penalty` replay v1 with other numbers; `--sweep` replays v1
 * over a grid of them. It reads the decisions of every account in memory and prints no person, session,
 * asset, title or text: only the counts below. Read-only; no model, no network, no write. Exit 0 done,
 * 2 bad usage, 1 failure.
 */
export async function replayPolicyCommand(
  options: ReplayPolicyOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const since = options.since === undefined ? Number.NaN : Date.parse(options.since);
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  const intentWeight = unitInterval(options.intentWeight);
  const recentTopicPenalty = unitInterval(options.recentTopicPenalty);
  if (
    !Number.isFinite(since) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    intentWeight === 'invalid' ||
    recentTopicPenalty === 'invalid' ||
    (options.sweep && (intentWeight !== undefined || recentTopicPenalty !== undefined))
  ) {
    print({ result: 'usage', usage });
    return 2;
  }
  try {
    const config = readWorkerOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      const replay = startPolicyReplay(variantsFor({ intentWeight, recentTopicPenalty, sweep: options.sweep }));
      for await (const decision of readRetainedDecisions(database.db, { since: new Date(since), limit }))
        replay.add(decision);
      logEvent('operator.read', { route: '/cli/composer/replay-policy', outcome: 'done' });
      print({
        command: 'composer replay-policy',
        since: new Date(since).toISOString(),
        limit,
        ...replay.report(),
      });
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'composer_replay_policy_failed', error });
    return 1;
  }
}
