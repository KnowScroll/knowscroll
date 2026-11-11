import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { RULE_CODES, UNSUPPORTED_KINDS, type NoClaimGround } from '../domain/ask-support.js';
import {
  LIBRARY_FIELDS,
  LIBRARY_SENTENCE_OUTCOMES,
  type CheckVerdict,
  type LibrarySentenceResult,
} from '../domain/library-support.js';

/**
 * The stored results of the library support check (D-415), `content.library_support_checks`: one row for a revision and a checker
 * version. SQL only: no model, network or business rule. The use case decides what to write; this file writes it once, keeps an
 * existing row unless a provider failure is tried again, and reads rows back through a schema, because a row is read by tools that
 * outlive the version that wrote it.
 */

/** A check that ended on a provider failure is tried again in a new round, at most this many times in all. */
export const LIBRARY_SUPPORT_MAX_ROUNDS = 3;

/**
 * The code of a check that ended on a conclusive provider failure and may be tried again: its rounds and its requests are not spent. The run of
 * the failed batch is ended for good, so a later round asks that batch in a run of its own and reads the batches before it from the ledger.
 */
export const RETRYABLE_CODE = 'provider_failed';

/** The code of a provider failure that is not tried again: the third round failed, or another round could pass the revision's bound of requests. */
export const FINAL_PROVIDER_CODE = 'provider_failed_final';

const NO_CLAIM_GROUNDS = ['question', 'gap', 'label', 'short', 'unshared'] as const satisfies readonly NoClaimGround[];

const StoredSentences = z.array(
  z.strictObject({
    n: z.number().int().min(1),
    part: z.string().min(1).max(64),
    field: z.enum(LIBRARY_FIELDS),
    text: z.string().min(1).max(2_000),
    label: z.literal(true).optional(),
    outcome: z.enum(LIBRARY_SENTENCE_OUTCOMES),
    kind: z.enum(UNSUPPORTED_KINDS).optional(),
    code: z.enum(RULE_CODES).optional(),
    problem: z.string().min(1).max(400).optional(),
    ground: z.enum(NO_CLAIM_GROUNDS).optional(),
    quote: z.string().min(1).max(1_200).optional(),
    keyWords: z.number().int().min(0).optional(),
    quoteKeyWords: z.number().int().min(0).optional(),
    shared: z.number().int().min(0).optional(),
  }),
);

/** How often each batch failed, by index. */
const BatchFailures = z.record(z.string().regex(/^\d{1,3}$/u), z.number().int().min(1).max(3));

/** One row as the use case, the review gate and the replay read it. */
export interface StoredLibraryCheck {
  readonly assetId: string;
  readonly revision: number;
  readonly checkerVersion: string;
  readonly state: 'checked' | 'unchecked';
  /** Why a check gave nothing; never provider text. `null` for a checked result. */
  readonly code: string | null;
  readonly verdict: CheckVerdict;
  readonly policyVersion: string;
  readonly round: number;
  /** How often each batch (by index) failed conclusively over the rounds; empty when none did. */
  readonly batchFailures: Readonly<Record<string, number>>;
  readonly sentenceCount: number;
  readonly batches: number;
  /** Paid requests in all, over every round. */
  readonly requests: number;
  /** The sentences with what became of each, in reading order; empty for a check that gave nothing. */
  readonly sentences: readonly LibrarySentenceResult[];
  readonly checkedAt: string;
}

interface CheckRow {
  asset_id: string;
  revision: number;
  checker_version: string;
  state: 'checked' | 'unchecked';
  code: string | null;
  verdict: CheckVerdict;
  policy_version: string;
  check_round: number;
  batch_failures: unknown;
  sentence_count: number;
  batches: number;
  requests: number;
  sentences: unknown;
  checked_at: Date;
}

const COLUMNS = sql`asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, batch_failures, sentence_count, batches, requests, sentences, checked_at`;

function storedOf(row: CheckRow): StoredLibraryCheck | undefined {
  const sentences = StoredSentences.safeParse(row.sentences);
  const failures = BatchFailures.safeParse(row.batch_failures);
  if (!sentences.success || !failures.success) return undefined;
  return {
    assetId: row.asset_id,
    revision: row.revision,
    checkerVersion: row.checker_version,
    state: row.state,
    code: row.code,
    verdict: row.verdict,
    policyVersion: row.policy_version,
    round: row.check_round,
    batchFailures: failures.data,
    sentenceCount: row.sentence_count,
    batches: row.batches,
    requests: row.requests,
    sentences: sentences.data,
    checkedAt: row.checked_at.toISOString(),
  };
}

/** A stored revision as the check reads it: the document, its private provenance and where the operator's decision stands. */
export interface CheckSubject {
  readonly document: unknown;
  /** `undefined` when the revision has no provenance row. */
  readonly provenance: unknown;
  readonly review: 'held' | 'released' | 'rejected' | null;
}

type Queryable = Kysely<Database> | Transaction<Database>;

export const libraryCheckStore = {
  /** The revision's stored document and provenance, or `undefined` when it does not exist. */
  async readSubject(db: Queryable, assetId: string, revision: number): Promise<CheckSubject | undefined> {
    const { rows } = await sql<{
      document: unknown;
      provenance: unknown;
      review: 'held' | 'released' | 'rejected' | null;
    }>`select revision.document, provenance.provenance, review.state as review
      from content.asset_revisions revision
      left join content.asset_provenance provenance
        on provenance.asset_id = revision.asset_id and provenance.revision = revision.revision
      left join content.revision_reviews review
        on review.asset_id = revision.asset_id and review.revision = revision.revision
      where revision.asset_id = ${assetId}::uuid and revision.revision = ${revision}::integer`.execute(db);
    const [row] = rows;
    return row === undefined
      ? undefined
      : { document: row.document, provenance: row.provenance ?? undefined, review: row.review };
  },

  /** The result of a checker version for a revision, or `undefined` when none was stored (or the row is unreadable). */
  async read(
    db: Queryable,
    assetId: string,
    revision: number,
    checkerVersion: string,
  ): Promise<StoredLibraryCheck | undefined> {
    const { rows } = await sql<CheckRow>`select ${COLUMNS} from content.library_support_checks
      where asset_id = ${assetId}::uuid and revision = ${revision}::integer and checker_version = ${checkerVersion}`.execute(
      db,
    );
    return rows[0] === undefined ? undefined : storedOf(rows[0]);
  },

  /**
   * The results of a checker version for these revisions, keyed by `assetId:revision`. A row whose sentences no longer read
   * is left out, as if it were not stored.
   */
  async readMany(
    db: Queryable,
    checkerVersion: string,
    revisions: readonly { readonly assetId: string; readonly revision: number }[],
  ): Promise<ReadonlyMap<string, StoredLibraryCheck>> {
    if (revisions.length === 0) return new Map();
    const { rows } = await sql<CheckRow>`select ${COLUMNS} from content.library_support_checks
      where checker_version = ${checkerVersion}
        and (asset_id, revision) in (${sql.join(revisions.map((entry) => sql`(${entry.assetId}::uuid, ${entry.revision}::integer)`))})`.execute(
      db,
    );
    const stored = rows.flatMap((row) => storedOf(row) ?? []);
    return new Map(stored.map((check) => [`${check.assetId}:${String(check.revision)}`, check]));
  },

  /**
   * Stores a result. A first result is written once: a second writer of the same revision and checker version changes nothing
   * (`kept`). The one exception is a check that ended on a provider failure, which a later round replaces. Call it in the
   * transaction that closes the reasoning runs the check used.
   */
  async write(trx: Transaction<Database>, check: Omit<StoredLibraryCheck, 'checkedAt'>): Promise<'written' | 'kept'> {
    const { rows } = await sql<{ check_round: number }>`insert into content.library_support_checks
        (asset_id, revision, checker_version, state, code, verdict, policy_version, check_round, batch_failures, sentence_count, batches, requests, sentences)
      values (${check.assetId}::uuid, ${check.revision}::integer, ${check.checkerVersion}, ${check.state}, ${check.code},
        ${check.verdict}, ${check.policyVersion}, ${check.round}::integer, ${JSON.stringify(check.batchFailures)}::jsonb,
        ${check.sentenceCount}::integer, ${check.batches}::integer, ${check.requests}::integer, ${JSON.stringify(check.sentences)}::jsonb)
      on conflict (asset_id, revision, checker_version) do update set
        state = excluded.state, code = excluded.code, verdict = excluded.verdict, policy_version = excluded.policy_version,
        check_round = excluded.check_round, batch_failures = excluded.batch_failures, sentence_count = excluded.sentence_count, batches = excluded.batches,
        requests = excluded.requests, sentences = excluded.sentences, checked_at = now()
      where content.library_support_checks.state = 'unchecked'
        and content.library_support_checks.code = ${RETRYABLE_CODE}
        and content.library_support_checks.check_round < excluded.check_round
      returning check_round`.execute(trx);
    return rows.length === 0 ? 'kept' : 'written';
  },

  /**
   * The held revisions that have no result of this checker version, or whose last try ended on a provider failure at least
   * `retryAfterSeconds` ago with rounds left, oldest hold first: what the sweep hands to the check job. `limit` bounds one pass.
   */
  async dueHeld(
    db: Queryable,
    checkerVersion: string,
    options: { readonly limit: number; readonly retryAfterSeconds: number },
  ): Promise<readonly { readonly assetId: string; readonly revision: number }[]> {
    const { rows } = await sql<{ asset_id: string; revision: number }>`select review.asset_id, review.revision
      from content.revision_reviews review
      left join content.library_support_checks done
        on done.asset_id = review.asset_id and done.revision = review.revision and done.checker_version = ${checkerVersion}
      where review.state = 'held'
        and (done.asset_id is null
          or (done.state = 'unchecked' and done.code = ${RETRYABLE_CODE} and done.check_round < ${LIBRARY_SUPPORT_MAX_ROUNDS}
            and done.checked_at < now() - make_interval(secs => ${options.retryAfterSeconds}::integer)))
      order by review.held_at, review.asset_id, review.revision
      limit ${options.limit}::integer`.execute(db);
    return rows.map((row) => ({ assetId: row.asset_id, revision: row.revision }));
  },

  /**
   * The revisions an operator released or rejected, newest decision first, with the decision and when it was made: what the replay
   * measures the check against. Only a person's decisions count (`decided_by` is `cli:<operator>`): a later automatic release is no answer key
   * for the check that made it. `since` keeps only decisions made at or after it.
   */
  async decided(
    db: Queryable,
    options: { readonly since: Date | undefined; readonly limit: number },
  ): Promise<
    readonly {
      readonly assetId: string;
      readonly revision: number;
      readonly decision: 'released' | 'rejected';
      readonly decidedAt: string;
    }[]
  > {
    const since =
      options.since === undefined ? sql`` : sql`and review.decided_at >= ${options.since.toISOString()}::timestamptz`;
    const { rows } = await sql<{
      asset_id: string;
      revision: number;
      state: 'released' | 'rejected';
      decided_at: Date;
    }>`select review.asset_id, review.revision, review.state, review.decided_at
      from content.revision_reviews review
      where review.state in ('released', 'rejected') and review.decided_by like 'cli:%' ${since}
      order by review.decided_at desc, review.asset_id, review.revision
      limit ${options.limit}::integer`.execute(db);
    return rows.map((row) => ({
      assetId: row.asset_id,
      revision: row.revision,
      decision: row.state,
      decidedAt: row.decided_at.toISOString(),
    }));
  },
};
