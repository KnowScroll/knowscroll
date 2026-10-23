import type { ProductionAttemptAccounting } from '../../../reasoning/public.js';

/** Code-only operator outcomes; no prompts, research, drafts or internal provenance. */
export interface RoleReceipt {
  readonly role: 'writer' | 'checks';
  readonly kind: string;
  readonly attemptId?: string;
  readonly attempts?: readonly ProductionAttemptAccounting[];
  readonly code?: string;
  readonly repaired?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
export interface ProduceScrollResult {
  /**
   * `paused`: nothing was sent because a daily budget or the provider's quota is used up. The job
   * stays open and a later run resumes it; it is not a verdict on the recipe.
   */
  readonly outcome: 'dry_run' | 'published' | 'rejected' | 'unknown' | 'in_progress' | 'scope_refused' | 'paused';
  readonly requestBound: number;
  readonly runId?: string;
  readonly assetId?: string;
  readonly revision?: number;
  readonly codes?: readonly string[];
  readonly attempts?: readonly RoleReceipt[];
}
