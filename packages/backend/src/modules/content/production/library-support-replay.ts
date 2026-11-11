import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { RECIPES } from '../domain/library/index.js';
import {
  LIBRARY_SUPPORT_POLICY,
  agreementOf,
  countsOf,
  decideRevision,
  type AgreementSummary,
  type CheckVerdict,
  type DecidedCheck,
  type HumanDecision,
  type SupportPolicy,
} from '../domain/library-support.js';
import { recipeKeyOfAsset } from '../adapters/review-gate.js';
import type { CheckLibrarySupport } from './library-support-check.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from './library-support.js';
import { libraryCheckStore, type StoredLibraryCheck } from './library-support-store.js';
import { SPIKE_MODEL } from './spike-v2/run.js';

/** The most decided revisions one replay reads. */
export const LIBRARY_SUPPORT_REPLAY_MAX_REVISIONS = 500;

/** The most paid requests one replay may be allowed to send. A check of a revision sends about six. */
export const LIBRARY_SUPPORT_REPLAY_MAX_REQUESTS = 1_000;

export type ReplayOutcome =
  /** The check ran now and stored a result. */
  | 'checked'
  /** A result of this checker version was already stored, so no request was sent for it. */
  | 'reused'
  /** The check ran now (or earlier) and gave nothing usable: `code` says why. */
  | 'unchecked'
  /** A daily budget or the provider's quota is used up: nothing was sent for it and the replay stops. */
  | 'paused'
  /** The revision's checks would pass `--max-requests`: nothing was sent for it. */
  | 'over_cap'
  /** The revision is no stored v2 Scroll. */
  | 'not_replayable';

/** What the operator prints for one decided revision: counts and codes, never a sentence, a title or a reason. */
export interface ReplayLine {
  readonly assetId: string;
  readonly revision: number;
  /** The library recipe the asset belongs to, or `null` for an asset the plan does not name. */
  readonly recipe: string | null;
  readonly family: string;
  readonly decision: HumanDecision;
  readonly outcome: ReplayOutcome;
  /** The verdict under the current policy, or `null` when no result is stored. */
  readonly verdict: CheckVerdict | null;
  readonly sentences: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly unclear: number;
  readonly noClaim: number;
  readonly batches: number;
  /** Paid requests this replay sent for the revision (none for a reused result). */
  readonly requests: number;
  /** For each rule that set a verdict aside, how many sentences are `unclear` because of it. */
  readonly codes: Readonly<Record<string, number>>;
  /** For each kind of finding, how many sentences the checker found unsupported. */
  readonly kinds: Readonly<Record<string, number>>;
  readonly code?: string;
}

export type ReplayStop = 'paused' | 'outcome_unknown' | 'scope_refused' | 'aborted' | 'model_mismatch';

export interface ReplaySummary {
  readonly checkerVersion: string;
  readonly revisions: number;
  readonly requestsSent: number;
  readonly maxRequests: number;
  /** Why the replay did not look at every revision it read, or `null` when it did. */
  readonly stopped: ReplayStop | null;
  /** How the stored results of this checker version agree with the operator's decisions, whoever's replay stored them. */
  readonly agreement: AgreementSummary;
}

export interface ReplayTarget {
  /** Only decisions made at or after this. */
  readonly since: Date | undefined;
  /** The newest this many decided revisions. */
  readonly limit: number;
  /** The most paid requests this replay may send. Zero reads what is stored and sends nothing. */
  readonly maxRequests: number;
}

export interface LibrarySupportReplayDependencies {
  readonly db: Kysely<Database>;
  readonly check: CheckLibrarySupport;
  /** The model the harness is configured with; the replay refuses to run on any other (D-031). */
  readonly model: string;
  readonly policy?: SupportPolicy;
}

const familyOf = (assetId: string): { readonly recipe: string | null; readonly family: string } => {
  const recipe = recipeKeyOfAsset(assetId);
  return { recipe, family: recipe === null ? 'other' : RECIPES[recipe].systemId };
};

const tally = (keys: readonly (string | undefined)[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of keys) if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

/** The line of a revision from its stored result (or none). */
function lineOf(
  decided: { readonly assetId: string; readonly revision: number; readonly decision: HumanDecision },
  outcome: ReplayOutcome,
  stored: StoredLibraryCheck | undefined,
  requests: number,
  policy: SupportPolicy,
  code?: string,
): ReplayLine {
  const counts = stored?.state === 'checked' ? countsOf(stored.sentences) : undefined;
  const reason = code ?? stored?.code ?? undefined;
  return {
    assetId: decided.assetId,
    revision: decided.revision,
    ...familyOf(decided.assetId),
    decision: decided.decision,
    outcome,
    verdict: counts === undefined ? (stored === undefined ? null : 'unchecked') : decideRevision(counts, policy),
    sentences: counts?.sentences ?? stored?.sentenceCount ?? 0,
    supported: counts?.supported ?? 0,
    unsupported: counts?.unsupported ?? 0,
    unclear: counts?.unclear ?? 0,
    noClaim: counts?.noClaim ?? 0,
    batches: stored?.batches ?? 0,
    requests,
    codes: tally(
      (stored?.sentences ?? []).map((sentence) => (sentence.outcome === 'unclear' ? sentence.code : undefined)),
    ),
    kinds: tally(
      (stored?.sentences ?? []).map((sentence) => (sentence.outcome === 'unsupported' ? sentence.kind : undefined)),
    ),
    ...(reason === undefined ? {} : { code: reason }),
  };
}

/**
 * Measures the library support check against the operator's own decisions (D-415). It reads the revisions an operator released or
 * rejected (`content.revision_reviews`), runs the check over each that has no result of the current checker version, and reports how the
 * stored results agree with the decisions: for each decision, how many revisions the check would have passed and flagged, with the
 * rejected ones it would have passed as the dangerous number, by recipe family, and the same results under looser limits.
 *
 * It changes no revision, decision or Scroll: the only rows it writes are the check's own results (`content.library_support_checks`),
 * through the same use case the worker's job runs, so a result is stored once per revision and checker version and running it again sends
 * nothing for a revision already checked. Spend is bounded by `maxRequests` (a revision whose check might pass it is skipped, not
 * started) and by the production harness's budgets; a spent budget or quota, an attempt of unknown outcome or a revoked root stops it. It
 * prints counts and codes only, never a sentence, so its output may be pasted into an issue.
 */
export function makeLibrarySupportReplay(deps: LibrarySupportReplayDependencies) {
  const policy = deps.policy ?? LIBRARY_SUPPORT_POLICY;

  /** The agreement of the stored results of this checker version for these decided revisions. */
  async function agreement(
    decided: readonly { readonly assetId: string; readonly revision: number; readonly decision: HumanDecision }[],
  ): Promise<AgreementSummary> {
    const stored = await libraryCheckStore.readMany(deps.db, LIBRARY_SUPPORT_CHECK_VERSION, decided);
    const rows = decided.map((entry): DecidedCheck => {
      const check = stored.get(`${entry.assetId}:${String(entry.revision)}`);
      const { family } = familyOf(entry.assetId);
      if (check?.state === 'checked') return { decision: entry.decision, family, counts: countsOf(check.sentences) };
      return { decision: entry.decision, family, counts: null, code: check?.code ?? 'not_checked' };
    });
    return agreementOf(rows, policy);
  }

  return async function replay(
    target: ReplayTarget,
    signal: AbortSignal,
    emit: (line: ReplayLine) => Promise<void> | void,
  ): Promise<ReplaySummary> {
    const base = { checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION, maxRequests: target.maxRequests };
    const decided = await libraryCheckStore.decided(deps.db, { since: target.since, limit: target.limit });
    if (deps.model !== SPIKE_MODEL)
      return {
        ...base,
        revisions: decided.length,
        requestsSent: 0,
        stopped: 'model_mismatch',
        agreement: await agreement(decided),
      };
    let requestsSent = 0;
    let stopped: ReplayStop | null = null;
    for (const entry of decided) {
      if (signal.aborted) {
        stopped = 'aborted';
        break;
      }
      const result = await deps.check({
        assetId: entry.assetId,
        revision: entry.revision,
        signal,
        requestCap: target.maxRequests - requestsSent,
      });
      switch (result.kind) {
        case 'not_found':
          await emit(lineOf(entry, 'not_replayable', undefined, 0, policy, result.reason));
          break;
        case 'over_cap':
          await emit(lineOf(entry, 'over_cap', undefined, 0, policy, 'over_request_cap'));
          break;
        case 'reused':
          await emit(lineOf(entry, result.check.state === 'checked' ? 'reused' : 'unchecked', result.check, 0, policy));
          break;
        case 'stored':
          requestsSent += result.requests;
          await emit(
            lineOf(
              entry,
              result.check.state === 'checked' ? 'checked' : 'unchecked',
              result.check,
              result.requests,
              policy,
            ),
          );
          // An attempt of unknown outcome is never resent, and nothing more is asked until an operator has reconciled it.
          if (result.check.code === 'outcome_unknown') stopped = 'outcome_unknown';
          break;
        case 'paused':
          await emit(lineOf(entry, 'paused', undefined, 0, policy, result.code));
          stopped = 'paused';
          break;
        case 'scope_refused':
          stopped = 'scope_refused';
          break;
      }
      if (stopped !== null) break;
    }
    return { ...base, revisions: decided.length, requestsSent, stopped, agreement: await agreement(decided) };
  };
}
