import {
  projectNextJob,
  type ProjectionResult,
} from '@knowscroll/db/projection/keep';

export type { ProjectionResult };

/** Only short, deterministic database work belongs in this transaction.
 * A paid provider call must use a separate lease/attempt protocol (ADR-0005). */
export async function projectOne(): Promise<ProjectionResult | null> {
  return projectNextJob();
}
