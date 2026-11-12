import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { PERMANENT_HOLDS, POLICY_DECIDER_PREFIX } from '../domain/release-policy.js';
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from '../domain/release-sensitive-data.js';

/**
 * SQL of the release policy (D-418), no model, network or business rule: the topics a person approved, the raises recorded against a
 * revision, and the reads the release step and the operator's status make over the review gate's rows. The rules live in
 * `domain/release-policy.ts` and the orchestration in `release-policy.ts`.
 */

type Queryable = Kysely<Database> | Transaction<Database>;

/** The advisory lock that orders the daily cap's count: taken inside a release transaction, after the asset's own lock. */
export const RELEASE_POLICY_LOCK = 'content.release-policy';

/** The pattern of a policy decision's `decided_by`, as a literal so that the planner can use the partial index on it. */
const POLICY_LIKE = sql.lit(`${POLICY_DECIDER_PREFIX}%`);

/** The UTC day's start, as an SQL expression: the cap's window. */
const startOfUtcDay = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/** A held revision as the release step sees it before it reads the revision's body: cheap facts only. */
export interface HeldSummary {
  readonly assetId: string;
  readonly revision: number;
  /** `held` for a new asset (nothing served yet), `admitted` when the asset serves an earlier revision, `withdrawn`. */
  readonly assetStatus: 'held' | 'admitted' | 'withdrawn';
  /** The revision's primary attributions. Exactly one is a topic; none or several are not. */
  readonly topicIds: readonly string[];
  /** A person approved the primary topic and has not revoked it. */
  readonly approved: boolean;
  /** An active coverage mapping is at the head for the revision. */
  readonly mapped: boolean;
  /** The current checker version has a stored result with this state and verdict, or `null` when it has none. */
  readonly currentCheck: { readonly state: 'checked' | 'unchecked'; readonly verdict: string } | null;
  /** Results exist for another checker version. */
  readonly otherVersionCheck: boolean;
}

interface HeldRow {
  asset_id: string;
  revision: number;
  asset_status: string;
  topic_ids: string[];
  approved: boolean;
  mapped: boolean;
  current_state: 'checked' | 'unchecked' | null;
  current_verdict: string | null;
  other_version: boolean;
}

const assetStatusOf = (status: string): HeldSummary['assetStatus'] =>
  status === 'held' || status === 'admitted' ? status : 'withdrawn';

/** What the policy reads of a revision's body: the stored document and the receipts of the job that produced it. */
export interface RevisionBody {
  readonly document: unknown;
  readonly outcomes: unknown;
}

const RaiseRows = z.array(z.object({ category: z.enum(SENSITIVE_CATEGORIES) }));

export const releasePolicyStore = {
  /**
   * Records that a person approved the topic, unless an approval is live already. One live approval for a topic at most: the partial
   * unique index decides a race, and the loser reads `already_approved`.
   */
  async approveTopic(db: Queryable, topicId: string, approvedBy: string): Promise<'approved' | 'already_approved'> {
    const { rows } = await sql<{ id: string }>`insert into content.release_topic_approvals (topic_id, approved_by)
      values (${topicId}, ${approvedBy})
      on conflict (topic_id) where revoked_at is null do nothing
      returning id`.execute(db);
    return rows.length === 0 ? 'already_approved' : 'approved';
  },

  /**
   * Takes the live approval of a topic back, keeping the row with who and why. `already_revoked`: an earlier approval was revoked and none is
   * live. `never_approved`: the topic was never approved.
   */
  async revokeTopic(
    db: Queryable,
    topicId: string,
    revokedBy: string,
    revokedFor: 'operator' | 'withdrawal',
  ): Promise<'revoked' | 'already_revoked' | 'never_approved'> {
    const { rows } = await sql<{ id: string }>`update content.release_topic_approvals
      set revoked_by = ${revokedBy}, revoked_at = now(), revoked_for = ${revokedFor}
      where topic_id = ${topicId} and revoked_at is null
      returning id`.execute(db);
    if (rows.length > 0) return 'revoked';
    const earlier = await sql<{ seen: boolean }>`select true as seen from content.release_topic_approvals
      where topic_id = ${topicId} limit 1`.execute(db);
    return earlier.rows.length > 0 ? 'already_revoked' : 'never_approved';
  },

  /**
   * The held revisions of Scrolls with the facts that need no body. `only` names one revision (the release transaction reads its own that way, under the asset's lock).
   * With `onlyReady` it keeps only those the policy could release on these facts: a new asset, an approved topic, an active mapping and a stored `checked` result
   * of this checker version with the verdict `passed`, so a revision that is held for a good reason does not make the body of every other one be read. The stored
   * verdict is a filter only: the release transaction decides it again from the sentences.
   * With `paging` (the sweep) the order is the revision least recently looked at first, never looked at before any, oldest hold first among equals; a revision looked at
   * since `lookedBefore` is left out, so a sweep's pages end; and one whose recorded hold is permanent under `rulesVersion` is left out. Without it the order is the
   * oldest hold first.
   */
  async heldSummaries(
    db: Queryable,
    options: {
      readonly checkerVersion: string;
      readonly onlyReady: boolean;
      readonly limit: number;
      readonly only?: { readonly assetId: string; readonly revision: number };
      readonly paging?: { readonly rulesVersion: string; readonly lookedBefore: string };
    },
  ): Promise<readonly HeldSummary[]> {
    const ready = options.onlyReady
      ? sql`and asset.status = 'held' and approved.flag and mapped.flag and this_version.state = 'checked' and this_version.verdict = 'passed'`
      : sql``;
    const only =
      options.only === undefined
        ? sql``
        : sql`and review.asset_id = ${options.only.assetId}::uuid and review.revision = ${options.only.revision}::integer`;
    const paging =
      options.paging === undefined
        ? sql``
        : sql`and (look.looked_at is null or look.looked_at < ${options.paging.lookedBefore}::timestamptz)
          and not coalesce(look.hold_code = any(${[...PERMANENT_HOLDS]}::text[]) and look.rules_version = ${options.paging.rulesVersion}, false)`;
    const order =
      options.paging === undefined
        ? sql`review.held_at, review.asset_id, review.revision`
        : sql`look.looked_at nulls first, review.held_at, review.asset_id, review.revision`;
    const { rows } = await sql<HeldRow>`select review.asset_id, review.revision, asset.status as asset_status,
        topics.ids as topic_ids, approved.flag as approved, mapped.flag as mapped,
        this_version.state as current_state, this_version.verdict as current_verdict, other.flag as other_version
      from content.revision_reviews review
      join content.assets asset on asset.id = review.asset_id and asset.kind = 'scroll'
      left join content.release_policy_looks look on look.asset_id = review.asset_id and look.revision = review.revision
      cross join lateral (select coalesce(array_agg(topic.topic_id order by topic.topic_id), '{}'::text[]) as ids
        from content.encounter_topics topic
        where topic.asset_id = review.asset_id and topic.asset_revision = review.revision and topic.role = 'primary') topics
      cross join lateral (select exists (select 1 from content.encounter_topics topic
          join content.release_topic_approvals approval on approval.topic_id = topic.topic_id and approval.revoked_at is null
          where topic.asset_id = review.asset_id and topic.asset_revision = review.revision and topic.role = 'primary') as flag) approved
      cross join lateral (select exists (select 1 from content.coverage_heads head
          join content.coverage_revisions mapping on mapping.asset_id = head.asset_id
            and mapping.asset_revision = head.asset_revision and mapping.revision = head.revision
          where head.asset_id = review.asset_id and head.asset_revision = review.revision
            and mapping.status = 'active') as flag) mapped
      left join lateral (select check_row.state, check_row.verdict from content.library_support_checks check_row
        where check_row.asset_id = review.asset_id and check_row.revision = review.revision
          and check_row.checker_version = ${options.checkerVersion}) this_version on true
      cross join lateral (select exists (select 1 from content.library_support_checks check_row
        where check_row.asset_id = review.asset_id and check_row.revision = review.revision
          and check_row.checker_version <> ${options.checkerVersion}) as flag) other
      where review.state = 'held' ${only} ${ready} ${paging}
      order by ${order}
      limit ${options.limit}::integer`.execute(db);
    return rows.map((row) => ({
      assetId: row.asset_id,
      revision: row.revision,
      assetStatus: assetStatusOf(row.asset_status),
      topicIds: row.topic_ids,
      approved: row.approved,
      mapped: row.mapped,
      currentCheck:
        row.current_state === null ? null : { state: row.current_state, verdict: row.current_verdict ?? 'unchecked' },
      otherVersionCheck: row.other_version,
    }));
  },

  /** The database's clock, as text so that its microseconds survive: where a sweep's pages begin and end (a look is stamped with the same clock). */
  async clock(db: Queryable): Promise<string> {
    const { rows } = await sql<{ now: string }>`select clock_timestamp()::text as now`.execute(db);
    return rows[0]?.now ?? '';
  },

  /** Records what the sweep made of a held revision: the code it stayed held for and the rules it was judged under. Replaces the earlier look. */
  async recordLook(
    db: Queryable,
    look: {
      readonly assetId: string;
      readonly revision: number;
      readonly holdCode: string;
      readonly rulesVersion: string;
    },
  ): Promise<void> {
    await sql`insert into content.release_policy_looks (asset_id, revision, hold_code, rules_version, looked_at)
      values (${look.assetId}::uuid, ${look.revision}::integer, ${look.holdCode.slice(0, 64)}, ${look.rulesVersion}, clock_timestamp())
      on conflict (asset_id, revision) do update
        set hold_code = excluded.hold_code, rules_version = excluded.rules_version, looked_at = excluded.looked_at`.execute(
      db,
    );
  },

  /**
   * Locks the live approval of the revision's primary topic `for share`, so inside a release transaction a revocation waits for the release to commit
   * instead of slipping in between the check and the release. Takes nothing when there is no live approval (then the release is refused anyway).
   */
  async lockApproval(trx: Transaction<Database>, assetId: string, revision: number): Promise<void> {
    await sql`select approval.id from content.release_topic_approvals approval
      join content.encounter_topics topic on topic.topic_id = approval.topic_id and topic.role = 'primary'
        and topic.asset_id = ${assetId}::uuid and topic.asset_revision = ${revision}::integer
      where approval.revoked_at is null for share of approval`.execute(trx);
  },

  /** Records who withdrew a Scroll the policy released, and what became of its topic's approval. The first withdrawal of a revision is kept. */
  async recordWithdrawal(
    trx: Transaction<Database>,
    withdrawal: {
      readonly assetId: string;
      readonly revision: number;
      readonly withdrawnBy: string;
      readonly topicId: string | null;
      readonly approval: 'revoked' | 'already_revoked' | 'never_approved' | 'no_topic';
    },
  ): Promise<void> {
    await sql`insert into content.release_withdrawals (asset_id, revision, withdrawn_by, topic_id, approval)
      values (${withdrawal.assetId}::uuid, ${withdrawal.revision}::integer, ${withdrawal.withdrawnBy}, ${withdrawal.topicId}, ${withdrawal.approval})
      on conflict (asset_id, revision) do nothing`.execute(trx);
  },

  /** The document of a revision and the receipts of the job that produced it (the answer check is among them); `undefined` when there is no such revision. */
  async readBody(db: Queryable, assetId: string, revision: number): Promise<RevisionBody | undefined> {
    const { rows } = await sql<{ document: unknown; outcomes: unknown }>`select revision.document,
        (select job.outcomes from content.scroll_production_runs job
          where job.asset_id = revision.asset_id and job.asset_revision = revision.revision
          order by job.created_at desc limit 1) as outcomes
      from content.asset_revisions revision
      where revision.asset_id = ${assetId}::uuid and revision.revision = ${revision}::integer`.execute(db);
    const [row] = rows;
    return row === undefined ? undefined : { document: row.document, outcomes: row.outcomes };
  },

  /** The categories recorded as raises against the revision, in the data file's order. */
  async raisesOf(db: Queryable, assetId: string, revision: number): Promise<readonly SensitiveCategory[]> {
    const { rows } = await sql<{ category: string }>`select distinct category from content.release_risk_raises
      where asset_id = ${assetId}::uuid and revision = ${revision}::integer`.execute(db);
    const known = RaiseRows.parse(rows).map((row) => row.category);
    return SENSITIVE_CATEGORIES.filter((category) => known.includes(category));
  },

  /**
   * Records a raise against a revision that went through the review gate. Idempotent. A raise is never changed or removed
   * (the table refuses it), so the only thing a proposal can do is make a Scroll wait for a person.
   */
  async recordRaise(
    db: Queryable,
    raise: {
      readonly assetId: string;
      readonly revision: number;
      readonly category: SensitiveCategory;
      readonly proposedBy: string;
    },
  ): Promise<'recorded' | 'already_recorded' | 'not_under_review'> {
    const review = await sql<{ seen: boolean }>`select true as seen from content.revision_reviews
      where asset_id = ${raise.assetId}::uuid and revision = ${raise.revision}::integer`.execute(db);
    if (review.rows.length === 0) return 'not_under_review';
    const { rows } = await sql<{ category: string }>`insert into content.release_risk_raises
        (asset_id, revision, category, proposed_by)
      values (${raise.assetId}::uuid, ${raise.revision}::integer, ${raise.category}, ${raise.proposedBy})
      on conflict do nothing returning category`.execute(db);
    return rows.length === 0 ? 'already_recorded' : 'recorded';
  },

  /** The primary topics of a revision's attribution, as the release step reads them inside the release transaction. */
  async primaryTopics(db: Queryable, assetId: string, revision: number): Promise<readonly string[]> {
    const { rows } = await sql<{ topic_id: string }>`select topic_id from content.encounter_topics
      where asset_id = ${assetId}::uuid and asset_revision = ${revision}::integer and role = 'primary'
      order by topic_id`.execute(db);
    return rows.map((row) => row.topic_id);
  },

  /** How many Scrolls the policy released since the UTC day began. Counted from the review rows, so a restart cannot reset it. */
  async releasedToday(db: Queryable): Promise<number> {
    const { rows } = await sql<{ released: number }>`select count(*)::integer as released
      from content.revision_reviews
      where decided_by like ${POLICY_LIKE} and state = 'released' and decided_at >= ${startOfUtcDay}`.execute(db);
    return rows[0]?.released ?? 0;
  },

  /** Orders the cap's count: one policy release at a time counts and decides. Held to the end of the transaction. */
  async lockPolicy(trx: Transaction<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${RELEASE_POLICY_LOCK}, 0))`.execute(trx);
  },

  /** Counts for the operator's status: no id, no topic, no text. */
  async counts(db: Queryable): Promise<PolicyCounts> {
    const { rows } = await sql<PolicyCounts>`select
        (select count(*)::integer from content.release_topic_approvals where revoked_at is null) as "approvedTopics",
        (select count(*)::integer from content.release_topic_approvals where revoked_at is not null) as "revokedApprovals",
        (select count(*)::integer from content.revision_reviews where state = 'held') as "held",
        (select count(*)::integer from content.revision_reviews
          where decided_by like ${POLICY_LIKE} and state = 'released') as "releasedByPolicy",
        (select count(*)::integer from content.revision_reviews
          where decided_by like ${POLICY_LIKE} and state = 'released'
            and decided_at >= ${startOfUtcDay}) as "releasedToday",
        (select count(*)::integer from content.revision_reviews review join content.assets asset on asset.id = review.asset_id
          where review.decided_by like ${POLICY_LIKE} and review.state = 'released'
            and asset.status = 'withdrawn') as "withdrawnAfterPolicyRelease",
        (select count(*)::integer from content.release_risk_raises) as "raises"`.execute(db);
    const [row] = rows;
    if (row === undefined) throw new Error('RELEASE_POLICY_COUNTS_MISSING');
    return row;
  },
};

/** What `content policy status` prints about the stored rows. */
export interface PolicyCounts {
  /** Topics with a live approval. */
  readonly approvedTopics: number;
  /** Approvals that were revoked (kept as history). */
  readonly revokedApprovals: number;
  /** Revisions waiting for a decision, from anyone. */
  readonly held: number;
  /** Scrolls the policy released, ever. */
  readonly releasedByPolicy: number;
  readonly releasedToday: number;
  /** Of those, how many were withdrawn afterwards. */
  readonly withdrawnAfterPolicyRelease: number;
  /** Raises recorded against revisions. */
  readonly raises: number;
}
