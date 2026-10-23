import { createHash } from 'node:crypto';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { makeWithCutroomScope } from '../../infrastructure/postgres/cutroom-scope.js';
import { makeEnqueueCutroom } from '../../infrastructure/jobs/enqueue-cutroom.js';
import { makeCutroomB } from '../application/cutroom.js';
import { postgresCutroomLedger } from './postgres-cutroom-ledger.js';
import { makeCutroomPool } from './cutroom-pool.js';
import type { CutroomB, CutroomOwnerApproval, CutroomBusinessLock, WithCutroomScope } from '../public.js';
import type { Kysely } from 'kysely';
import type { ReasoningSettings } from '../../infrastructure/config/index.js';
import { uuidv7 } from '../../infrastructure/ids/index.js';
import type { LogEvent } from '../../infrastructure/observability/index.js';
import {
  makeAuthorityHolds,
  fencePersonalRecording,
  makeWithProductionScope,
  makeProductionAuthorityHolds,
  type Database,
} from '../../infrastructure/postgres/index.js';
import { FENCE_OWN_ACCOUNT, type FenceOwnAccount, type WithPersonalScope } from '../../modules/identity/public.js';
import { makePersonalReasoningAccess } from './personal-recording.js';
import {
  makePersonalRecordingReasoningHarness,
  recordingOwnerDispatcher,
  type PersonalRecordingHarnessPorts,
} from '../application/personal-recording.js';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeReasoningOperator } from '../application/operator.js';
import type { HarnessPorts, HarnessSettings, ModelPort, ExecutionPorts } from '../application/ports.js';
import { makeReasoningHarness, makeScopedReasoningHarness } from '../application/propose.js';
import {
  PURGE_EXPIRED_REQUESTS,
  RECORDING_REASONING_HARNESS,
  CHECK_PLANNER_RECORDING_RUN,
  CHECK_GEOGRAPHY_RECORDING_RUN,
  PRODUCTION_REASONING_HARNESS,
  WITH_PRODUCTION_SCOPE,
  REASONING_HARNESS,
  SWEEP_DISPATCHED_ATTEMPTS,
  type PurgeExpiredRequests,
  type SweepDispatchedAttempts,
} from '../public.js';
import { guardedModelPort } from './guarded-model.js';
import { makeMiniMaxModelPort } from './minimax/minimax-model.js';
import { makeAttemptLedger } from './postgres-ledger.js';
import { makeProductionAttemptLedger } from './postgres-production-ledger.js';
import { readProductionRunAccounting } from './production-accounting.js';
import type {
  ReadProductionRunAccounting,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProductionScopeTx,
  WithProductionScope,
} from '../application/production.js';
import { redactRecorded, sha256Hex } from './recording.js';

/**
 * Reusable outer wiring of the reasoning engine (blueprint §22), for composition roots and
 * integration tests only (a module cannot import this file: the dependency rules allow it from the
 * apps' composition roots and tests): the PostgreSQL attempt ledger, the transaction guard every
 * transport is wrapped in, the MiniMax transport, and the harness and operator factories with the
 * types they need. The CI fixture model is test support (`tests/integration/support`), not here.
 */
export { makeReasoningHarness } from '../application/propose.js';
export { makeReasoningOperator, type ReasoningOperator } from '../application/operator.js';
export {
  MAX_STORED_OUTPUT_BYTES,
  ModelNotSentError,
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type AttemptLedger,
  type GuardedModelPort,
  type HarnessPorts,
  type HarnessSettings,
  type ModelPort,
  type ModelReply,
  type ModelRequest,
  type QuotaObservation,
  type StopReason,
} from '../application/ports.js';
export { guardedModelPort } from './guarded-model.js';
export { makeMiniMaxModelPort, type MiniMaxSettings } from './minimax/minimax-model.js';
export { makeAttemptLedger } from './postgres-ledger.js';
export { makeProductionAttemptLedger } from './postgres-production-ledger.js';

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
 * How long an attempt may stay `dispatched` before the sweep treats it as orphaned: the provider
 * request deadline plus two minutes for settlement (for `provider: none`, nothing is ever
 * dispatched; the largest allowed deadline is assumed).
 */
export function dispatchStaleAfterSeconds(settings: ReasoningSettings): number {
  return Math.ceil((settings.minimax?.requestTimeoutMs ?? 300_000) / 1000) + 120;
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
  readonly fenceOwn: FenceOwnAccount;
}): HarnessPorts {
  const ledger = options.overrides?.ledger ?? makeAttemptLedger(options.db);
  const withScope = options.overrides?.withPersonalScope ?? options.withPersonalScope;
  return {
    personalAccess: makePersonalReasoningAccess({
      withScope,
      fenceOwn: options.fenceOwn,
      fenceRecording: fencePersonalRecording,
      ledger,
    }),
    withPersonalScope: options.withPersonalScope,
    authorityHolds: makeAuthorityHolds(options.db),
    model: options.model === undefined ? undefined : guardedModelPort(options.model),
    ledger,
    hashBytes: sha256Hex,
    redactRecorded,
    newId: () => uuidv7(),
    now: () => Date.now(),
    logEvent: options.logEvent,
    settings: options.settings,
    ...options.overrides,
  };
}

/** Explicit unmounted recording boundary: both actual role owners are required. */
export function personalRecordingReasoningHarnessFor(
  options: Parameters<typeof postgresHarnessPorts>[0] &
    Pick<PersonalRecordingHarnessPorts, 'checkPlanner' | 'checkGeography'>,
) {
  const engine = postgresHarnessPorts(options);
  const checkOwner = recordingOwnerDispatcher(options);
  return makePersonalRecordingReasoningHarness({
    engine: {
      ...engine,
      personalAccess: makePersonalReasoningAccess({
        withScope: engine.withPersonalScope,
        fenceOwn: options.fenceOwn,
        fenceRecording: fencePersonalRecording,
        ledger: engine.ledger,
        checkOwner,
      }),
    },
    checkPlanner: options.checkPlanner,
    checkGeography: options.checkGeography,
    hashContext: canonicalSha256,
  });
}
export { makePersonalRecordingReasoningHarness, recordingOwnerDispatcher } from '../application/personal-recording.js';
export type { PersonalRecordingHarnessPorts } from '../application/personal-recording.js';

/** Future composition opts in explicitly; missing actual owner providers fail DI/construction. */
export function personalRecordingReasoningProviders(
  tokens: { readonly database: symbol; readonly withPersonalScope: symbol; readonly logEvent: symbol },
  settings: ReasoningSettings,
) {
  return [
    {
      provide: RECORDING_REASONING_HARNESS,
      inject: [
        tokens.database,
        tokens.withPersonalScope,
        tokens.logEvent,
        FENCE_OWN_ACCOUNT,
        CHECK_PLANNER_RECORDING_RUN,
        CHECK_GEOGRAPHY_RECORDING_RUN,
      ],
      useFactory: (
        db: Kysely<Database>,
        withPersonalScope: WithPersonalScope,
        logEvent: LogEvent,
        fenceOwn: FenceOwnAccount,
        checkPlanner: PersonalRecordingHarnessPorts['checkPlanner'],
        checkGeography: PersonalRecordingHarnessPorts['checkGeography'],
      ) =>
        personalRecordingReasoningHarnessFor({
          db,
          withPersonalScope,
          logEvent,
          fenceOwn,
          checkPlanner,
          checkGeography,
          model: configuredModelPort(settings),
          settings: harnessSettings(settings, `worker:${process.pid}`),
        }),
    },
  ];
}

/** Production execution ports plus one deliberately payload-free accounting read. */
type ProductionHarnessPorts = ExecutionPorts<ProductionAuthority, ProductionScopeTx> & {
  readonly readProductionRunAccounting: ReadProductionRunAccounting;
};

/** Concrete production wiring; no provider or storage selection is available to role modules. */
export function postgresProductionHarnessPorts(options: {
  readonly db: Kysely<Database>;
  readonly withProductionScope: WithProductionScope;
  readonly enabled: boolean;
  readonly model: ModelPort | undefined;
  readonly logEvent: LogEvent;
  readonly settings: HarnessSettings;
  readonly overrides?: Partial<ExecutionPorts<ProductionAuthority, ProductionScopeTx>>;
}): ProductionHarnessPorts {
  return {
    readProductionRunAccounting,
    withScope: options.withProductionScope,
    authorityHolds: makeProductionAuthorityHolds(options.db, options.enabled),
    scopeId: (authority) => authority.scopeId,
    generation: (authority) => authority.generation,
    model: options.model === undefined ? undefined : guardedModelPort(options.model),
    ledger: makeProductionAttemptLedger(options.db),
    hashBytes: sha256Hex,
    redactRecorded,
    newId: () => uuidv7(),
    now: () => Date.now(),
    logEvent: options.logEvent,
    settings: options.settings,
    ...options.overrides,
  };
}

export function makeProductionReasoningHarness(ports: ProductionHarnessPorts): ProductionReasoningHarness {
  const engine = makeScopedReasoningHarness(ports);
  return {
    readProductionRunAccounting: ports.readProductionRunAccounting,
    proposeProduction: (input, signal) => engine.propose(input, signal),
    closeProductionRun: (scope, run) => engine.closeRun(scope, run),
  };
}

/**
 * Nest wiring of the scheduled crash-recovery sweep (`reasoning.sweep-dispatched-attempts`, every
 * 5 minutes) for the worker composition root.
 */
export function reasoningSweepProviders(tokens: {
  readonly database: symbol;
  readonly logEvent: symbol;
  /** Injects an object with the worker's `reasoning` settings. */
  readonly workerConfig: symbol;
}) {
  return [
    {
      provide: SWEEP_DISPATCHED_ATTEMPTS,
      inject: [tokens.database, tokens.logEvent, tokens.workerConfig],
      useFactory: (
        db: Kysely<Database>,
        logEvent: LogEvent,
        config: { readonly reasoning: ReasoningSettings },
      ): SweepDispatchedAttempts => {
        const operator = reasoningOperatorFor(db, logEvent);
        const staleAfterSeconds = dispatchStaleAfterSeconds(config.reasoning);
        return () => operator.sweepStaleDispatched(staleAfterSeconds);
      },
    },
  ];
}

/** The operator actions (write-off, unknown list, sweep, purge) over one database. */
export function reasoningOperatorFor(db: Kysely<Database>, logEvent: LogEvent) {
  const personal = makeAttemptLedger(db);
  const production = makeProductionAttemptLedger(db);
  return makeReasoningOperator({
    ledger: {
      ...personal,
      async writeOff(attemptId, reason, source) {
        const result = await personal.writeOff(attemptId, reason, source);
        return result.kind === 'missing' ? production.writeOff(attemptId, reason, source) : result;
      },
      async listUnknown(limit) {
        const rows = [...(await personal.listUnknown(limit)), ...(await production.listUnknown(limit))];
        return rows
          .sort(
            (a, b) =>
              (a.dispatchedAt?.getTime() ?? 0) - (b.dispatchedAt?.getTime() ?? 0) ||
              a.attemptId.localeCompare(b.attemptId),
          )
          .slice(0, limit);
      },
      async purgeExpiredRequests(limit) {
        return (await personal.purgeExpiredRequests(limit)) + (await production.purgeExpiredRequests(limit));
      },
      async sweepStaleDispatched(seconds, limit) {
        return (
          (await personal.sweepStaleDispatched(seconds, limit)) +
          (await production.sweepStaleDispatched(seconds, limit))
        );
      },
    },
    logEvent,
  });
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
  scopeLockTimeoutMs = 5_000,
) {
  return [
    {
      provide: REASONING_HARNESS,
      inject: [tokens.database, tokens.withPersonalScope, tokens.logEvent, FENCE_OWN_ACCOUNT],
      useFactory: (
        db: Kysely<Database>,
        withPersonalScope: WithPersonalScope,
        logEvent: LogEvent,
        fenceOwn: FenceOwnAccount,
      ) => {
        const model = configuredModelPort(settings);
        logEvent('reasoning.provider_configured', {
          provider: model?.provider ?? 'none',
          ...(model === undefined ? {} : { model: model.model }),
        });
        return makeReasoningHarness(
          postgresHarnessPorts({
            db,
            withPersonalScope,
            fenceOwn,
            model,
            logEvent,
            settings: harnessSettings(settings, `worker:${process.pid}`),
          }),
        );
      },
    },
    {
      provide: WITH_PRODUCTION_SCOPE,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): WithProductionScope =>
        makeWithProductionScope(db, {
          enabled: settings.productionEnabled,
          lockTimeoutMs: scopeLockTimeoutMs,
        }),
    },
    {
      provide: PRODUCTION_REASONING_HARNESS,
      inject: [tokens.database, WITH_PRODUCTION_SCOPE, tokens.logEvent],
      useFactory: (db: Kysely<Database>, withProductionScope: WithProductionScope, logEvent: LogEvent) =>
        makeProductionReasoningHarness(
          postgresProductionHarnessPorts({
            db,
            withProductionScope,
            enabled: settings.productionEnabled,
            model: configuredModelPort(settings),
            logEvent,
            settings: harnessSettings(settings, `worker:${process.pid}`),
          }),
        ),
    },
  ];
}

/** B prerequisite ONLY; no normal process binding/root seed/approval/principal/transport.
 * connectPool must acquire a separate bounded dedicated session; never a world transaction.
 */
export function cutroomBFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly enabled?: boolean;
    readonly approvals?: readonly CutroomOwnerApproval[];
    readonly lockBusiness?: CutroomBusinessLock;
    readonly connectPool?: () => Promise<pg.PoolClient>;
    readonly now?: () => Date;
    readonly withScope?: WithCutroomScope;
  } = {},
): CutroomB {
  const enabled = options.enabled ?? false;
  const pool = options.connectPool
    ? makeCutroomPool(options.connectPool)
    : {
        claim: () => Promise.resolve({ kind: 'held', reason: 'needs_operator' } as const),
        read: () => Promise.resolve({ kind: 'held', reason: 'needs_operator' } as const),
        release: () => Promise.resolve({ kind: 'held', reason: 'needs_operator' } as const),
      };
  return makeCutroomB({
    withScope: options.withScope ?? makeWithCutroomScope(db, { enabled, lockTimeoutMs: 5000 }),
    ledger: postgresCutroomLedger(makeEnqueueCutroom(boss), options.now),
    pool,
    lockBusiness: options.lockBusiness ?? (() => Promise.resolve(false)),
    approvals: options.approvals ?? [],
    enabled,
    now: options.now ?? (() => new Date()),
    sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
    byteLength: (text) => Buffer.byteLength(text, 'utf8'),
  });
}
export { makeWithCutroomScope, makeEnqueueCutroom, postgresCutroomLedger, makeCutroomPool, makeCutroomB };
export type {
  CutroomBPorts,
  CutroomLedger,
  CutroomPool,
  CutroomNotSent,
  CutroomPoolOperation,
} from '../application/cutroom-ports.js';

import { makeWithCutroomAccountingScope } from '../../infrastructure/postgres/cutroom-scope.js';
import { makeEnqueueCutroomAccounting } from '../../infrastructure/jobs/enqueue-cutroom.js';
import { makeCutroomExecutionFoundation, consumeCutroomDispatchPermit } from '../application/cutroom-execution.js';
import { postgresCutroomExecution } from './postgres-cutroom-execution.js';
import { cutroomAccountingQueue } from '../events.js';
import type { CutroomDispatchPreflight, CutroomReviewRecheck } from '../application/cutroom-execution-ports.js';
/** C1 unmounted composition seam. No provider/HTTP/fal/pool action, approval mint, root seed or dispatcher. */
export function cutroomExecutionFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly enabled?: boolean;
    readonly recheckReview?: CutroomReviewRecheck;
    readonly preflights?: readonly CutroomDispatchPreflight[];
    readonly now?: () => Date;
  } = {},
) {
  const enabled = options.enabled ?? false;
  return makeCutroomExecutionFoundation({
    enabled,
    withScope: makeWithCutroomScope(db, { enabled, lockTimeoutMs: 5000 }),
    withAccountingScope: makeWithCutroomAccountingScope(db, { enabled, lockTimeoutMs: 5000 }),
    store: postgresCutroomExecution(
      makeEnqueueCutroom(boss),
      makeEnqueueCutroomAccounting(boss, cutroomAccountingQueue),
      options.now,
    ),
    recheckReview: options.recheckReview ?? (() => Promise.resolve(undefined)),
    preflights: options.preflights ?? [],
    now: options.now ?? (() => new Date()),
  });
}
export {
  makeWithCutroomAccountingScope,
  makeEnqueueCutroomAccounting,
  makeCutroomExecutionFoundation,
  consumeCutroomDispatchPermit,
  postgresCutroomExecution,
};

/** Unmounted/default-disabled metadata preparation; separate from B/accounting factories. */
export { makeWithCutroomPreparationScope } from '../../infrastructure/postgres/cutroom-scope.js';

export { clearReasoning } from './erasure.js';

/** Connected Cutroom source composition only; actual approvals/profile/funds/function ACL are external. */
export { makeCutroomSettlement } from '../application/cutroom-settlement.js';
export {
  postgresCutroomSettlement,
  cutroomMaintenanceFor,
  cutroomPoolWorkReader,
} from './postgres-cutroom-settlement.js';
export { makeCutroomSettlementPool } from './cutroom-pool.js';
export { makeEnqueueCutroomMaintenance } from '../../infrastructure/jobs/enqueue-cutroom.js';

/** Dedicated pool sessions only; never pass a world transaction as this connection. */
export function cutroomPoolConnections(settings: {
  readonly url: string;
  readonly applicationName: string;
  readonly statementTimeoutMs: number;
}) {
  const pool = new pg.Pool({
    connectionString: settings.url,
    application_name: settings.applicationName,
    max: 1,
    statement_timeout: settings.statementTimeoutMs,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  pool.on('error', () => undefined);
  return { connect: () => pool.connect(), close: () => pool.end() };
}
export { reasoningCutroomStores, reasoningCutroomNonRowStores } from './cutroom-store-inventory.js';
