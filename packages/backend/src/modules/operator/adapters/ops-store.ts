import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/index.js';
import { JOIN_KEYS, type JoinKey, type JourneyEvent, type RelatedKeys } from '../domain/journey.js';
import type {
  CartographerSummary,
  ErrorRow,
  OutcomeCount,
  Piece,
  PrivacySummary,
  ProductionRunRow,
  QueueRow,
  RefusedAnswerRow,
  ReelOrderRow,
  ReportRow,
  ReportsSummary,
  UsageSummary,
} from '../domain/panels.js';
import type { JourneyStore, PanelStore } from '../application/ports.js';

/** Column of `ops.journey_events` for each join key. */
const KEY_COLUMNS = {
  workId: 'work_id',
  productionRunId: 'production_run_id',
  reasoningRunId: 'reasoning_run_id',
  attemptId: 'attempt_id',
  exposureId: 'exposure_id',
  offerId: 'offer_id',
  decisionId: 'decision_id',
  assetId: 'asset_id',
  reelOrderId: 'reel_order_id',
  commandId: 'command_id',
} as const satisfies Record<JoinKey, string>;

const JOURNEY_COLUMNS = [
  'stage',
  'started_at',
  'ended_at',
  'state',
  'code',
  'label',
  'count',
  'universe_id',
  'request_id',
  'work_id',
  'recipe_key',
  'production_run_id',
  'reasoning_run_id',
  'attempt_id',
  'exposure_id',
  'offer_id',
  'decision_id',
  'asset_id',
  'reel_order_id',
  'command_id',
  'subject_id',
] as const;

type JourneyRow = {
  readonly [column in (typeof JOURNEY_COLUMNS)[number]]: unknown;
};

function journeyEventOf(row: JourneyRow): JourneyEvent {
  return {
    stage: String(row.stage),
    startedAt: row.started_at as Date,
    endedAt: row.ended_at as Date | null,
    state: row.state as string | null,
    code: row.code as string | null,
    label: row.label as string | null,
    count: row.count === null ? null : Number(row.count),
    universeId: row.universe_id as string | null,
    requestId: row.request_id as string | null,
    workId: row.work_id as string | null,
    recipeKey: row.recipe_key as string | null,
    productionRunId: row.production_run_id as string | null,
    reasoningRunId: row.reasoning_run_id as string | null,
    attemptId: row.attempt_id as string | null,
    exposureId: row.exposure_id as string | null,
    offerId: row.offer_id as string | null,
    decisionId: row.decision_id as string | null,
    assetId: row.asset_id as string | null,
    reelOrderId: row.reel_order_id as string | null,
    commandId: row.command_id as string | null,
    subjectId: row.subject_id as string | null,
  };
}

/** `ops.journey_events` through the application role. Read-only. */
export function makeJourneyStore(db: Kysely<Database>): JourneyStore {
  return {
    async findById(id, limit, includeUniverse) {
      const rows = await db
        .selectFrom('ops.journey_events')
        .select(JOURNEY_COLUMNS)
        .where((eb) =>
          eb.or([
            eb('request_id', '=', id),
            eb('production_run_id', '=', id),
            eb('exposure_id', '=', id),
            eb('reel_order_id', '=', id),
            eb('attempt_id', '=', id),
            eb('reasoning_run_id', '=', id),
            ...(includeUniverse ? [eb('universe_id', '=', id)] : []),
            // An asset is shared by many people: only its shared steps answer its ID.
            eb.and([eb('asset_id', '=', id), eb('universe_id', 'is', null)]),
          ]),
        )
        .orderBy('started_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(journeyEventOf);
    },
    async findRelated(keys: RelatedKeys, universeIds, limit) {
      const rows = await db
        .selectFrom('ops.journey_events')
        .select(JOURNEY_COLUMNS)
        .where((eb) => {
          const matches = [
            ...JOIN_KEYS.filter((key) => keys[key].length > 0).map((key) => eb(KEY_COLUMNS[key], 'in', keys[key])),
            ...(keys.recipeKeys.length === 0
              ? []
              : [eb.and([eb('stage', '=', 'content.production_run'), eb('recipe_key', 'in', keys.recipeKeys)])]),
          ];
          const ownScope =
            universeIds.length === 0
              ? eb('universe_id', 'is', null)
              : eb.or([eb('universe_id', 'is', null), eb('universe_id', 'in', universeIds)]);
          return eb.and([eb.or(matches), ownScope]);
        })
        .orderBy('started_at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(journeyEventOf);
    },
  };
}

const PG_UNDEFINED_TABLE = '42P01';

/** Runs one panel read; a view that is missing or fails makes that piece unavailable, not the screen. */
async function pieceOf<T>(read: () => Promise<T>): Promise<Piece<T>> {
  try {
    return { status: 'available', data: await read() };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return { status: 'unavailable', reason: code === PG_UNDEFINED_TABLE ? 'view_missing' : 'read_failed' };
  }
}

const count = (value: unknown): number => Number(value ?? 0);
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;
const text = (value: string | null | undefined): string => value ?? '';

/** The other `ops` views through the application role. Read-only. */
export function makePanelStore(db: Kysely<Database>): PanelStore {
  return {
    queues: () =>
      pieceOf(async (): Promise<readonly QueueRow[]> => {
        const rows = await db.selectFrom('ops.queue_backlog').selectAll().orderBy('queue').limit(60).execute();
        return rows.map((row) => ({
          queue: text(row.queue),
          ready: count(row.ready),
          scheduled: count(row.scheduled),
          retrying: count(row.retrying),
          active: count(row.active),
          failed: count(row.failed),
          oldestWaitingSeconds: row.oldest_waiting_seconds === null ? null : Number(row.oldest_waiting_seconds),
          lastCompletedAt: orNull(row.last_completed_at),
        }));
      }),

    providerOutcomes: (windowHours) =>
      pieceOf(async (): Promise<readonly OutcomeCount[]> => {
        const rows = await db
          .selectFrom('ops.model_attempts')
          .select(['state', (eb) => eb.fn.countAll().as('total')])
          .where('reserved_at', '>', sql<Date>`now() - make_interval(hours => ${windowHours})`)
          .groupBy('state')
          .orderBy('state')
          .execute();
        return rows.map((row) => ({ state: text(row.state), count: count(row.total) }));
      }),

    usage: (windowHours) =>
      pieceOf(async (): Promise<UsageSummary> => {
        const row = await db
          .selectFrom('ops.model_attempts')
          .select([
            (eb) => eb.fn.countAll().as('attempts'),
            sql<string>`coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)`.as('tokens'),
            sql<string>`count(*) filter (where dispatched_at is not null and input_tokens is null and output_tokens is null)`.as(
              'unreported',
            ),
          ])
          .where('reserved_at', '>', sql<Date>`now() - make_interval(hours => ${windowHours})`)
          .executeTakeFirstOrThrow();
        return {
          windowHours,
          attempts: count(row.attempts),
          tokensReported: count(row.tokens),
          attemptsWithoutReportedUsage: count(row.unreported),
        };
      }),

    recentErrors: (limit) =>
      pieceOf(async (): Promise<readonly ErrorRow[]> => {
        const rows = await db
          .selectFrom('ops.recent_errors')
          .selectAll()
          .orderBy('occurred_at', 'desc')
          .limit(limit)
          .execute();
        return rows.map((row) => ({
          occurredAt: row.occurred_at as Date,
          source: text(row.source),
          refId: text(row.ref_id),
          state: row.state,
          code: row.code,
          label: row.label,
        }));
      }),

    productionRuns: (limit) =>
      pieceOf(async (): Promise<readonly ProductionRunRow[]> => {
        const rows = await db
          .selectFrom('ops.production_runs')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(limit)
          .execute();
        return rows.map((row) => ({
          productionRunId: text(row.production_run_id),
          recipeKey: text(row.recipe_key),
          take: row.take ?? 1,
          state: text(row.state),
          writerRunState: row.writer_run_state,
          modelAttempts: count(row.model_attempts),
          refusedAnswers: count(row.refused_answers),
          assetId: row.asset_id,
          createdAt: row.created_at as Date,
          completedAt: orNull(row.completed_at),
        }));
      }),

    refusedAnswers: (limit) =>
      pieceOf(async (): Promise<readonly RefusedAnswerRow[]> => {
        const rows = await db
          .selectFrom('ops.rejected_answers')
          .selectAll()
          .orderBy('recorded_at', 'desc')
          .limit(limit)
          .execute();
        return rows.map((row) => ({
          attemptId: text(row.attempt_id),
          step: row.step,
          model: row.model,
          reason: row.reason,
          issueCount: row.issue_count ?? 0,
          issueCodes: row.issue_codes ?? [],
          answerChars: row.answer_chars ?? 0,
          truncated: row.truncated ?? false,
          recordedAt: row.recorded_at as Date,
        }));
      }),

    reelOrders: (limit) =>
      pieceOf(async (): Promise<readonly ReelOrderRow[]> => {
        const rows = await db
          .selectFrom('ops.reel_orders')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(limit)
          .execute();
        return rows.map((row) => ({
          reelOrderId: text(row.reel_order_id),
          scriptName: text(row.script_name),
          until: text(row.until),
          attempts: count(row.attempts),
          settledCents: count(row.settled_cents),
          claimedOpenCents: count(row.claimed_open_cents),
          latestAttemptState: row.latest_attempt_state,
          createdAt: row.created_at as Date,
          publishedAt: orNull(row.published_at),
        }));
      }),

    cartographer: (limit) =>
      pieceOf(async (): Promise<CartographerSummary> => {
        const since = sql<Date>`now() - interval '7 days'`;
        const counts = await db
          .selectFrom('ops.geography_runs')
          .select(['status', (eb) => eb.fn.countAll().as('total')])
          .where('created_at', '>', since)
          .groupBy('status')
          .orderBy('status')
          .execute();
        const recent = await db
          .selectFrom('ops.geography_runs')
          .selectAll()
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .execute();
        return {
          counts: counts.map((row) => ({ state: text(row.status), count: count(row.total) })),
          recent: recent.map((row) => ({
            runId: text(row.run_id),
            status: text(row.status),
            outcome: row.outcome,
            desiredRevision: row.desired_revision ?? 0,
            updatedAt: row.updated_at as Date,
          })),
        };
      }),

    reports: (limit) =>
      pieceOf(async (): Promise<ReportsSummary> => {
        const recent = await db
          .selectFrom('ops.feedback_reports')
          .selectAll()
          .orderBy('created_at', 'desc')
          .orderBy('report_id')
          .limit(limit)
          .execute();
        const day = await db
          .selectFrom('ops.feedback_reports')
          .select((eb) => eb.fn.countAll().as('total'))
          .where('created_at', '>', sql<Date>`now() - interval '24 hours'`)
          .executeTakeFirstOrThrow();
        return {
          last24Hours: count(day.total),
          recent: recent.map((row) => ({
            reportId: text(row.report_id),
            // The table's checks allow only these values.
            kind: text(row.kind) as ReportRow['kind'],
            category: text(row.category),
            targetKind: text(row.target_kind) as ReportRow['targetKind'],
            assetId: row.asset_id,
            messageId: row.message_id,
            roomId: row.room_id,
            hasNote: row.has_note ?? false,
            createdAt: row.created_at as Date,
          })),
        };
      }),

    privacy: (limit) =>
      pieceOf(async (): Promise<PrivacySummary> => {
        const groups = await db
          .selectFrom('ops.privacy_operations')
          .select([
            'kind',
            'state',
            (eb) => eb.fn.countAll().as('total'),
            (eb) => eb.fn.min('requested_at').as('oldest'),
          ])
          .where('requested_at', '>', sql<Date>`now() - interval '30 days'`)
          .groupBy(['kind', 'state'])
          .orderBy('kind')
          .orderBy('state')
          .execute();
        const failed = await db
          .selectFrom('ops.privacy_operations')
          .select(['operation_id', 'kind', 'failure_code', 'requested_at'])
          .where('failure_code', 'is not', null)
          .orderBy('requested_at', 'desc')
          .limit(limit)
          .execute();
        return {
          groups: groups.map((row) => ({
            kind: text(row.kind),
            state: text(row.state),
            count: count(row.total),
            oldestRequestedAt: row.oldest as Date,
          })),
          failed: failed.map((row) => ({
            operationId: text(row.operation_id),
            kind: text(row.kind),
            failureCode: text(row.failure_code),
            requestedAt: row.requested_at as Date,
          })),
        };
      }),
  };
}
