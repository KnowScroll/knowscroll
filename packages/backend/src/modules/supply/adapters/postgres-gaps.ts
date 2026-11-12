import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { withSessionLock } from '../../../infrastructure/postgres/session-lock.js';
import {
  MAX_GAP_ATTEMPTS,
  blockedVerdict,
  gapIdentity,
  type BlockedVerdict,
  type GapKind,
  type GapStatus,
  type GapTarget,
  type GapTransition,
} from '../domain/gaps.js';
import type {
  GapBriefLock,
  GapBriefStore,
  GapMarkStore,
  GapRow,
  GapScanStore,
  GapScanTx,
  SignalDay,
} from '../application/gap-ports.js';

/** The key of a gap: the SHA-256 of its identity (kind, planet and facet), so one hole has one key however often it is found. */
export const gapKeyOf = (kind: GapKind, target: GapTarget): string =>
  createHash('sha256').update(gapIdentity(kind, target)).digest('hex');

type Queryable = Kysely<Database> | Transaction<Database>;

/** How long ended gaps, counted signals and marks are kept (see migration 0112). */
const GAP_RETENTION_DAYS = 90;
const SIGNAL_RETENTION_DAYS = 30;
const MARK_RETENTION_DAYS = 3;
/** The most rows one scan deletes of each kind and counts in one statement: a backlog finishes on the next scan. */
const BATCH = 2000;
const DAY_MS = 86_400_000;

const dayOf = (when: Date, minusDays = 0): string =>
  new Date(when.getTime() - minusDays * DAY_MS).toISOString().slice(0, 10);

/**
 * The person's own marks (`supply.gap_signal_marks`), one for each planet, facet and UTC day, written inside the transaction that
 * knows the signal. Own rows only: no shared row is locked, so no reader waits on another. A mark that exists is not written
 * again (`on conflict do nothing`), which is what makes a reader count once a day.
 */
export const gapMarkStore: GapMarkStore = {
  async mark(scope, day, signals) {
    const trx = transactionOf(scope);
    for (const signal of signals) {
      const key = gapKeyOf('demand', signal);
      // Look before writing: a mark that exists is read as it was committed, however the scan is updating it, so the person never waits on a
      // row the scan holds. Another transaction of the same person cannot be writing it: they are serialised by the personal root.
      const seen = await sql`select 1 from supply.gap_signal_marks
        where universe_id = ${scope.authority.universeId}::uuid and privacy_epoch = ${scope.authority.privacyEpoch}
          and day = ${day}::date and key = ${key}`.execute(trx);
      if (seen.rows.length > 0) continue;
      await sql`insert into supply.gap_signal_marks (universe_id, privacy_epoch, day, key, source, planet, facet)
        values (${scope.authority.universeId}::uuid, ${scope.authority.privacyEpoch}, ${day}::date,
          ${key}, ${signal.source}, ${signal.planet}, ${signal.facet ?? null})
        on conflict do nothing`.execute(trx);
    }
  },
};

interface GapDbRow {
  readonly id: string;
  readonly kind: string;
  readonly planet: string;
  readonly facet: string | null;
  readonly status: string;
  readonly priority: number;
  readonly readers: number;
  readonly attempts: number;
  readonly rounds: number;
  readonly attempt_day: string | null;
  readonly recipes: string[];
  readonly first_seen_at: Date;
}

const GAP_COLUMNS = sql.raw(
  `id, kind, planet, facet, status, priority, readers, attempts, rounds, to_char(attempt_day, 'YYYY-MM-DD') as attempt_day, recipes, first_seen_at`,
);

const gapOf = (row: GapDbRow): GapRow => ({
  id: row.id,
  kind: row.kind as GapKind,
  planet: row.planet,
  ...(row.facet === null ? {} : { facet: row.facet }),
  status: row.status as GapStatus,
  priority: row.priority,
  readers: row.readers,
  attempts: row.attempts,
  rounds: row.rounds,
  ...(row.attempt_day === null ? {} : { attemptDay: row.attempt_day }),
  recipes: row.recipes,
  firstSeenAt: row.first_seen_at,
});

/** The lock that lets one scan run at a time. */
const SCAN_LOCK = sql`hashtextextended('supply.scan-gaps', 0)`;

function scanTx(trx: Transaction<Database>): GapScanTx {
  return {
    async rollUpMarks() {
      const { rows } = await sql<{ counted: number }>`
        with fresh as (
          update supply.gap_signal_marks set counted = true
          where (universe_id, privacy_epoch, day, key) in (
            select universe_id, privacy_epoch, day, key from supply.gap_signal_marks
            where not counted order by day, universe_id limit ${BATCH * 5} for update skip locked)
          returning key, day, planet, facet),
        grouped as (select key, day, planet, facet, count(*)::int as readers from fresh group by key, day, planet, facet),
        counted as (
          insert into supply.gap_signals (key, day, planet, facet, readers)
          select key, day, planet, facet, readers from grouped
          on conflict (key, day) do update set readers = supply.gap_signals.readers + excluded.readers
          returning 1)
        select coalesce((select sum(readers) from grouped), 0)::int as counted`.execute(trx);
      return rows[0]?.counted ?? 0;
    },
    async purge(now) {
      const marks = await sql`delete from supply.gap_signal_marks where (universe_id, privacy_epoch, day, key) in (
          select universe_id, privacy_epoch, day, key from supply.gap_signal_marks
          where day < ${dayOf(now, MARK_RETENTION_DAYS)}::date order by day limit ${BATCH} for update skip locked)`.execute(
        trx,
      );
      const signals = await sql`delete from supply.gap_signals where (key, day) in (
          select key, day from supply.gap_signals where day < ${dayOf(now, SIGNAL_RETENTION_DAYS)}::date order by day limit ${BATCH})`.execute(
        trx,
      );
      const gaps = await sql`delete from supply.gaps where id in (
          select id from supply.gaps where status in ('closed', 'rejected')
            and closed_at < ${new Date(now.getTime() - GAP_RETENTION_DAYS * DAY_MS)} order by closed_at limit ${BATCH})`.execute(
        trx,
      );
      return {
        marks: Number(marks.numAffectedRows ?? 0),
        signals: Number(signals.numAffectedRows ?? 0),
        gaps: Number(gaps.numAffectedRows ?? 0),
      };
    },
    async readSignals(sinceDay) {
      const { rows } = await sql<{ planet: string; facet: string | null; day: string; readers: number }>`
        select planet, facet, to_char(day, 'YYYY-MM-DD') as day, sum(readers)::int as readers
        from supply.gap_signals where day >= ${sinceDay}::date group by planet, facet, day order by day, planet, facet`.execute(
        trx,
      );
      return rows.map((row): SignalDay => ({
        planet: row.planet,
        ...(row.facet === null ? {} : { facet: row.facet }),
        day: row.day,
        readers: row.readers,
      }));
    },
    async readLiveGaps() {
      const { rows } = await sql<GapDbRow>`select ${GAP_COLUMNS} from supply.gaps
        where status not in ('closed', 'rejected') order by first_seen_at, id`.execute(trx);
      return rows.map(gapOf);
    },
    async readLastRejected(holes) {
      if (holes.length === 0) return [];
      const keys = holes.map((hole) => gapKeyOf(hole.kind, hole));
      const { rows } = await sql<{
        kind: string;
        planet: string;
        facet: string | null;
        reason: string;
        closed_at: Date;
      }>`select distinct on (key) kind, planet, facet, reason, closed_at from supply.gaps
        where status = 'rejected' and key in (${sql.join(keys)}) order by key, closed_at desc`.execute(trx);
      return rows.map((row) => ({
        kind: row.kind as GapKind,
        planet: row.planet,
        ...(row.facet === null ? {} : { facet: row.facet }),
        reason: row.reason,
        endedAt: row.closed_at,
      }));
    },
    async createGap(candidate, priority, id, now) {
      const { rows } =
        await sql`insert into supply.gaps (id, key, kind, planet, facet, priority, readers, first_seen_at, last_seen_at, updated_at)
        values (${id}::uuid, ${gapKeyOf(candidate.kind, candidate)}, ${candidate.kind}, ${candidate.planet}, ${candidate.facet ?? null},
          ${priority}, ${candidate.readers}, ${now}, ${now}, ${now})
        on conflict (key) where status not in ('closed', 'rejected') do nothing returning id`.execute(trx);
      return rows.length === 1;
    },
    async refreshGap(id, candidate, priority, now) {
      await sql`update supply.gaps set priority = ${priority}, readers = ${candidate.readers}, last_seen_at = ${now}, updated_at = ${now}
        where id = ${id}::uuid and status not in ('closed', 'rejected')`.execute(trx);
    },
    async closeGap(id, reason, now) {
      await sql`update supply.gaps set status = 'closed', reason = ${reason}, closed_at = ${now}, attempt_day = null, updated_at = ${now}
        where id = ${id}::uuid and status not in ('closed', 'rejected')`.execute(trx);
    },
    async endRound(id, to, rounds, now) {
      // A failed production round: `open` forgets the recipes (every one ended); `briefed` keeps what is stored to be commissioned again.
      await sql`update supply.gaps set status = ${to}, rounds = ${rounds}, recipes = case when ${to} = 'open' then '{}' else recipes end,
          proposal_run_id = case when ${to} = 'open' then null else proposal_run_id end, commissioned_at = null,
          reason = ${to === 'open' ? 'recipes_ended' : 'take_rejected'}, attempt_day = null, updated_at = ${now}
        where id = ${id}::uuid and status = 'commissioned'`.execute(trx);
    },
    async rejectGap(id, reason, rounds, now) {
      await sql`update supply.gaps set status = 'rejected', rounds = ${rounds}, reason = ${reason}, closed_at = ${now}, attempt_day = null, updated_at = ${now}
        where id = ${id}::uuid and status = 'commissioned'`.execute(trx);
    },
  };
}

/**
 * The scan's store: one transaction that holds an advisory lock taken with a try, so a second scan simply does not run while the
 * first does. Reads and writes only the loop's own tables.
 */
export const gapScanStore = (db: Kysely<Database>): GapScanStore => ({
  exclusively: (work) =>
    withTransaction(db, 'supply.scan-gaps', async (trx) => {
      const { rows } = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(${SCAN_LOCK}) as locked`.execute(
        trx,
      );
      return rows[0]?.locked === true ? work(scanTx(trx)) : undefined;
    }),
});

/**
 * Keeps two passes of the brief job from overlapping, with a session advisory lock on one dedicated connection (`withSessionLock`): the pass runs
 * while this process holds it, a second pass finds it held and does nothing, and a crash releases it with the connection. No transaction is open
 * across the pass (a model call never holds one); the pass does its own work on the pool.
 */
export const gapBriefLock = (db: Kysely<Database>): GapBriefLock => ({
  exclusively: (work) => withSessionLock(db, 'supply.brief-gap', work),
});

/** The brief job's store: each call is one short statement or transaction on its own gap row. */
export const gapBriefStore = (db: Kysely<Database>): GapBriefStore => ({
  async actionable(limit) {
    const { rows } = await sql<GapDbRow>`select ${GAP_COLUMNS} from supply.gaps where status in ('open', 'briefed')
      order by priority desc, first_seen_at, id limit ${limit}`.execute(db);
    return rows.map(gapOf);
  },
  async commissioned(limit) {
    const { rows } = await sql<GapDbRow>`select ${GAP_COLUMNS} from supply.gaps where status = 'commissioned'
      order by commissioned_at, id limit ${limit}`.execute(db);
    return rows.map(gapOf);
  },
  async attemptedSince(since) {
    const { rows } = await sql<{
      n: string;
    }>`select count(*) as n from supply.gaps where last_attempt_at >= ${since}`.execute(db);
    return Number(rows[0]?.n ?? 0);
  },
  async beginAttempt(id, day, now) {
    const { rows } = await sql<{ day: string }>`update supply.gaps
      set attempt_day = coalesce(attempt_day, ${day}::date), last_attempt_at = ${now}, updated_at = ${now}
      where id = ${id}::uuid and status in ('open', 'briefed')
      returning to_char(attempt_day, 'YYYY-MM-DD') as day`.execute(db);
    return rows[0]?.day;
  },
  async settle(id, transition: GapTransition, now) {
    switch (transition.kind) {
      case 'briefed':
        await sql`update supply.gaps set status = 'briefed', recipes = ${transition.recipes}::text[],
            proposal_run_id = ${transition.runId ?? null}::uuid, reason = null, attempt_day = null, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
      case 'failed':
        await sql`update supply.gaps set attempts = ${transition.attempts}, reason = ${transition.reason}, attempt_day = null, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
      case 'rejected':
        await sql`update supply.gaps set status = 'rejected', attempts = ${transition.attempts}, reason = ${transition.reason},
            closed_at = ${now}, attempt_day = null, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
      case 'refused':
        // Nothing was sent: the attempt is neither spent nor counted against the day's budget.
        await sql`update supply.gaps set status = 'rejected', reason = ${transition.reason}, closed_at = ${now},
            attempt_day = null, last_attempt_at = null, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
      case 'blocked':
        await sql`update supply.gaps set status = 'blocked_unknown', reason = ${transition.reason},
            proposal_run_id = ${transition.runId ?? null}::uuid, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
      case 'keep':
        await sql`update supply.gaps set reason = ${transition.reason}, updated_at = ${now}
          where id = ${id}::uuid and status in ('open', 'briefed')`.execute(db);
        return;
    }
  },
  async commission(id, recipes, now) {
    await sql`update supply.gaps set status = 'commissioned', recipes = ${[...recipes]}::text[],
        commissioned_at = coalesce(commissioned_at, ${now}), reason = null, attempt_day = null, updated_at = ${now}
      where id = ${id}::uuid and status in ('open', 'briefed', 'commissioned')`.execute(db);
  },
});

/** One line of the operator's list: codes, catalogue ids and counts only (the columns of `ops.supply_gaps`). */
export interface GapListing {
  readonly gapId: string;
  readonly kind: string | null;
  readonly planet: string | null;
  readonly facet: string | null;
  readonly status: string | null;
  readonly priority: number;
  readonly readers: number;
  readonly attempts: number;
  readonly reason: string | null;
  readonly recipes: number;
  readonly firstSeenAt: string;
  readonly lastAttemptAt: string | null;
}

/** What `supply gaps` shows: the counts of the gaps by status and kind, and the gaps themselves, most pressing first. */
export interface GapSummary {
  readonly counts: readonly { readonly status: string | null; readonly kind: string | null; readonly count: number }[];
  readonly gaps: readonly GapListing[];
  readonly more: boolean;
}

/** The most gaps the operator's list prints. */
export const GAP_LIST_LIMIT = 200;

/** Reads the operator's view of the gaps (`ops.supply_gaps`: codes and counts, no recipe text), newest pressing first. */
export async function readGapSummary(
  db: Queryable,
  options: { readonly status?: GapStatus } = {},
): Promise<GapSummary> {
  const filter = options.status === undefined ? sql`true` : sql`status = ${options.status}`;
  const counts = await sql<{ status: string | null; kind: string | null; n: string }>`
    select status, kind, count(*) as n from ops.supply_gaps where ${filter} group by status, kind order by status, kind`.execute(
    db,
  );
  const rows = await sql<{
    gap_id: string;
    kind: string | null;
    planet: string | null;
    facet: string | null;
    status: string | null;
    priority: number;
    readers: number;
    attempts: number;
    reason: string | null;
    recipes: number;
    first_seen_at: Date;
    last_attempt_at: Date | null;
  }>`select gap_id, kind, planet, facet, status, priority, readers, attempts, reason, recipes, first_seen_at, last_attempt_at
    from ops.supply_gaps where ${filter} order by (closed_at is null) desc, priority desc, first_seen_at, gap_id
    limit ${GAP_LIST_LIMIT + 1}`.execute(db);
  return {
    counts: counts.rows.map((row) => ({ status: row.status, kind: row.kind, count: Number(row.n) })),
    gaps: rows.rows.slice(0, GAP_LIST_LIMIT).map((row) => ({
      gapId: row.gap_id,
      kind: row.kind,
      planet: row.planet,
      facet: row.facet,
      status: row.status,
      priority: row.priority,
      readers: row.readers,
      attempts: row.attempts,
      reason: row.reason,
      recipes: row.recipes,
      firstSeenAt: row.first_seen_at.toISOString(),
      lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    })),
    more: rows.rows.length > GAP_LIST_LIMIT,
  };
}

/** What an operator's settlement of a blocked gap came to. */
export type SettleBlockedResult =
  | { readonly kind: 'not_found' }
  /** Refused: the gap is not blocked, names no run, or an attempt of its run is still reserved, dispatched or unknown in the ledger. */
  | { readonly kind: 'refused'; readonly verdict: Exclude<BlockedVerdict, 'ready'>; readonly unresolved: number }
  /** The ledger is settled; no action was asked for, so nothing changed. */
  | { readonly kind: 'ready' }
  | { readonly kind: 'reopened' | 'closed' };

/**
 * `supply gaps settle --key <hex> [--reopen|--close]` (#674, D-414): an operator's decision about a gap blocked by an attempt of unknown outcome.
 * It acts only after that attempt has been settled in the ledger (no attempt of the gap's run is still reserved, dispatched or unknown: each was
 * reconciled, written off or never sent), never before, and never for a gap that is not blocked or that names no run. `reopen` makes the gap
 * `open` again and counts the blocked attempt as a failed one, so the next request has an identity of its own and is never the one that was
 * blocked; `close` ends it. With no action it only says whether the ledger is settled. One short transaction under the gap's row lock; no model
 * and no provider.
 */
export function settleBlockedGap(
  db: Kysely<Database>,
  input: { readonly key: string; readonly action?: 'reopen' | 'close' },
  now: Date = new Date(),
): Promise<SettleBlockedResult> {
  return withTransaction(db, 'supply.settle-blocked-gap', async (trx) => {
    const found = await sql<{
      id: string;
      status: string;
      run: string | null;
    }>`select id, status, proposal_run_id as run from supply.gaps
      where key = ${input.key} and status not in ('closed', 'rejected') for update`.execute(trx);
    const gap = found.rows[0];
    if (gap === undefined) return { kind: 'not_found' } as const;
    const unresolved =
      gap.run === null
        ? 0
        : Number(
            (
              await sql<{ n: string }>`select count(*) as n from reasoning.production_attempts
                where run_id = ${gap.run}::uuid and state in ('reserved', 'dispatched', 'unknown')`.execute(trx)
            ).rows[0]?.n ?? 0,
          );
    const verdict = blockedVerdict(
      { status: gap.status as GapStatus, ...(gap.run === null ? {} : { runId: gap.run }) },
      unresolved,
    );
    if (verdict !== 'ready') return { kind: 'refused', verdict, unresolved } as const;
    if (input.action === undefined) return { kind: 'ready' } as const;
    if (input.action === 'close') {
      await sql`update supply.gaps set status = 'closed', reason = 'settled_closed', closed_at = ${now}, attempt_day = null, updated_at = ${now}
        where id = ${gap.id}::uuid`.execute(trx);
      return { kind: 'closed' } as const;
    }
    await sql`update supply.gaps set status = 'open', attempts = least(attempts + 1, ${MAX_GAP_ATTEMPTS}), recipes = '{}', proposal_run_id = null,
        reason = 'settled_reopened', attempt_day = null, updated_at = ${now}
      where id = ${gap.id}::uuid`.execute(trx);
    return { kind: 'reopened' } as const;
  });
}
