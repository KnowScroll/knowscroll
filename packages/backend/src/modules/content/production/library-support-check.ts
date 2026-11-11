import type { Kysely } from 'kysely';
import { parseDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { LIBRARY_SUPPORT_POLICY, countsOf, decideRevision, type SupportPolicy } from '../domain/library-support.js';
import {
  LIBRARY_SUPPORT_BATCH_SENTENCES,
  LIBRARY_SUPPORT_CHECK_VERSION,
  LIBRARY_SUPPORT_MAX_BATCHES,
  LIBRARY_SUPPORT_REQUEST_BOUND,
  libraryEvidenceOf,
  sentencesOfScroll,
} from './library-support.js';
import {
  FINAL_PROVIDER_CODE,
  LIBRARY_SUPPORT_MAX_ROUNDS,
  RETRYABLE_CODE,
  libraryCheckStore,
  type StoredLibraryCheck,
} from './library-support-store.js';
import { makeLibrarySupportStep } from './library-support-step.js';
import type { ClosingRun } from './types.js';

export interface CheckLibrarySupportDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  /** The policy that turns sentence results into the revision's verdict; the library's first policy by default. */
  readonly policy?: SupportPolicy;
}

export interface CheckLibrarySupportInput {
  readonly assetId: string;
  readonly revision: number;
  readonly signal: AbortSignal;
  /**
   * The most paid requests this call may send. A check needs its batches and may need one more when the harness repairs an
   * unusable reply; when that would pass the cap, nothing is sent (`over_cap`). Without it the check is bounded only by
   * `LIBRARY_SUPPORT_REQUEST_BOUND`.
   */
  readonly requestCap?: number;
}

/** What one run of the check came to. */
export type CheckLibrarySupportResult =
  /**
   * Nothing was asked and nothing was written: the revision is not stored, did not go through the review gate (a made-to-order revision never
   * does, and must never be stored in the shared table) or is not a v2 Scroll.
   */
  | { readonly kind: 'not_found'; readonly reason: 'revision_missing' | 'not_under_review' | 'not_a_v2_scroll' }
  /** A result of this checker version was already stored, so nothing was asked. */
  | { readonly kind: 'reused'; readonly check: StoredLibraryCheck }
  /** This run stored a result: checked, or unchecked with a code. `requests` are the paid requests this run added (the stored result holds the total over every round). */
  | { readonly kind: 'stored'; readonly check: StoredLibraryCheck; readonly requests: number }
  /** A daily budget or the provider's quota is used up: nothing more was sent, nothing was stored and a later run resumes the check. */
  | { readonly kind: 'paused'; readonly code: string }
  /** The check would pass `requestCap`: nothing was sent. */
  | { readonly kind: 'over_cap'; readonly needed: number }
  /** The production root is disabled or its generation changed: nothing was stored. */
  | { readonly kind: 'scope_refused' };

/**
 * Whether a check that ended on a conclusive provider failure is tried again: while rounds are left (at most three) and while every request
 * the revision could still need fits its bound of `LIBRARY_SUPPORT_REQUEST_BOUND` in all. `requests` is the total paid so far, over every round;
 * the batch that failed and those after it have still to be asked, and the harness may yet repair one reply, so one more is kept back.
 */
export function mayTryAgain(facts: {
  readonly round: number;
  readonly requests: number;
  readonly batches: number;
  readonly failedBatch: number;
}): boolean {
  return (
    facts.round < LIBRARY_SUPPORT_MAX_ROUNDS &&
    facts.requests + (facts.batches - facts.failedBatch) + 1 <= LIBRARY_SUPPORT_REQUEST_BOUND
  );
}

/** Whether a stored result ends the check of its revision: a conclusive provider failure with rounds left is tried again. */
const isFinal = (check: StoredLibraryCheck): boolean =>
  !(check.state === 'unchecked' && check.code === RETRYABLE_CODE && check.round < LIBRARY_SUPPORT_MAX_ROUNDS);

/**
 * The support check of one stored library Scroll revision (D-415): reads the revision and its private provenance, lists the sentences a
 * reader sees with the passages each rests on, asks the checker a batch at a time through the production harness, and stores what became
 * of every sentence with the revision's verdict, which code decides from them under a policy. The same use case runs for the worker's job
 * and for the operator's replay.
 *
 * It releases, rejects and serves nothing and reads nothing a person made: shared content only, under the production root.
 *
 * Reliability. Every request is an attempt in the ledger, so a redelivery of the same job asks the ledger for answers it already holds and
 * pays for nothing twice; an attempt of unknown outcome is never resent (the check ends `unchecked`, `outcome_unknown`, and its run stays open
 * for an operator to reconcile). No model call or network wait is inside a transaction: the result and the closing of the runs it used
 * are one short transaction at the end. A spent budget or quota stores nothing, so the next sweep asks again.
 */
export function makeCheckLibrarySupport(deps: CheckLibrarySupportDependencies) {
  const step = makeLibrarySupportStep(deps);
  const policy = deps.policy ?? LIBRARY_SUPPORT_POLICY;

  /** Stores a result and closes the runs it used in one transaction; `kept` means another delivery already stored one. */
  async function store(
    check: Omit<StoredLibraryCheck, 'checkedAt'>,
    runs: readonly ClosingRun[],
  ): Promise<'written' | 'kept' | 'scope_refused'> {
    const stored = await deps.withScope(deps.authority, async (scope) => {
      for (const run of runs) await deps.harness.closeProductionRun(scope, run);
      return libraryCheckStore.write(productionTransactionOf(scope), check);
    });
    return stored.kind === 'entered' ? stored.value : 'scope_refused';
  }

  async function check(input: CheckLibrarySupportInput): Promise<CheckLibrarySupportResult> {
    const { assetId, revision } = input;
    const subject = await libraryCheckStore.readSubject(deps.db, assetId, revision);
    if (subject === undefined) return { kind: 'not_found', reason: 'revision_missing' };
    // Only a Scroll that went through the review gate is checked: a made-to-order revision has no row there and is never stored here.
    if (subject.review === null) return { kind: 'not_found', reason: 'not_under_review' };
    const parsed = parseDocumentV2(subject.document);
    if (parsed.kind !== 'valid') return { kind: 'not_found', reason: 'not_a_v2_scroll' };
    const earlier = await libraryCheckStore.read(deps.db, assetId, revision, LIBRARY_SUPPORT_CHECK_VERSION);
    if (earlier !== undefined && isFinal(earlier)) return { kind: 'reused', check: earlier };
    const round = earlier === undefined ? 1 : earlier.round + 1;
    // A later round asks only the batch that failed and those after it: the batches before it are read back from the ledger.
    const failures = earlier?.batchFailures ?? {};
    const resumeFrom = Math.max(0, ...Object.keys(failures).map(Number));
    const requestsBefore = earlier?.requests ?? 0;

    const base = {
      assetId,
      revision,
      checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
      policyVersion: policy.id,
      round,
      batchFailures: failures,
    } as const;
    const nothing = (code: string, sentenceCount = 0, batches = 0) =>
      ({
        ...base,
        state: 'unchecked',
        code,
        verdict: 'unchecked',
        sentenceCount,
        batches,
        requests: requestsBefore,
        sentences: [],
      }) as const;
    /** A check no model could help with is final at once: it is stored with its reason and nothing is sent. */
    const refused = async (code: string): Promise<CheckLibrarySupportResult> => {
      const written = await store(nothing(code), []);
      if (written === 'scope_refused') return { kind: 'scope_refused' };
      const stored = await libraryCheckStore.read(deps.db, assetId, revision, LIBRARY_SUPPORT_CHECK_VERSION);
      return stored === undefined ? { kind: 'scope_refused' } : { kind: 'reused', check: stored };
    };

    const provenance = ScrollProvenanceV2.safeParse(subject.provenance);
    if (!provenance.success) return refused('provenance_unreadable');
    const evidence = libraryEvidenceOf(provenance.data);
    const listed = sentencesOfScroll(parsed.document, evidence);
    if (listed.kind === 'refused') return refused(listed.code);
    const { sentences } = listed;

    const batches = Math.ceil(sentences.length / LIBRARY_SUPPORT_BATCH_SENTENCES);
    const needed = batches - resumeFrom + 1;
    if (input.requestCap !== undefined && batches <= LIBRARY_SUPPORT_MAX_BATCHES && needed > input.requestCap)
      return { kind: 'over_cap', needed };

    const outcome = await step.check({
      assetId,
      revision,
      failures,
      sentences,
      passages: evidence.passages,
      signal: input.signal,
    });
    if (outcome.kind === 'paused') return outcome;
    if (outcome.kind === 'advanced') {
      // Another delivery closed a run of this check: it stored the result, or is about to.
      const stored = await libraryCheckStore.read(deps.db, assetId, revision, LIBRARY_SUPPORT_CHECK_VERSION);
      return stored === undefined ? { kind: 'paused', code: 'run_closed' } : { kind: 'reused', check: stored };
    }
    // The batches before `resumeFrom` were answered in an earlier round: the ledger gave them back for nothing, and their requests are in `requestsBefore`.
    const addedRequests = outcome.attemptCounts.reduce(
      (total, count, batch) => (batch < resumeFrom ? total : total + count),
      0,
    );
    const requests = requestsBefore + addedRequests;

    let result: Omit<StoredLibraryCheck, 'checkedAt'>;
    let closing: readonly ClosingRun[] = outcome.runs;
    if (outcome.kind === 'checked') {
      result = {
        ...base,
        state: 'checked',
        code: null,
        verdict: decideRevision(countsOf(outcome.results), policy),
        sentenceCount: outcome.results.length,
        batches: outcome.batches,
        requests,
        sentences: outcome.results,
      };
    } else if (outcome.code === RETRYABLE_CODE && outcome.failedBatch !== undefined) {
      // A conclusive provider failure: tried again in a later round while the rounds and the revision's bound of requests allow it. The batches
      // answered stay open to be read back; only the failed run is ended, since a failed run is ended for good.
      const failed = outcome.failedBatch;
      const nextFailures = { ...failures, [String(failed)]: (failures[String(failed)] ?? 0) + 1 };
      const again = mayTryAgain({ round, requests, batches: outcome.batches, failedBatch: failed });
      result = {
        ...nothing(again ? RETRYABLE_CODE : FINAL_PROVIDER_CODE, sentences.length, outcome.batches),
        batchFailures: nextFailures,
        requests,
      };
      if (again) closing = outcome.runs.filter((run) => run.state === 'failed');
    } else {
      result = { ...nothing(outcome.code, sentences.length, outcome.batches), requests };
    }
    const written = await store(result, closing);
    if (written === 'scope_refused') return { kind: 'scope_refused' };
    const stored = await libraryCheckStore.read(deps.db, assetId, revision, LIBRARY_SUPPORT_CHECK_VERSION);
    if (stored === undefined) return { kind: 'scope_refused' };
    return written === 'written'
      ? { kind: 'stored', check: stored, requests: addedRequests }
      : { kind: 'reused', check: stored };
  }

  return check;
}
export type CheckLibrarySupport = ReturnType<typeof makeCheckLibrarySupport>;
