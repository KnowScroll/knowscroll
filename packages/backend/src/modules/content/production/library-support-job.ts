import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { CheckLibrarySupport, CheckLibrarySupportResult } from './library-support-check.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from './library-support.js';
import { checkLibrarySupportJob, type CheckLibrarySupportJob } from './library-support-events.js';
import { libraryCheckStore } from './library-support-store.js';

export type LibrarySupportJobOutcome =
  /** The job is for another checker version than this build's: it is dropped instead of checking under one the sender did not mean. */
  | { readonly kind: 'skipped'; readonly reason: 'checker_version' }
  /** The delivery is done: the check stored a result, found one, is not for a v2 Scroll, or paused on a spent budget (`result.kind`). */
  | { readonly kind: 'finished'; readonly result: CheckLibrarySupportResult };

/**
 * Runs the check of one revision for a queue delivery. The delivery is not the business run (the revision and the checker version are)
 * and not the attempt (the ledger holds it), so a redelivery after a crash or a lost claim reads the stored result or the ledger and
 * never pays twice. A disabled or revoked production root is an error, so the job retries and then dead-letters rather than vanishing. A
 * spent budget or quota completes the delivery: nothing was sent and nothing stored, and the sweep hands the revision over again.
 */
export function makeRunLibrarySupportCheck(check: CheckLibrarySupport) {
  return async function runLibrarySupportCheck(
    job: CheckLibrarySupportJob,
    delivery: { readonly signal: AbortSignal },
  ): Promise<LibrarySupportJobOutcome> {
    if (job.checkerVersion !== LIBRARY_SUPPORT_CHECK_VERSION) return { kind: 'skipped', reason: 'checker_version' };
    const result = await check({ assetId: job.assetId, revision: job.revision, signal: delivery.signal });
    if (result.kind === 'scope_refused') throw new Error('LIBRARY_SUPPORT_SCOPE_REFUSED');
    return { kind: 'finished', result };
  };
}

/** Sends the check of one revision. `already_queued`: a job for that revision and checker version is queued or running. */
export type EnqueueLibrarySupport = (job: CheckLibrarySupportJob) => Promise<'queued' | 'already_queued'>;

/** The most revisions one pass of the sweep hands over. The check queue and the budgets bound what runs; this bounds what one pass reads and sends. */
export const SWEEP_LIBRARY_SUPPORT_LIMIT = 20;

/** How long a check that ended on a provider failure waits before its next round, so a provider that is down is not tried three times in half an hour. */
export const LIBRARY_SUPPORT_RETRY_AFTER_SECONDS = 3600;

export interface SweepLibrarySupportDependencies {
  readonly db: Kysely<Database>;
  readonly enqueue: EnqueueLibrarySupport;
}

/**
 * Hands the held revisions that are due a check to the check queue: every held revision with no result of this checker version, and
 * every one whose last try ended on a provider failure long enough ago with rounds left, oldest hold first. A durable read recovers
 * what a disposable hint missed (the delivery that held a revision, an operator's direct run, a spent budget, a revision held before
 * the check existed), so nothing waits on a lost message. It reads shared tables only and calls no model.
 */
export function makeSweepLibrarySupport(deps: SweepLibrarySupportDependencies) {
  return async function sweepLibrarySupport(): Promise<{ readonly due: number; readonly queued: number }> {
    const due = await libraryCheckStore.dueHeld(deps.db, LIBRARY_SUPPORT_CHECK_VERSION, {
      limit: SWEEP_LIBRARY_SUPPORT_LIMIT,
      retryAfterSeconds: LIBRARY_SUPPORT_RETRY_AFTER_SECONDS,
    });
    let queued = 0;
    for (const entry of due)
      if ((await deps.enqueue(checkLibrarySupportJob(entry.assetId, entry.revision))) === 'queued') queued += 1;
    return { due: due.length, queued };
  };
}
