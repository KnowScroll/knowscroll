import type { ProductionAttemptAccounting } from '../../../reasoning/public.js';
import type { CallVerdict } from '../domain/answer-check.js';
import type { UnsupportedKind } from '../domain/ask-support.js';

/**
 * Code-only operator outcomes; no prompts, research, drafts or internal provenance. The checker's
 * verdicts are the one exception that holds model-written words: a short problem for each flagged call,
 * kept on the private job for the operator who reads the Scroll (D-198).
 */
export interface RoleReceipt {
  /** `answer_check`: what the answer check said about one draft (D-198). `support_check`: what the support check of an ask order's answer said (D-250). */
  readonly role: 'writer' | 'checks' | 'answer_check' | 'support_check';
  readonly kind: string;
  /** For the receipt of a superseded draft: the writer run that wrote it, which the job no longer names. */
  readonly runId?: string;
  /** For an `answer_check` receipt: which draft of the writer it checked (1, or 2 after a check repair). */
  readonly draft?: 1 | 2;
  readonly verdicts?: readonly CallVerdict[];
  /** For a `support_check` receipt: how many sentences were checked and which were found unsupported. Numbers and kinds only, never the sentences (D-231). */
  readonly sentences?: number;
  readonly unsupported?: readonly { readonly number: number; readonly kind: UnsupportedKind }[];
  readonly attemptId?: string;
  readonly attempts?: readonly ProductionAttemptAccounting[];
  readonly code?: string;
  readonly repaired?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
/** A reasoning run a production job used and closes when the job ends (a run left open would never settle). */
export interface ClosingRun {
  readonly runId: string;
  readonly state: 'completed' | 'failed';
}

export interface ProduceScrollResult {
  /**
   * `paused`: nothing was sent because a daily budget or the provider's quota is used up. The job
   * stays open and a later run resumes it; it is not a verdict on the recipe.
   */
  readonly outcome:
    | 'dry_run'
    | 'published'
    | 'rejected'
    | 'unknown'
    | 'in_progress'
    | 'scope_refused'
    /** The key is neither a library recipe nor a stored order; nothing was started. */
    | 'unknown_recipe'
    /** The plan does not allow the recipe to be produced (`codes` says why); no job was reserved and nothing was sent. */
    | 'plan_refused'
    | 'paused'
    /** A take above 1 was asked for before every earlier take was rejected; nothing was started. */
    | 'take_refused'
    /** A transient failure fetching public research: the job stays at its research stage and no take was spent. */
    | 'retry_later';
  readonly requestBound: number;
  readonly runId?: string;
  readonly take?: number;
  readonly assetId?: string;
  readonly revision?: number;
  /**
   * Present on the delivery that stored the Scroll: it was stored held for operator review and is
   * not served until `content release` (D-138). A later read of the finished job does not carry it;
   * `content production-status` is the authority on whether the Scroll is held.
   */
  readonly held?: true;
  readonly codes?: readonly string[];
  readonly attempts?: readonly RoleReceipt[];
}
