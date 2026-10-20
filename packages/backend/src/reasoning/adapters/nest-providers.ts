import type { Kysely } from 'kysely';
import type { ReasoningSettings } from '../../infrastructure/config/index.js';
import { uuidv7 } from '../../infrastructure/ids/index.js';
import type { LogEvent } from '../../infrastructure/observability/index.js';
import { makeAuthorityHolds, type Database } from '../../infrastructure/postgres/index.js';
import type { WithPersonalScope } from '../../modules/identity/public.js';
import { makeReasoningOperator } from '../application/operator.js';
import type { HarnessPorts, HarnessSettings, ModelPort } from '../application/ports.js';
import { makeReasoningHarness } from '../application/propose.js';
import { PURGE_EXPIRED_REQUESTS, REASONING_HARNESS, type PurgeExpiredRequests } from '../public.js';
import { guardedModelPort } from './guarded-model.js';
import { makeMiniMaxModelPort } from './minimax/minimax-model.js';
import { makeAttemptLedger } from './postgres-ledger.js';
import { redactRecorded, sha256Hex } from './recording.js';

/**
 * Reusable outer wiring of the reasoning engine (blueprint §22), for composition roots and
 * integration tests only: the PostgreSQL attempt ledger, the transaction guard every transport is
 * wrapped in, the MiniMax and fixture transports, and the harness and operator factories.
 */
export {
  fixtureModelPort,
  type FixtureCall,
  type FixtureModelPort,
  type FixtureScenario,
} from './fixture/fixture-model.js';
export { guardedModelPort } from './guarded-model.js';
export { makeMiniMaxModelPort, type MiniMaxSettings } from './minimax/minimax-model.js';
export { makeAttemptLedger } from './postgres-ledger.js';

/** Fifteen minutes between opportunistic purges of expired protected requests. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/** Harness settings from the worker's reasoning configuration. */
export function harnessSettings(settings: ReasoningSettings, dispatchedBy: string): HarnessSettings {
  return {
    caps: settings.caps,
    maxRequestBytes: settings.maxRequestBytes,
    requestRetentionSeconds: settings.requestRetentionSeconds,
    purgeIntervalMs: PURGE_INTERVAL_MS,
    dispatchedBy,
  };
}

/**
 * The configured provider transport, or `undefined` for `provider: none`. `postgresHarnessPorts`
 * wraps it with the transaction guard.
 */
export function configuredModelPort(settings: ReasoningSettings): ModelPort | undefined {
  if (settings.provider === 'none' || settings.minimax === undefined) return undefined;
  return makeMiniMaxModelPort({
    apiKey: settings.minimax.apiKey,
    model: settings.minimax.model,
    requestTimeoutMs: settings.minimax.requestTimeoutMs,
    quotaTimeoutMs: 10_000,
    quotaFloorPercent: settings.minimax.quotaFloorPercent,
    maxReplyBytes: 524_288,
    maxRequestBytes: settings.maxRequestBytes,
  });
}

/**
 * The harness's ports over one database, with the real ledger, authority check, hashing,
 * redaction, UUIDv7 IDs and the wall clock. `overrides` replaces any port (tests inject a
 * crashing ledger or a flaky authority check this way).
 */
export function postgresHarnessPorts(options: {
  readonly db: Kysely<Database>;
  readonly withPersonalScope: WithPersonalScope;
  readonly model: ModelPort | undefined;
  readonly logEvent: LogEvent;
  readonly settings: HarnessSettings;
  readonly overrides?: Partial<HarnessPorts>;
}): HarnessPorts {
  return {
    withPersonalScope: options.withPersonalScope,
    authorityHolds: makeAuthorityHolds(options.db),
    model: options.model === undefined ? undefined : guardedModelPort(options.model),
    ledger: makeAttemptLedger(options.db),
    hashBytes: sha256Hex,
    redactRecorded,
    newId: () => uuidv7(),
    now: () => Date.now(),
    logEvent: options.logEvent,
    settings: options.settings,
    ...options.overrides,
  };
}

/** The operator actions (write-off, unknown list, purge) over one database. */
export function reasoningOperatorFor(db: Kysely<Database>, logEvent: LogEvent) {
  return makeReasoningOperator({ ledger: makeAttemptLedger(db), logEvent });
}

/**
 * Nest wiring of the scheduled protected-request purge (`reasoning.purge-expired-requests`, every
 * 15 minutes) for the worker composition root.
 */
export function reasoningPurgeProviders(tokens: { readonly database: symbol; readonly logEvent: symbol }) {
  return [
    {
      provide: PURGE_EXPIRED_REQUESTS,
      inject: [tokens.database, tokens.logEvent],
      useFactory: (db: Kysely<Database>, logEvent: LogEvent): PurgeExpiredRequests => {
        const operator = reasoningOperatorFor(db, logEvent);
        return () => operator.purgeExpired();
      },
    },
  ];
}

/**
 * Nest providers for the worker composition root: binds `REASONING_HARNESS` to a harness over the
 * worker's database, personal scope and diagnostics, with the configured provider (none, or the
 * MiniMax token plan). Roles inject `REASONING_HARNESS` from their module's wiring.
 */
export function reasoningProviders(
  tokens: { readonly database: symbol; readonly withPersonalScope: symbol; readonly logEvent: symbol },
  settings: ReasoningSettings,
) {
  return [
    {
      provide: REASONING_HARNESS,
      inject: [tokens.database, tokens.withPersonalScope, tokens.logEvent],
      useFactory: (db: Kysely<Database>, withPersonalScope: WithPersonalScope, logEvent: LogEvent) => {
        const model = configuredModelPort(settings);
        logEvent('reasoning.provider_configured', {
          provider: model?.provider ?? 'none',
          ...(model === undefined ? {} : { model: model.model }),
        });
        return makeReasoningHarness(
          postgresHarnessPorts({
            db,
            withPersonalScope,
            model,
            logEvent,
            settings: harnessSettings(settings, `worker:${process.pid}`),
          }),
        );
      },
    },
  ];
}
