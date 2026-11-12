import {
  ConfigurationError,
  readContentAutoReleaseSettings,
  readContentOperatorConfig,
} from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeCatalogue, makeReleasePolicy, type ReleasePolicy } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;

const USAGE = {
  approve: 'content policy approve-topic --topic <catalogue topic id>',
  revoke: 'content policy revoke-topic --topic <topic id>',
  withdraw: 'content policy withdraw --asset <uuid> --revision <n>',
  status: 'content policy status',
} as const;

/** A positive revision number from the command line, or `undefined` when it is anything else. */
function parseRevision(raw: string | undefined): number | undefined {
  const revision = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(revision) && revision >= 1 && revision <= 1_000_000 ? revision : undefined;
}

/** Runs one policy command over its own database handle. Shared content only: no provider, no personal root. */
async function withReleasePolicy(
  reasonCode: string,
  logEvent: LogEvent,
  work: (policy: ReleasePolicy) => Promise<number>,
): Promise<number> {
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      return await work(makeReleasePolicy(database.db, makeCatalogue(database.db)));
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode, error });
    return 1;
  }
}

/**
 * The diagnostic record of a change to the policy, next to the rows that hold who and when (`content.release_topic_approvals`,
 * `content.revision_reviews`): the topic, what happened, the revision for a withdrawal and a refusal's code. Never the Scroll.
 */
function recordChange(
  logEvent: LogEvent,
  change: {
    readonly topicId: string | null;
    readonly outcome: string;
    readonly reason?: string;
    readonly revision?: number;
  },
): void {
  logEvent('content.release_policy_changed', {
    severity: change.outcome === 'refused' ? 'warn' : 'info',
    ...(change.topicId === null ? {} : { context: change.topicId }),
    outcome: change.outcome,
    ...(change.reason === undefined ? {} : { reasonCode: change.reason }),
    ...(change.revision === undefined ? {} : { revision: change.revision }),
  });
}

/**
 * `content policy approve-topic --topic <id>`: a person approves a catalogue topic, so the worker's release step may release a later Scroll of it
 * by itself once the policy is switched on (D-418). Records who and when. Refuses a sensitive topic (medicine, health, law, finance, political or
 * religious history, current events, safety) and anything the catalogue does not hold as a topic. Idempotent. It releases nothing: the policy
 * is off until `KS_CONTENT_AUTO_RELEASE_ENABLED=1`, and a Scroll already held stays held until the next pass.
 */
export function approveTopicCommand(
  options: { readonly topic?: string; readonly decidedBy: string },
  print: Print,
  logEvent: LogEvent,
) {
  const topicId = options.topic;
  if (topicId === undefined || !TOPIC_ID.test(topicId)) {
    print({ result: 'usage', usage: USAGE.approve });
    return Promise.resolve(2);
  }
  return withReleasePolicy('policy_approve_failed', logEvent, async (policy) => {
    const result = await policy.approveTopic({ topicId, approvedBy: options.decidedBy });
    const { kind, ...rest } = result;
    recordChange(logEvent, {
      topicId,
      outcome: kind,
      ...('reason' in result ? { reason: result.reason } : {}),
    });
    print({ command: 'content policy approve-topic', result: kind, ...rest });
    return kind === 'refused' ? 2 : 0;
  });
}

/**
 * `content policy revoke-topic --topic <id>`: takes a topic's approval back. No later Scroll of the topic is released by the policy. A Scroll
 * already released stays served: `content policy withdraw` takes one down. Records who and when. Idempotent.
 */
export function revokeTopicCommand(
  options: { readonly topic?: string; readonly decidedBy: string },
  print: Print,
  logEvent: LogEvent,
) {
  const topicId = options.topic;
  if (topicId === undefined || !TOPIC_ID.test(topicId)) {
    print({ result: 'usage', usage: USAGE.revoke });
    return Promise.resolve(2);
  }
  return withReleasePolicy('policy_revoke_failed', logEvent, async (policy) => {
    const result = await policy.revokeTopic({ topicId, revokedBy: options.decidedBy });
    const { kind, ...rest } = result;
    recordChange(logEvent, { topicId, outcome: kind, ...('reason' in result ? { reason: result.reason } : {}) });
    print({ command: 'content policy revoke-topic', result: kind, ...rest });
    return kind === 'refused' ? 2 : 0;
  });
}

/**
 * `content policy withdraw --asset <id> --revision <n>`: withdraws a Scroll the policy released and, in the same transaction, revokes its topic's
 * approval, so nothing more of the topic is released unread (D-418). The withdrawal is the existing one: the asset stops being served everywhere.
 * It refuses a Scroll an operator released (that is a person's decision to take back) and one the asset no longer serves. Idempotent.
 */
export function withdrawCommand(
  options: { readonly asset?: string; readonly revision?: string; readonly decidedBy: string },
  print: Print,
  logEvent: LogEvent,
) {
  const revision = parseRevision(options.revision);
  if (options.asset === undefined || !ASSET_ID.test(options.asset) || revision === undefined) {
    print({ result: 'usage', usage: USAGE.withdraw });
    return Promise.resolve(2);
  }
  const assetId = options.asset.toLowerCase();
  return withReleasePolicy('policy_withdraw_failed', logEvent, async (policy) => {
    const result = await policy.withdraw({ assetId, revision, withdrawnBy: options.decidedBy });
    const { kind, ...rest } = result;
    recordChange(logEvent, {
      topicId: 'topicId' in result ? result.topicId : null,
      outcome: kind,
      ...('reason' in result ? { reason: result.reason } : {}),
      revision,
    });
    print({ command: 'content policy withdraw', result: kind, ...rest });
    return kind === 'refused' ? 2 : 0;
  });
}

/**
 * `content policy status`: counts only. The switch and the cap as this shell's environment says them (a worker started from the same
 * environment file does the same), the approved and revoked topics, the Scrolls the policy released (today and in all) and how many were
 * withdrawn, and, for the Scrolls waiting for a decision, how many the policy would release now and how many each code holds. No asset, topic or
 * text is printed, so the line may be pasted into an issue.
 */
export function statusCommand(print: Print, logEvent: LogEvent) {
  return withReleasePolicy('policy_status_failed', logEvent, async (policy) => {
    const status = await policy.status(readContentAutoReleaseSettings(process.env));
    print({ command: 'content policy status', ...status });
    return 0;
  });
}
