import { sql, type Kysely } from 'kysely';
import { parseDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { summariseAnswerChecks } from '../domain/answer-check.js';
import { LIBRARY_SUPPORT_POLICY, countsOf, decideRevision } from '../domain/library-support.js';
import {
  POLICY_DECIDER_PREFIX,
  RELEASE_POLICY,
  assessRisk,
  categoriesOfTopic,
  decideAutoRelease,
  isCatalogueTopic,
  releasesLeftToday,
  type AnswerCheckFact,
  type AutoReleaseFacts,
  type SupportCheckFact,
} from '../domain/release-policy.js';
import { SENSITIVITY_VERSION, type SensitiveCategory } from '../domain/release-sensitive-data.js';
import { answerChecksOf } from '../production/answer-check.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../production/library-support.js';
import { libraryCheckStore } from '../production/library-support-store.js';
import { releasePolicyStore, type HeldSummary, type PolicyCounts } from './release-policy-store.js';
import { lockAssetForReview, makeReviewGate, type ReleaseGuard } from './review-gate.js';
import { reviewTextOf } from './review-text.js';

/** The most held revisions one sweep reads (the ones that pass every check that needs no body, oldest hold first). */
export const RELEASE_POLICY_SWEEP_LIMIT = 100;

/** The most held revisions `status` evaluates. */
export const RELEASE_POLICY_STATUS_LIMIT = 1_000;

/** The switch and the cap of a world, from the worker's configuration (`KS_CONTENT_AUTO_RELEASE_*`). */
export interface ReleasePolicySettings {
  readonly enabled: boolean;
  readonly dailyCap: number;
}

/** A Scroll the policy released, for the worker's diagnostic line: the topic and the revision, never the Scroll. */
export interface PolicyRelease {
  readonly assetId: string;
  readonly revision: number;
  readonly topicId: string;
}

export type SweepResult =
  /** The switch is off: nothing was read and nothing was released. */
  | { readonly kind: 'off' }
  | {
      readonly kind: 'swept';
      /** Held revisions that passed every check that needs no body and were looked at. */
      readonly considered: number;
      readonly released: readonly PolicyRelease[];
      /** For each code (a hold of the policy, `daily_cap_reached` or a refusal of the gate), how many of the revisions looked at stayed held for it. */
      readonly held: Readonly<Record<string, number>>;
      /** The day's cap was reached before every revision was looked at. */
      readonly capReached: boolean;
    };

export type ApproveTopicResult =
  | { readonly kind: 'approved' | 'already_approved'; readonly topicId: string }
  | { readonly kind: 'refused'; readonly reason: 'unknown_topic' }
  | {
      readonly kind: 'refused';
      readonly reason: 'sensitive_topic';
      readonly categories: readonly SensitiveCategory[];
    };

export type RevokeTopicResult =
  | { readonly kind: 'revoked' | 'already_revoked'; readonly topicId: string }
  | { readonly kind: 'refused'; readonly reason: 'never_approved' };

export type WithdrawResult =
  | {
      readonly kind: 'withdrawn' | 'already_withdrawn';
      readonly assetId: string;
      readonly revision: number;
      /** The topic the Scroll is attributed to, or `null` when it has none. */
      readonly topicId: string | null;
      /** What became of the topic's approval in the same transaction. */
      readonly approval: 'revoked' | 'already_revoked' | 'never_approved' | 'no_topic';
    }
  | {
      readonly kind: 'refused';
      /**
       * `not_found`: no such Scroll revision at the gate. `not_auto_released`: the revision was not released by the policy (a person released it,
       * or it is held or rejected), so this command leaves it alone. `not_the_served_revision`: the asset serves another revision now.
       */
      readonly reason: 'not_found' | 'not_auto_released' | 'not_the_served_revision';
    };

export type RaiseResult = Awaited<ReturnType<typeof releasePolicyStore.recordRaise>>;

/** What `content policy status` prints: counts only, no id, no topic and no text. */
export interface PolicyStatus {
  readonly policy: string;
  readonly sensitivity: string;
  /** The switch and the cap as the caller's environment says them. */
  readonly autoRelease: ReleasePolicySettings;
  readonly counts: PolicyCounts;
  /** Of the revisions waiting for a decision, how many the policy would release now and how many each code holds. `evaluated` is how many were looked at. */
  readonly held: {
    readonly evaluated: number;
    readonly wouldRelease: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** The line of `reviewTextOf` that carries the Scroll's measures (`1450 words · 7 minutes · …`): a count of words is not a year, so it is not scanned. */
const MEASURES_LINE = /^\d+ words · \d+(?:\.\d+)? minutes · /u;

/**
 * What the release policy scans for sensitive words: everything an operator reads of the Scroll (the title, every stop, call, aside, the recap and the Ask
 * suggestions, the picture's descriptions), without the line of measures and the answer check's note, which are not the Scroll's words.
 */
export function scanTextOf(document: ScrollDocumentV2): string {
  return reviewTextOf(document)
    .split('\n')
    .filter((line) => !MEASURES_LINE.test(line) && !line.startsWith('Answer check: '))
    .join('\n');
}

/** What the production job's answer check said about the revision, from the receipts the job kept. */
function answerCheckFact(outcomes: unknown): AnswerCheckFact {
  return summariseAnswerChecks(answerChecksOf(outcomes))?.outcome ?? 'none';
}

/** The facts of a held revision the policy decides from, read from stored rows: nothing is asked of a model. */
async function factsOf(db: Kysely<Database>, summary: HeldSummary): Promise<AutoReleaseFacts> {
  const topicId = summary.topicIds.length === 1 ? (summary.topicIds[0] ?? null) : null;
  const [body, raised, supportCheck] = await Promise.all([
    releasePolicyStore.readBody(db, summary.assetId, summary.revision),
    releasePolicyStore.raisesOf(db, summary.assetId, summary.revision),
    supportCheckFact(db, summary),
  ]);
  const parsed = body === undefined ? undefined : parseDocumentV2(body.document);
  return {
    assetStatus: summary.assetStatus,
    topicId,
    topicApproved: summary.approved,
    risk: assessRisk({ topicId, text: parsed?.kind === 'valid' ? scanTextOf(parsed.document) : '', raised }),
    documentReadable: parsed?.kind === 'valid',
    coverageMapped: summary.mapped,
    answerCheck: answerCheckFact(body?.outcomes),
    supportCheck,
  };
}

/**
 * What the library support check said for this build's checker version. The verdict is code's: it is read again from every stored
 * sentence under the policy in force, and a stored `passed` that the sentences no longer support counts as `flagged`.
 */
async function supportCheckFact(db: Kysely<Database>, summary: HeldSummary): Promise<SupportCheckFact> {
  const current = summary.currentCheck;
  if (current === null) return summary.otherVersionCheck ? { kind: 'stale' } : { kind: 'none' };
  if (current.state === 'unchecked') return { kind: 'unchecked' };
  const stored = await libraryCheckStore.read(db, summary.assetId, summary.revision, LIBRARY_SUPPORT_CHECK_VERSION);
  if (stored?.state !== 'checked') return { kind: 'none' };
  const decided = decideRevision(countsOf(stored.sentences), LIBRARY_SUPPORT_POLICY);
  return { kind: 'checked', verdict: stored.verdict === 'passed' && decided === 'passed' ? 'passed' : 'flagged' };
}

/**
 * The conditions of a policy release that are checked again inside the release transaction, under the asset's lock: a new asset, a topic that is
 * still approved, no raise recorded since, and the day's cap. Taking the policy lock first makes the cap's count and the release one step, so two
 * releases cannot both take the last place.
 */
function guardFor(target: { readonly assetId: string; readonly revision: number }, dailyCap: number): ReleaseGuard {
  return async (trx, { assetStatus }) => {
    if (assetStatus !== 'held') return 'replaces_served';
    await releasePolicyStore.lockPolicy(trx);
    const topics = await releasePolicyStore.primaryTopics(trx, target.assetId, target.revision);
    const topic = topics.length === 1 ? topics[0] : undefined;
    if (topic === undefined) return 'no_topic';
    if (categoriesOfTopic(topic).length > 0) return 'sensitive';
    if (!(await releasePolicyStore.isApproved(trx, topic))) return 'topic_not_approved';
    if ((await releasePolicyStore.raisesOf(trx, target.assetId, target.revision)).length > 0) return 'sensitive';
    if (releasesLeftToday(dailyCap, await releasePolicyStore.releasedToday(trx)) === 0) return 'daily_cap_reached';
    return undefined;
  };
}

/**
 * The release policy over the shared content tables (D-418): approve or revoke a topic, the sweep the worker runs to release a held Scroll the
 * policy allows, a withdrawal that also revokes the topic, and a status of counts. Shared content only: no model, network or personal root, and
 * no evidence of any person. Every release goes through the review gate's own release, so it is the same transaction, the same checks and the
 * same row, with `decided_by = policy:<name>`. A model's opinion never enters as a fact that lowers anything: the only model input is a recorded
 * raise, which can make a Scroll wait for a person.
 */
export function makeReleasePolicy(db: Kysely<Database>) {
  const gate = makeReviewGate(db);

  /** One sweep of the worker's release step. With the switch off it reads nothing. */
  async function sweep(settings: ReleasePolicySettings): Promise<SweepResult> {
    if (!settings.enabled) return { kind: 'off' };
    const held: Record<string, number> = {};
    const released: PolicyRelease[] = [];
    const left = releasesLeftToday(settings.dailyCap, await releasePolicyStore.releasedToday(db));
    if (left === 0) return { kind: 'swept', considered: 0, released, held, capReached: true };
    const candidates = await releasePolicyStore.heldSummaries(db, {
      checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
      onlyReady: true,
      limit: RELEASE_POLICY_SWEEP_LIMIT,
    });
    let considered = 0;
    let capReached = false;
    for (const candidate of candidates) {
      considered += 1;
      const facts = await factsOf(db, candidate);
      const decision = decideAutoRelease(facts);
      if (decision.kind === 'hold') {
        bump(held, decision.reason);
        continue;
      }
      const result = await gate.release({
        assetId: candidate.assetId,
        revision: candidate.revision,
        decidedBy: RELEASE_POLICY.decidedBy,
        guard: guardFor(candidate, settings.dailyCap),
      });
      if (result.kind === 'released' && facts.topicId !== null)
        released.push({ assetId: candidate.assetId, revision: candidate.revision, topicId: facts.topicId });
      else if (result.kind === 'refused') {
        if (result.reason === 'daily_cap_reached') {
          capReached = true;
          break;
        }
        bump(held, result.reason);
      }
    }
    return { kind: 'swept', considered, released, held, capReached };
  }

  /** Approves a catalogue topic for automatic release of its later Scrolls. Refuses a sensitive topic and anything the catalogue does not hold. */
  async function approveTopic(request: {
    readonly topicId: string;
    readonly approvedBy: string;
  }): Promise<ApproveTopicResult> {
    if (!isCatalogueTopic(request.topicId)) return { kind: 'refused', reason: 'unknown_topic' };
    const categories = categoriesOfTopic(request.topicId);
    if (categories.length > 0) return { kind: 'refused', reason: 'sensitive_topic', categories };
    const kind = await releasePolicyStore.approveTopic(db, request.topicId, request.approvedBy);
    return { kind, topicId: request.topicId };
  }

  /**
   * Takes a topic's approval back. Scrolls already released stay served (`withdraw` takes one down); no later Scroll of the topic is
   * released by the policy. Works for a topic that has left the catalogue too, so a stale approval can always be revoked.
   */
  async function revokeTopic(request: {
    readonly topicId: string;
    readonly revokedBy: string;
  }): Promise<RevokeTopicResult> {
    const kind = await releasePolicyStore.revokeTopic(db, request.topicId, request.revokedBy, 'operator');
    return kind === 'never_approved'
      ? { kind: 'refused', reason: 'never_approved' }
      : { kind, topicId: request.topicId };
  }

  /**
   * Withdraws a Scroll the policy released and revokes its topic's approval, in one transaction under the asset's lock. The withdrawal is the
   * existing one: the asset's status becomes `withdrawn`, which every read already treats as not served (and which advances its availability
   * counter). It takes the whole asset down, as a withdrawal always has; only a new asset is ever released by the policy, so no earlier revision
   * is lost. A person's own release is left alone, and repeating the command changes nothing.
   */
  function withdraw(request: {
    readonly assetId: string;
    readonly revision: number;
    readonly withdrawnBy: string;
  }): Promise<WithdrawResult> {
    return withTransaction(db, 'content.release-withdraw', async (trx): Promise<WithdrawResult> => {
      const asset = await lockAssetForReview(trx, request.assetId);
      const { rows } = await sql<{ state: string; decided_by: string | null }>`select state, decided_by
        from content.revision_reviews
        where asset_id = ${request.assetId}::uuid and revision = ${request.revision}::integer for update`.execute(trx);
      const review = rows[0];
      if (asset === undefined || asset.kind !== 'scroll' || review === undefined)
        return { kind: 'refused', reason: 'not_found' };
      if (review.state !== 'released' || !(review.decided_by ?? '').startsWith(POLICY_DECIDER_PREFIX))
        return { kind: 'refused', reason: 'not_auto_released' };
      if (asset.status !== 'withdrawn' && !(asset.status === 'admitted' && asset.revision === request.revision))
        return { kind: 'refused', reason: 'not_the_served_revision' };
      if (asset.status !== 'withdrawn')
        await trx
          .updateTable('content.assets')
          .set({ status: 'withdrawn' })
          .where('id', '=', request.assetId)
          .execute();
      const topics = await releasePolicyStore.primaryTopics(trx, request.assetId, request.revision);
      const topicId = topics.length === 1 ? (topics[0] ?? null) : null;
      const approval =
        topicId === null
          ? 'no_topic'
          : await releasePolicyStore.revokeTopic(trx, topicId, request.withdrawnBy, 'withdrawal');
      return {
        kind: asset.status === 'withdrawn' ? 'already_withdrawn' : 'withdrawn',
        assetId: request.assetId,
        revision: request.revision,
        topicId,
        approval,
      };
    });
  }

  /**
   * Records a raise against a revision: the revision touches a sensitive category, so it waits for a person. The only way a model's opinion
   * reaches the policy, and it can only add: a raise is never changed or removed. `proposedBy` is `model:<role>` or `cli:<name>`.
   */
  function proposeRaise(request: {
    readonly assetId: string;
    readonly revision: number;
    readonly category: SensitiveCategory;
    readonly proposedBy: string;
  }): Promise<RaiseResult> {
    return releasePolicyStore.recordRaise(db, request);
  }

  /** Counts for the operator, and why each held Scroll is held. Reads every held revision's body once; run by hand. */
  async function status(settings: ReleasePolicySettings): Promise<PolicyStatus> {
    const counts = await releasePolicyStore.counts(db);
    const summaries = await releasePolicyStore.heldSummaries(db, {
      checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
      onlyReady: false,
      limit: RELEASE_POLICY_STATUS_LIMIT,
    });
    const byReason: Record<string, number> = {};
    let wouldRelease = 0;
    for (const summary of summaries) {
      const decision = decideAutoRelease(await factsOf(db, summary));
      if (decision.kind === 'release') wouldRelease += 1;
      else bump(byReason, decision.reason);
    }
    return {
      policy: RELEASE_POLICY.id,
      sensitivity: SENSITIVITY_VERSION,
      autoRelease: settings,
      counts,
      held: { evaluated: summaries.length, wouldRelease, byReason },
    };
  }

  return { sweep, approveTopic, revokeTopic, withdraw, proposeRaise, status };
}

export type ReleasePolicy = ReturnType<typeof makeReleasePolicy>;
